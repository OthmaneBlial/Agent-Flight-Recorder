import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const privateData = args.includes('--private-data');
const requestedWebPort = portFlag('--web-port=');
const requestedApiPort = portFlag('--api-port=');
const allowed = new Set(['--private-data']);

for (const argument of args) {
  if (allowed.has(argument) || argument.startsWith('--web-port=') || argument.startsWith('--api-port=')) continue;
  throw new Error(`Unknown development option: ${argument}`);
}

const { webPort, apiPort } = await selectPorts(requestedWebPort, requestedApiPort);
const scopeLabel = privateData ? 'PRIVATE LOCAL DATA' : 'SYNTHETIC SANDBOX';
const dataLabel = privateData ? '.flight-recorder (native scanning enabled)' : '.flight-recorder-demo (native scanning and hooks locked)';

console.log(`[dev] ${scopeLabel}`);
console.log(`[dev] data: ${dataLabel}`);
console.log(`[dev] console: http://127.0.0.1:${webPort}`);
console.log(`[dev] api: http://127.0.0.1:${apiPort}`);

const executable = (name) => resolve('node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const recorderArgs = ['watch', 'src/server/cli.ts', privateData ? 'serve' : 'demo', ...(privateData ? [] : ['--reset']), '--dev', `--port=${apiPort}`];

const recorder = spawn(executable('tsx'), recorderArgs, { stdio: 'inherit' });
const consoleServer = spawn(executable('vite'), ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
  stdio: 'inherit',
  env: { ...process.env, AFR_DEV_API_PORT: String(apiPort) },
});
const children = [recorder, consoleServer];
let closing = false;

for (const child of children) {
  child.once('error', (error) => shutdown(1, error));
  child.once('exit', (code, signal) => {
    if (closing) return;
    const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    shutdown(code ?? 1, new Error(`Development child exited with ${reason}.`));
  });
}

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));

function shutdown(code, error) {
  if (closing) return;
  closing = true;
  if (error) console.error(`[dev] ${error.message}`);
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exitCode = code;
}

function portFlag(prefix) {
  const value = args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${prefix.slice(0, -1)} must be an integer from 1 to 65535.`);
  return parsed;
}

async function selectPorts(web, api) {
  if (web !== null && api !== null) {
    if (web === api) throw new Error('The web and API ports must be different.');
    await assertFree(web, '--web-port');
    await assertFree(api, '--api-port');
    return { webPort: web, apiPort: api };
  }

  if (web !== null) {
    await assertFree(web, '--web-port');
    const apiCandidate = await findFreePort(web + 1);
    return { webPort: web, apiPort: apiCandidate };
  }

  if (api !== null) {
    await assertFree(api, '--api-port');
    const webCandidate = await findFreePort(Math.max(1, api - 1), new Set([api]));
    return { webPort: webCandidate, apiPort: api };
  }

  for (let candidate = 4173; candidate <= 65_533; candidate += 2) {
    if ((await isFree(candidate)) && (await isFree(candidate + 1))) return { webPort: candidate, apiPort: candidate + 1 };
  }
  throw new Error('No free loopback development port pair was found.');
}

async function assertFree(port, flag) {
  if (!(await isFree(port))) throw new Error(`${flag} ${port} is already in use.`);
}

async function findFreePort(start, excluded = new Set()) {
  for (let port = start; port <= 65_535; port += 1) {
    if (!excluded.has(port) && (await isFree(port))) return port;
  }
  throw new Error(`No free loopback port was found at or above ${start}.`);
}

function isFree(port) {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => resolvePromise(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePromise(true)));
  });
}
