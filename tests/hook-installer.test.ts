import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installProviderHooks, rollbackProviderHooks, uninstallProviderHooks } from '../src/server/hook-installer.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('managed provider hook configuration', () => {
  it('dry-runs, merges, deduplicates, uninstalls, and rolls back Claude hooks', () => {
    const homeRoot = mkdtempSync(join(tmpdir(), 'afr-hook-home-'));
    tempDirectories.push(homeRoot);
    const target = join(homeRoot, '.claude', 'settings.json');
    mkdirSync(join(homeRoot, '.claude'));
    const original = { permissions: { allow: ['Read'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/existing/hook' }] }] } };
    writeFileSync(target, `${JSON.stringify(original, null, 2)}\n`);
    const options = {
      provider: 'claude' as const,
      scope: 'user' as const,
      executable: '/usr/bin/node',
      script: '/opt/agent-flight-recorder/cli.js',
      dataDir: '/var/local/afr',
      homeRoot,
    };

    const preview = installProviderHooks(options);
    expect(preview).toMatchObject({ changed: true, applied: false, events: 31 });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(original);

    const installed = installProviderHooks({ ...options, apply: true });
    expect(installed.applied).toBe(true);
    expect(installed.backup).toBeTruthy();
    const config = JSON.parse(readFileSync(target, 'utf8')) as typeof original;
    expect(config.permissions).toEqual(original.permissions);
    expect(config.hooks.PreToolUse).toHaveLength(2);
    expect(JSON.stringify(config)).toContain('--installation-id=agent-flight-recorder');
    expect(installProviderHooks({ ...options, apply: true }).changed).toBe(false);

    const restored = rollbackProviderHooks({ ...options, backupPath: installed.backup!, apply: true });
    expect(restored.applied).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(original);
    installProviderHooks({ ...options, apply: true });

    const removed = uninstallProviderHooks({ ...options, apply: true });
    expect(removed).toMatchObject({ changed: true, applied: true, events: 1 });
    expect(JSON.stringify(JSON.parse(readFileSync(target, 'utf8')))).not.toContain('--installation-id=agent-flight-recorder');
    expect((JSON.parse(readFileSync(target, 'utf8')) as typeof original).hooks.PreToolUse).toHaveLength(1);
  });

  it('installs Cursor project hooks without replacing existing events', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'afr-hook-project-'));
    tempDirectories.push(projectRoot);
    const target = join(projectRoot, '.cursor', 'hooks.json');
    mkdirSync(join(projectRoot, '.cursor'));
    writeFileSync(target, JSON.stringify({ version: 1, hooks: { stop: [{ command: './existing-stop' }] } }));

    const receipt = installProviderHooks({
      provider: 'cursor',
      scope: 'project',
      executable: '/usr/bin/node',
      script: '/opt/agent-flight-recorder/cli.js',
      dataDir: join(projectRoot, '.flight-recorder'),
      projectRoot,
      apply: true,
    });

    expect(receipt.events).toBe(21);
    const config = JSON.parse(readFileSync(target, 'utf8')) as { hooks: Record<string, unknown[]> };
    expect(config.hooks.stop).toHaveLength(2);
    expect(JSON.stringify(config.hooks.preToolUse)).toContain('failClosed');
  });
});
