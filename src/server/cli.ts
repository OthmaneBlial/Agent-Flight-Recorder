#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Provider } from '../shared/types.js';
import { exportSessionBundle, importSessionBundle } from './bundles.js';
import { seedDemo } from './demo.js';
import { sourceHealth } from './discovery.js';
import { generateHookConfig } from './hook-config.js';
import { installProviderHooks, rollbackProviderHooks, uninstallProviderHooks } from './hook-installer.js';
import { recordHookEvent } from './hooks.js';
import { startServer } from './http.js';
import { loadEvidencePolicy } from './policy.js';
import { scanSources } from './scanner.js';
import { RecorderStore } from './store.js';

const args = process.argv.slice(2);

await main().catch((error) => {
  console.error(`[agent-flight-recorder] ${error instanceof Error ? error.message : String(error)}`);
  if (process.env.AFR_DEBUG === '1' && error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const command = args.find((argument) => !argument.startsWith('-')) ?? 'serve';
  if (args.includes('--help') || args.includes('-h') || command === 'help') {
    printHelp();
    return;
  }
  if (args.includes('--version') || args.includes('-v') || command === 'version') {
    console.log(packageVersion());
    return;
  }

  const dataFlag = flagValue('--data-dir=');
  const defaultDirectory = command === 'demo' ? '.flight-recorder-demo' : '.flight-recorder';
  // Demo mode is a privacy boundary: ambient production-store configuration must
  // never redirect its reset or synthetic writes into the private recorder.
  const configuredDirectory = command === 'demo' ? dataFlag : (dataFlag ?? process.env.AFR_DATA_DIR);
  const dataDir = resolve(configuredDirectory ?? join(process.cwd(), defaultDirectory));
  if (command === 'demo' && args.includes('--reset')) resetDemoDatabase(dataDir);

  const policy = loadEvidencePolicy({
    redactionMode: command === 'demo' ? 'mask' : redactionModeFlag(),
    rawRetentionDays: numberFlag('--raw-retention-days='),
    snapshotRetentionDays: numberFlag('--snapshot-retention-days='),
    snapshotMaxBytes: numberFlag('--snapshot-max-bytes=') ?? undefined,
  });
  const store = new RecorderStore(join(dataDir, 'recorder.db'), policy);
  let keepStoreOpen = false;
  const shutdown = (): void => {
    store.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    if (command === 'scan') {
      const codexLimit = optionalIntegerFlag('--limit=', 0);
      const result = await scanSources(store, { all: args.includes('--all'), codexLimit });
      console.log(JSON.stringify({ result, overview: store.getOverview() }, null, 2));
      return;
    }

    if (command === 'doctor') {
      console.log(
        JSON.stringify(
          {
            recorder: { dataDir, database: store.path, node: process.version, network: 'loopback-only' },
            sources: sourceHealth(),
            capture: store.getCaptureHealth(),
            overview: store.getOverview(),
          },
          null,
          2,
        ),
      );
      return;
    }

    if (command === 'hook') {
      const provider = (flagValue('--provider=') ?? 'compatible') as Provider;
      try {
        if (!['claude', 'cursor', 'compatible'].includes(provider)) throw new Error(`Unsupported hook provider: ${provider}`);
        const input = await readStandardInput();
        const payload = input.trim() ? (JSON.parse(input) as unknown) : {};
        const receipt = recordHookEvent(store, provider, flagValue('--event=') ?? null, payload);
        console.log(JSON.stringify(args.includes('--receipt') ? receipt : {}));
      } catch (error) {
        console.error(`[agent-flight-recorder] Hook capture failed: ${error instanceof Error ? error.message : String(error)}`);
        console.log('{}');
        if (args.includes('--strict')) process.exitCode = 1;
      }
      return;
    }

    if (command === 'config') {
      const provider = flagValue('--provider=');
      if (provider !== 'claude' && provider !== 'cursor') throw new Error('Config generation requires --provider=claude or --provider=cursor');
      console.log(
        JSON.stringify(
          generateHookConfig(provider, process.execPath, resolve(process.argv[1]), dataDir, [
            `--redaction=${store.policy.redactionMode}`,
            `--snapshot-max-bytes=${store.policy.snapshotMaxBytes}`,
          ]),
          null,
          2,
        ),
      );
      return;
    }

    if (command === 'install-hooks' || command === 'uninstall-hooks' || command === 'rollback-hooks') {
      const provider = flagValue('--provider=');
      const scope = flagValue('--scope=') ?? 'user';
      if ((provider !== 'claude' && provider !== 'cursor') || (scope !== 'user' && scope !== 'project')) {
        throw new Error(`${command} requires --provider=claude|cursor and optional --scope=user|project.`);
      }
      const common = {
        provider,
        scope,
        script: resolve(process.argv[1]),
        projectRoot: flagValue('--project-root='),
        apply: args.includes('--apply'),
      } as const;
      const receipt =
        command === 'install-hooks'
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
      return;
    }

    if (command === 'prune') {
      const rawDays = numberFlag('--raw-older-than=') ?? store.policy.rawRetentionDays;
      const snapshotDays = numberFlag('--snapshots-older-than=') ?? store.policy.snapshotRetentionDays;
      if (!rawDays && !snapshotDays)
        throw new Error('Prune requires --raw-older-than=DAYS and/or --snapshots-older-than=DAYS. It is a dry run unless --apply is present.');
      const result = store.applyRetention({ rawBefore: cutoff(rawDays), snapshotsBefore: cutoff(snapshotDays), apply: args.includes('--apply') });
      console.log(JSON.stringify({ result, policy: store.getOverview().evidencePolicy }, null, 2));
      return;
    }

    if (command === 'export') {
      const sessionId = flagValue('--session=');
      const output = flagValue('--out=');
      if (!sessionId || !output) throw new Error('Export requires --session=ID and --out=PATH. Bundles are encrypted unless --unencrypted is explicit.');
      const receipt = exportSessionBundle(store, sessionId, output, {
        passphrase: process.env.AFR_BUNDLE_PASSPHRASE,
        unencrypted: args.includes('--unencrypted'),
        force: args.includes('--force'),
      });
      console.log(JSON.stringify(receipt, null, 2));
      return;
    }

    if (command === 'import') {
      const input = flagValue('--in=');
      if (!input) throw new Error('Import requires --in=PATH. Set AFR_BUNDLE_PASSPHRASE for encrypted bundles.');
      const receipt = importSessionBundle(store, input, { passphrase: process.env.AFR_BUNDLE_PASSPHRASE, merge: args.includes('--merge') });
      console.log(JSON.stringify(receipt, null, 2));
      return;
    }

    if (command === 'serve' || command === 'demo') {
      const dev = args.includes('--dev');
      const port = optionalIntegerFlag('--port=', 1, 65_535) ?? 4174;
      if (command === 'demo') {
        const receipt = seedDemo(store);
        console.log(JSON.stringify({ demo: receipt, dataDir, reset: args.includes('--reset') }, null, 2));
      }
      await startServer(store, {
        port,
        staticDir: resolveStaticDirectory(dev),
        automaticScan: command === 'demo' ? false : !args.includes('--no-scan'),
        evidenceScope: command === 'demo' ? 'sandbox' : 'private',
      });
      keepStoreOpen = true;
      return;
    }

    throw new Error(`Unknown command: ${command}. Run agent-flight-recorder --help for usage.`);
  } finally {
    if (!keepStoreOpen) store.close();
  }
}

function printHelp(): void {
  console.log(`Agent Flight Recorder ${packageVersion()}

Local-first observability and replay for AI coding agents.

Usage:
  agent-flight-recorder <command> [options]

Commands:
  serve             Start the loopback recorder and production console (default)
  demo              Start a scan-locked synthetic sandbox (never reads native evidence)
  scan              Import discovered Codex and OpenCode evidence once
  doctor            Print source, capture, storage, and policy health as JSON
  hook              Record one Claude, Cursor, or compatible stdin event
  config            Generate a provider hook configuration fragment
  install-hooks     Preview or apply a managed provider-hook installation
  uninstall-hooks   Preview or apply removal of recorder-owned hooks
  rollback-hooks    Restore a timestamped provider-hook backup
  prune             Preview or apply raw/snapshot retention
  export            Export one encrypted portable .afr flight bundle
  import            Import a portable .afr flight bundle

Common options:
  --data-dir=PATH               Recorder data directory
  --port=PORT                   Loopback HTTP port (default: 4174)
  --redaction=off|mask|strict   New-evidence redaction policy (default: mask)
  --no-scan                     Disable automatic native-source scanning
  --help, -h                    Show this help
  --version, -v                 Print the version

Examples:
  npm run demo -- --reset
  agent-flight-recorder serve --data-dir=.flight-recorder
  agent-flight-recorder scan --all
  agent-flight-recorder doctor
  agent-flight-recorder install-hooks --provider=claude --scope=user

Destructive or configuration-changing operations remain dry-run-first and require
an explicit --apply, --force, --merge, or demo --reset flag where applicable.`);
}

function resolveStaticDirectory(dev: boolean): string | null {
  if (dev) return null;
  const here = dirname(fileURLToPath(import.meta.url));
  const adjacent = resolve(here, '..', '..', 'dist');
  return existsSync(adjacent) ? adjacent : resolve(process.cwd(), 'dist');
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
  return manifest.version ?? 'unknown';
}

function resetDemoDatabase(dataDir: string): void {
  for (const name of ['recorder.db', 'recorder.db-wal', 'recorder.db-shm']) {
    const path = join(dataDir, name);
    if (existsSync(path)) unlinkSync(path);
  }
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function flagValue(prefix: string): string | undefined {
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function redactionModeFlag(): 'off' | 'mask' | 'strict' | undefined {
  const value = flagValue('--redaction=');
  if (value === undefined) return undefined;
  if (value === 'off' || value === 'mask' || value === 'strict') return value;
  throw new Error('--redaction must be one of: off, mask, strict.');
}

function numberFlag(prefix: string): number | null {
  return optionalIntegerFlag(prefix, 1) ?? null;
}

function optionalIntegerFlag(prefix: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = flagValue(prefix);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${prefix}VALUE must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function requiredFlag(prefix: string): string {
  const value = flagValue(prefix);
  if (!value) throw new Error(`Missing required flag ${prefix}VALUE`);
  return value;
}

function cutoff(days: number | null): string | null {
  return days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
}
