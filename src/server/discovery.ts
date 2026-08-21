import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Provider, SourceHealth } from '../shared/types.js';
import { CLAUDE_HOOK_EVENTS, CURSOR_HOOK_EVENTS } from './hook-config.js';

export interface DiscoveredSource {
  provider: Provider;
  path: string;
  mtimeMs: number;
  size: number;
}

export function discoverCodexSources(limit = Number.MAX_SAFE_INTEGER, includeAll = true): DiscoveredSource[] {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const files: DiscoveredSource[] = [];
  walk(root, (path) => {
    if (!path.endsWith('.jsonl')) return;
    const stat = statSync(path);
    files.push({ provider: 'codex', path, mtimeMs: stat.mtimeMs, size: stat.size });
  });
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return includeAll ? files : files.slice(0, limit);
}

export function discoverOpenCodeSource(): DiscoveredSource | null {
  const path = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(path)) return null;
  const stat = sqliteSourceStat(path);
  return { provider: 'opencode', path, ...stat };
}

export function sqliteSourceStat(path: string): Pick<DiscoveredSource, 'mtimeMs' | 'size'> {
  const candidates = [path, `${path}-wal`];
  let size = 0;
  let mtimeMs = 0;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const stat = statSync(candidate);
    size += stat.size;
    mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
  }
  return { size, mtimeMs };
}

export function sourceHealth(): SourceHealth[] {
  const home = homedir();
  const codex = join(home, '.codex', 'sessions');
  const openCode = join(home, '.local', 'share', 'opencode', 'opencode.db');
  return [
    { provider: 'codex', path: codex, detail: 'Native rollout JSONL sessions', available: existsSync(codex) },
    hookHealth('claude', join(home, '.claude', 'settings.json'), CLAUDE_HOOK_EVENTS, '--provider=claude'),
    hookHealth('cursor', join(home, '.cursor', 'hooks.json'), CURSOR_HOOK_EVENTS, '--provider=cursor'),
    { provider: 'opencode', path: openCode, detail: 'Native OpenCode SQLite store', available: existsSync(openCode) },
  ];
}

function hookHealth(provider: Extract<Provider, 'claude' | 'cursor'>, path: string, expectedEvents: readonly string[], providerFlag: string): SourceHealth {
  if (!existsSync(path)) return { provider, path, detail: `User hook config absent · 0/${expectedEvents.length} events`, available: false };
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks as Record<string, unknown> : {};
    const covered = expectedEvents.filter((event) => JSON.stringify(hooks[event] ?? '').includes(providerFlag)).length;
    return { provider, path, detail: `User hook coverage · ${covered}/${expectedEvents.length} events`, available: covered === expectedEvents.length };
  } catch {
    return { provider, path, detail: 'User hook config is invalid JSON', available: false };
  }
}

function walk(root: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.isFile()) visit(path);
  }
}
