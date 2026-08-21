import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportSessionBundle, importSessionBundle } from '../src/server/bundles.js';
import { recordHookEvent } from '../src/server/hooks.js';
import { RecorderStore } from '../src/server/store.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('portable flight bundles', () => {
  it('authenticates, encrypts, and restores a session with snapshot evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-bundle-'));
    tempDirectories.push(directory);
    const source = new RecorderStore(join(directory, 'source.db'));
    const workspace = join(directory, 'workspace');
    const path = join(workspace, 'flight.ts');
    mkdirSync(workspace);
    writeFileSync(path, 'export const flight = "before";\n');
    const common = { session_id: 'bundle-session', cwd: workspace, tool_name: 'Edit', tool_use_id: 'edit-1', tool_input: { file_path: path } };
    const before = recordHookEvent(source, 'claude', 'PreToolUse', { ...common, timestamp: '2026-08-20T12:00:00.000Z', api_key: 'must-not-leak-in-envelope' });
    writeFileSync(path, 'export const flight = "after";\n');
    recordHookEvent(source, 'claude', 'PostToolUse', { ...common, timestamp: '2026-08-20T12:00:01.000Z', tool_response: { ok: true } });
    const output = join(directory, 'flight.afr');
    const passphrase = 'correct horse battery staple';

    const exported = exportSessionBundle(source, before.sessionId, output, { passphrase });
    expect(exported).toMatchObject({ encrypted: true, events: 2, snapshots: 2 });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const ciphertext = readFileSync(output, 'utf8');
    expect(ciphertext).toContain('afr.bundle.encrypted.v1');
    expect(ciphertext).not.toContain('bundle-session');
    expect(ciphertext).not.toContain('must-not-leak-in-envelope');

    const target = new RecorderStore(join(directory, 'target.db'));
    expect(() => importSessionBundle(target, output, { passphrase: 'incorrect passphrase value' })).toThrow(/decryption failed/);
    const imported = importSessionBundle(target, output, { passphrase });
    expect(imported).toMatchObject({ sessionId: before.sessionId, encrypted: true, events: 2, snapshots: 2 });
    expect(target.getSession(before.sessionId)?.sourcePath).toBe('bundle:flight.afr');
    expect(target.getSession(before.sessionId)?.metrics).toMatchObject({ toolCalls: 1, fileChanges: 1 });
    expect(target.getCallLineage(before.eventId)?.current).toMatchObject({ outcome: 'success', facets: 2 });
    expect(target.getCodeEvolution(before.eventId)?.unifiedDiff).toContain('+export const flight = "after";');
    expect(() => importSessionBundle(target, output, { passphrase })).toThrow(/already exists/);
    source.close();
    target.close();
  });
});
