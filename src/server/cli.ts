#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Provider } from '../shared/types.js';
import { exportSessionBundle, importSessionBundle } from './bundles.js';
import { sourceHealth } from './discovery.js';
import { generateHookConfig } from './hook-config.js';
import { installProviderHooks, rollbackProviderHooks, uninstallProviderHooks } from './hook-installer.js';
import { recordHookEvent } from './hooks.js';
import { startServer } from './http.js';
import { loadEvidencePolicy } from './policy.js';
import { scanSources } from './scanner.js';
import { RecorderStore } from './store.js';

const args = process.argv.slice(2);
const command = args.find((argument) => !argument.startsWith('-')) ?? 'serve';
const dataFlag = args.find((argument) => argument.startsWith('--data-dir='));
const dataDir = resolve(dataFlag?.slice('--data-dir='.length) ?? process.env.AFR_DATA_DIR ?? join(process.cwd(), '.flight-recorder'));
const redactionFlag = flagValue('--redaction=');
const policy = loadEvidencePolicy({
  redactionMode: redactionFlag === 'mask' || redactionFlag === 'strict' || redactionFlag === 'off' ? redactionFlag : undefined,
  rawRetentionDays: numberFlag('--raw-retention-days='),
  snapshotRetentionDays: numberFlag('--snapshot-retention-days='),
  snapshotMaxBytes: numberFlag('--snapshot-max-bytes=') ?? undefined,
});
const store = new RecorderStore(join(dataDir, 'recorder.db'), policy);

const shutdown = (): void => {
  store.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (command === 'scan') {
  const all = args.includes('--all');
  const limitFlag = args.find((argument) => argument.startsWith('--limit='));
  const codexLimit = limitFlag ? Number(limitFlag.split('=')[1]) : undefined;
  const result = await scanSources(store, { all, codexLimit });
  console.log(JSON.stringify({ result, overview: store.getOverview() }, null, 2));
  store.close();
} else if (command === 'doctor') {
  console.log(JSON.stringify({
    recorder: { dataDir, database: store.path, node: process.version, network: 'loopback-only' },
    sources: sourceHealth(),
    capture: store.getCaptureHealth(),
    overview: store.getOverview(),
  }, null, 2));
  store.close();
} else if (command === 'hook') {
  const providerFlag = args.find((argument) => argument.startsWith('--provider='));
  const eventFlag = args.find((argument) => argument.startsWith('--event='));
  const provider = (providerFlag?.slice('--provider='.length) ?? 'compatible') as Provider;
  try {
    if (!['claude', 'cursor', 'compatible'].includes(provider)) throw new Error(`Unsupported hook provider: ${provider}`);
    const input = await readStandardInput();
    const payload = input.trim() ? JSON.parse(input) as unknown : {};
    const receipt = recordHookEvent(store, provider, eventFlag?.slice('--event='.length) ?? null, payload);
    console.log(JSON.stringify(args.includes('--receipt') ? receipt : {}));
  } catch (error) {
    console.error(`[agent-flight-recorder] Hook capture failed: ${error instanceof Error ? error.message : String(error)}`);
    console.log('{}');
    if (args.includes('--strict')) process.exitCode = 1;
  } finally {
    store.close();
  }
} else if (command === 'config') {
  const providerFlag = args.find((argument) => argument.startsWith('--provider='));
  const provider = providerFlag?.slice('--provider='.length);
  if (provider !== 'claude' && provider !== 'cursor') {
    console.error('Config generation requires --provider=claude or --provider=cursor');
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(generateHookConfig(provider, process.execPath, resolve(process.argv[1]), dataDir, [
      `--redaction=${store.policy.redactionMode}`,
      `--snapshot-max-bytes=${store.policy.snapshotMaxBytes}`,
    ]), null, 2));
  }
  store.close();
} else if (command === 'install-hooks' || command === 'uninstall-hooks' || command === 'rollback-hooks') {
  const providerValue = flagValue('--provider=');
  const scopeValue = flagValue('--scope=') ?? 'user';
  if ((providerValue !== 'claude' && providerValue !== 'cursor') || (scopeValue !== 'user' && scopeValue !== 'project')) {
    console.error(`${command} requires --provider=claude|cursor and optional --scope=user|project.`);
    process.exitCode = 1;
  } else {
    try {
      const common = {
        provider: providerValue,
        scope: scopeValue,
        script: resolve(process.argv[1]),
        projectRoot: flagValue('--project-root='),
        apply: args.includes('--apply'),
      } as const;
      const receipt = command === 'install-hooks'
        ? installProviderHooks({
            ...common,
            executable: process.execPath,
            dataDir,
            policyArgs: [`--redaction=${store.policy.redactionMode}`, `--snapshot-max-bytes=${store.policy.snapshotMaxBytes}`],
          })
        : command === 'uninstall-hooks'
          ? uninstallProviderHooks(common)
          : rollbackProviderHooks({ ...common, backupPath: requiredFlag('--backup=') });
      console.log(JSON.stringify(receipt, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
  store.close();
} else if (command === 'prune') {
  const rawDays = numberFlag('--raw-older-than=') ?? store.policy.rawRetentionDays;
  const snapshotDays = numberFlag('--snapshots-older-than=') ?? store.policy.snapshotRetentionDays;
  if (!rawDays && !snapshotDays) {
    console.error('Prune requires --raw-older-than=DAYS and/or --snapshots-older-than=DAYS. It is a dry run unless --apply is present.');
    process.exitCode = 1;
  } else {
    const result = store.applyRetention({ rawBefore: cutoff(rawDays), snapshotsBefore: cutoff(snapshotDays), apply: args.includes('--apply') });
    console.log(JSON.stringify({ result, policy: store.getOverview().evidencePolicy }, null, 2));
  }
  store.close();
} else if (command === 'export') {
  const sessionId = flagValue('--session=');
  const output = flagValue('--out=');
  if (!sessionId || !output) {
    console.error('Export requires --session=ID and --out=PATH. Bundles are encrypted unless --unencrypted is explicit.');
    process.exitCode = 1;
  } else {
    try {
      const receipt = exportSessionBundle(store, sessionId, output, {
        passphrase: process.env.AFR_BUNDLE_PASSPHRASE,
        unencrypted: args.includes('--unencrypted'),
        force: args.includes('--force'),
      });
      console.log(JSON.stringify(receipt, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
  store.close();
} else if (command === 'import') {
  const input = flagValue('--in=');
  if (!input) {
    console.error('Import requires --in=PATH. Set AFR_BUNDLE_PASSPHRASE for encrypted bundles.');
    process.exitCode = 1;
  } else {
    try {
      const receipt = importSessionBundle(store, input, { passphrase: process.env.AFR_BUNDLE_PASSPHRASE, merge: args.includes('--merge') });
      console.log(JSON.stringify(receipt, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
  store.close();
} else if (command === 'serve') {
  const dev = args.includes('--dev');
  const portFlag = args.find((argument) => argument.startsWith('--port='));
  const port = portFlag ? Number(portFlag.split('=')[1]) : 4174;
  const here = dirname(fileURLToPath(import.meta.url));
  const productionDist = resolve(here, '..', '..', 'dist');
  const sourceDist = resolve(process.cwd(), 'dist');
  const staticDir = dev ? null : existsSync(productionDist) ? productionDist : sourceDist;
  await startServer(store, { port, staticDir, automaticScan: !args.includes('--no-scan') });
} else {
  console.error(`Unknown command: ${command}\nUsage: recorder [serve|scan|doctor|hook|config|install-hooks|uninstall-hooks|rollback-hooks|prune|export|import] [--provider=NAME] [--all] [--limit=N] [--port=N] [--data-dir=PATH] [--redaction=off|mask|strict]`);
  store.close();
  process.exitCode = 1;
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function flagValue(prefix: string): string | undefined {
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function numberFlag(prefix: string): number | null {
  const value = flagValue(prefix);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function requiredFlag(prefix: string): string {
  const value = flagValue(prefix);
  if (!value) throw new Error(`Missing required flag ${prefix}VALUE`);
  return value;
}

function cutoff(days: number | null): string | null {
  return days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
}
