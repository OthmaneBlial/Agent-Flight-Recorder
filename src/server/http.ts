import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fork } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventKind, Provider, ScanResult } from '../shared/types.js';
import { sourceHealth } from './discovery.js';
import { recordHookEvent } from './hooks.js';
import { policySummary } from './policy.js';
import { RecorderStore } from './store.js';

interface ServerOptions {
  host?: string;
  port?: number;
  staticDir?: string | null;
  scanIntervalMs?: number;
  automaticScan?: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export async function startServer(store: RecorderStore, options: ServerOptions = {}): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host)) throw new Error(`Refusing non-loopback bind: ${host}. Agent data must stay local.`);
  const port = options.port ?? 4174;
  const staticDir = options.staticDir ? resolve(options.staticDir) : null;
  const clients = new Set<ServerResponse>();
  let scanning = false;
  store.recordHeartbeat('server', `loopback ${host}:${port}`);
  let observedDataVersion = store.dataVersion();

  const broadcast = (event: string, data: unknown): void => {
    const packet = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(packet);
  };

  const scan = async (): Promise<unknown> => {
    if (scanning) return { skipped: true, reason: 'scan already running' };
    scanning = true;
    try {
      const result = await scanInProcess(store);
      if (result.sourcesChanged > 0 || result.eventsImported > 0) broadcast('ingest', { result, overview: store.getOverview() });
      return result;
    } finally {
      scanning = false;
    }
  };

  const server = createServer(async (request, response) => {
    try {
      if (!isTrustedHost(request.headers.host)) {
        setApiHeaders(response);
        return json(response, 403, { error: 'Untrusted Host header' });
      }
      if (isMutation(request.method) && !isTrustedOrigin(request.headers.origin)) {
        setApiHeaders(response);
        return json(response, 403, { error: 'Untrusted Origin header' });
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
      if (url.pathname.startsWith('/api/')) {
        setApiHeaders(response);
        if (request.method === 'GET' && url.pathname === '/api/health') {
          const overview = store.getOverview();
          return json(response, 200, { ok: true, mode: 'loopback-only', sources: sourceHealth(), capture: { ...store.getCaptureHealth(), evidencePolicy: overview.evidencePolicy } });
        }
        if (request.method === 'GET' && url.pathname === '/api/overview') return json(response, 200, store.getOverview());
        if (request.method === 'GET' && url.pathname === '/api/sessions') {
          return json(response, 200, store.getSessions({ provider: url.searchParams.get('provider') ?? undefined, query: url.searchParams.get('q') ?? undefined, limit: numberParam(url.searchParams.get('limit')) ?? 100 }));
        }
        if (request.method === 'GET' && url.pathname === '/api/compare') {
          const left = url.searchParams.get('left');
          const right = url.searchParams.get('right');
          if (!left || !right) return json(response, 400, { error: 'Comparison requires left and right session IDs' });
          const comparison = store.compareSessions(left, right);
          return comparison ? json(response, 200, comparison) : json(response, 404, { error: 'Comparison session not found' });
        }
        if (request.method === 'POST' && url.pathname === '/api/scan') return json(response, 200, await scan());
        const hookMatch = url.pathname.match(/^\/api\/hooks\/([^/]+)\/([^/]+)$/);
        if (request.method === 'POST' && hookMatch) {
          const provider = decodeURIComponent(hookMatch[1]) as Provider;
          if (!['claude', 'cursor', 'compatible'].includes(provider)) return json(response, 400, { error: 'Unsupported hook provider' });
          const payload = await readJsonBody(request);
          const receipt = recordHookEvent(store, provider, decodeURIComponent(hookMatch[2]), payload);
          broadcast('ingest', { hook: receipt, overview: store.getOverview() });
          return json(response, 202, receipt);
        }
        if (request.method === 'GET' && url.pathname === '/api/stream') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          response.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);
          clients.add(response);
          request.on('close', () => clients.delete(response));
          return;
        }
        const evolutionMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/evolution$/);
        if (request.method === 'GET' && evolutionMatch) {
          const evolution = store.getCodeEvolution(decodeURIComponent(evolutionMatch[1]), url.searchParams.get('path'));
          return evolution ? json(response, 200, evolution) : json(response, 404, { error: 'Event not found' });
        }
        const lineageMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/lineage$/);
        if (request.method === 'GET' && lineageMatch) {
          const lineage = store.getCallLineage(decodeURIComponent(lineageMatch[1]));
          return lineage ? json(response, 200, lineage) : json(response, 404, { error: 'Event not found' });
        }
        const permissionMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/permissions$/);
        if (request.method === 'GET' && permissionMatch) {
          const trace = store.getPermissionTrace(decodeURIComponent(permissionMatch[1]));
          return trace ? json(response, 200, trace) : json(response, 404, { error: 'Event not found' });
        }
        const eventMatch = url.pathname.match(/^\/api\/events\/([^/]+)$/);
        if (request.method === 'GET' && eventMatch) {
          const event = store.getEvent(decodeURIComponent(eventMatch[1]));
          return event ? json(response, 200, event) : json(response, 404, { error: 'Event not found' });
        }
        const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
        if (request.method === 'GET' && eventsMatch) {
          const kinds = url.searchParams.get('kinds')?.split(',').filter(Boolean) as EventKind[] | undefined;
          return json(response, 200, store.getEvents(decodeURIComponent(eventsMatch[1]), { kinds, query: url.searchParams.get('q') ?? undefined, limit: numberParam(url.searchParams.get('limit')) ?? 100_000 }));
        }
        const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
        if (request.method === 'GET' && sessionMatch) {
          const session = store.getSession(decodeURIComponent(sessionMatch[1]));
          return session ? json(response, 200, session) : json(response, 404, { error: 'Session not found' });
        }
        return json(response, 404, { error: 'API route not found' });
      }

      if (!staticDir) return json(response, 404, { error: 'Web console runs on the Vite development port.' });
      return serveStatic(url.pathname, staticDir, response);
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  if (options.automaticScan ?? true) {
    const timer = setInterval(() => void scan().catch((error) => broadcast('error', { message: String(error) })), options.scanIntervalMs ?? 2_500);
    timer.unref();
    void scan().catch((error) => broadcast('error', { message: String(error) }));
  }
  const heartbeatTimer = setInterval(() => store.recordHeartbeat('server', `loopback ${host}:${port}`), 10_000);
  heartbeatTimer.unref();
  const deliveryTimer = setInterval(() => {
    const next = store.dataVersion();
    if (next === observedDataVersion) return;
    observedDataVersion = next;
    if (!scanning) broadcast('ingest', { source: 'external-recorder-process', observedAt: new Date().toISOString() });
  }, 500);
  deliveryTimer.unref();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise());
  });
  console.log(`Agent Flight Recorder listening at http://${host}:${port}`);
}

function scanInProcess(store: RecorderStore): Promise<ScanResult> {
  const processUrl = new URL(import.meta.url.endsWith('.ts') ? './scan-process.ts' : './scan-process.js', import.meta.url);
  return new Promise((resolvePromise, reject) => {
    const child = fork(fileURLToPath(processUrl), [], {
      execArgv: process.execArgv,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    child.once('message', (message: { ok: boolean; result?: ScanResult; error?: string }) => {
      settled = true;
      if (message.ok && message.result) resolvePromise(message.result);
      else reject(new Error(message.error ?? 'Scan worker failed'));
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!settled) reject(new Error(`Scan process exited before returning a result (code ${code ?? 'unknown'})`));
    });
    child.send({ databasePath: store.path, policy: policySummary(store.policy) });
  });
}

function serveStatic(pathname: string, root: string, response: ServerResponse): void {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let path = join(root, relative || 'index.html');
  if (!resolve(path).startsWith(root)) return json(response, 403, { error: 'Forbidden' });
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(root, 'index.html');
  if (!existsSync(path)) return json(response, 404, { error: 'Console build not found' });
  response.writeHead(200, {
    'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
    'Cache-Control': path.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  createReadStream(path).pipe(response);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function setApiHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}

function numberParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function isTrustedHost(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return isLoopback(normalizeHostname(new URL(`http://${value}`).hostname));
  } catch {
    return false;
  }
}

export function isTrustedOrigin(value: string | undefined): boolean {
  if (!value) return true;
  try {
    const origin = new URL(value);
    return origin.protocol === 'http:' && isLoopback(normalizeHostname(origin.hostname));
  } catch {
    return false;
  }
}

function isMutation(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function normalizeHostname(value: string): string {
  return value.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

async function readJsonBody(request: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error(`Hook payload exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString('utf8').trim();
  if (!body) return {};
  return JSON.parse(body) as unknown;
}
