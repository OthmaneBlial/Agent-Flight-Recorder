import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Provider } from '../shared/types.js';
import { generateHookConfig } from './hook-config.js';

const INSTALLATION_MARKER = '--installation-id=agent-flight-recorder';
type HookProvider = Extract<Provider, 'claude' | 'cursor'>;
type JsonRecord = Record<string, unknown>;

export interface HookInstallOptions {
  provider: HookProvider;
  scope: 'user' | 'project';
  executable: string;
  script: string;
  dataDir: string;
  policyArgs?: string[];
  projectRoot?: string;
  homeRoot?: string;
  apply?: boolean;
}

export interface HookMutationReceipt {
  action: 'install' | 'uninstall' | 'rollback';
  provider: HookProvider;
  scope: 'user' | 'project';
  target: string;
  changed: boolean;
  applied: boolean;
  backup: string | null;
  events: number;
}

export function installProviderHooks(options: HookInstallOptions): HookMutationReceipt {
  const target = hookConfigPath(options);
  const existing = readConfig(target);
  const generated = generateHookConfig(options.provider, resolve(options.executable), resolve(options.script), resolve(options.dataDir), [...(options.policyArgs ?? []), INSTALLATION_MARKER]);
  const next = mergeConfig(options.provider, existing, object(generated));
  return persistMutation('install', options, target, existing, next);
}

export function uninstallProviderHooks(options: Omit<HookInstallOptions, 'executable' | 'dataDir'> & { executable?: string; dataDir?: string }): HookMutationReceipt {
  const target = hookConfigPath(options);
  const existing = readConfig(target);
  const next = removeRecorderHooks(options.provider, existing);
  return persistMutation('uninstall', options, target, existing, next);
}

export function rollbackProviderHooks(options: Omit<HookInstallOptions, 'executable' | 'dataDir'> & { backupPath: string; executable?: string; dataDir?: string }): HookMutationReceipt {
  const target = hookConfigPath(options);
  const existing = readConfig(target);
  const backupPath = resolve(options.backupPath);
  if (!existsSync(backupPath)) throw new Error(`Hook backup not found: ${backupPath}`);
  const restored = parseConfig(readFileSync(backupPath, 'utf8'), backupPath);
  return persistMutation('rollback', options, target, existing, restored);
}

export function hookConfigPath(options: Pick<HookInstallOptions, 'provider' | 'scope' | 'projectRoot' | 'homeRoot'>): string {
  const root = options.scope === 'user' ? resolve(options.homeRoot ?? homedir()) : resolve(options.projectRoot ?? process.cwd());
  if (options.provider === 'claude') return options.scope === 'user' ? join(root, '.claude', 'settings.json') : join(root, '.claude', 'settings.local.json');
  return join(root, '.cursor', 'hooks.json');
}

function mergeConfig(provider: HookProvider, existing: JsonRecord, generated: JsonRecord): JsonRecord {
  const next = structuredClone(existing);
  const hooks = object(next.hooks);
  const generatedHooks = object(generated.hooks);
  for (const [event, generatedEntries] of Object.entries(generatedHooks)) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    if (!current.some(containsMarker)) hooks[event] = [...current, ...(Array.isArray(generatedEntries) ? generatedEntries : [])];
  }
  next.hooks = hooks;
  if (provider === 'cursor' && next.version === undefined) next.version = 1;
  return next;
}

function removeRecorderHooks(provider: HookProvider, existing: JsonRecord): JsonRecord {
  const next = structuredClone(existing);
  const hooks = object(next.hooks);
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    if (provider === 'cursor') {
      const retained = entries.filter((entry) => !containsMarker(entry));
      if (retained.length) hooks[event] = retained;
      else delete hooks[event];
      continue;
    }
    const retained = entries.flatMap((entry) => {
      const group = object(entry);
      if (!Array.isArray(group.hooks)) return containsMarker(entry) ? [] : [entry];
      const handlers = group.hooks.filter((handler) => !containsMarker(handler));
      return handlers.length ? [{ ...group, hooks: handlers }] : [];
    });
    if (retained.length) hooks[event] = retained;
    else delete hooks[event];
  }
  next.hooks = hooks;
  return next;
}

function persistMutation(action: HookMutationReceipt['action'], options: Pick<HookInstallOptions, 'provider' | 'scope' | 'apply'>, target: string, existing: JsonRecord, next: JsonRecord): HookMutationReceipt {
  const changed = stableJson(existing) !== stableJson(next);
  let backup: string | null = null;
  if (options.apply && changed) {
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      backup = `${target}.afr-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
      writeFileSync(backup, `${JSON.stringify(existing, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: statSync(target).mode & 0o777 || 0o600 });
    }
    atomicWrite(target, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { action, provider: options.provider, scope: options.scope, target, changed, applied: Boolean(options.apply && changed), backup, events: Object.keys(object(next.hooks)).length };
}

function readConfig(path: string): JsonRecord {
  return existsSync(path) ? parseConfig(readFileSync(path, 'utf8'), path) : {};
}

function parseConfig(value: string, path: string): JsonRecord {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be an object');
    return parsed as JsonRecord;
  } catch (error) {
    throw new Error(`Cannot safely modify invalid hook config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

function containsMarker(value: unknown): boolean {
  return JSON.stringify(value).includes(INSTALLATION_MARKER);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
