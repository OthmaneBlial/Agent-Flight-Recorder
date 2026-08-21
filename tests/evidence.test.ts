import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { recordHookEvent } from '../src/server/hooks.js';
import { loadEvidencePolicy } from '../src/server/policy.js';
import { RecorderStore } from '../src/server/store.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('local evidence capture', () => {
  it('reconstructs an exact before/after file diff from synchronous hooks', () => {
    const { directory, store } = createStore();
    const path = join(directory, 'src', 'answer.ts');
    mkdirSync(join(directory, 'src'));
    writeFileSync(path, 'export const answer = 41;\n');
    const common = { session_id: 'edit-session', cwd: directory, tool_name: 'Edit', tool_use_id: 'edit-1' };

    const before = recordHookEvent(store, 'claude', 'PreToolUse', {
      ...common,
      timestamp: '2026-08-20T12:00:00.000Z',
      tool_input: { file_path: path, old_string: '41', new_string: '42' },
    });
    writeFileSync(path, 'export const answer = 42;\n');
    const after = recordHookEvent(store, 'claude', 'PostToolUse', {
      ...common,
      timestamp: '2026-08-20T12:00:01.000Z',
      tool_input: { file_path: path, old_string: '41', new_string: '42' },
      tool_response: { ok: true },
    });

    expect(before.snapshots).toBe(1);
    expect(after.snapshots).toBe(1);
    expect(after.gapEventIds).toEqual([]);
    const evolution = store.getCodeEvolution(before.eventId);
    expect(evolution?.before?.status).toBe('captured');
    expect(evolution?.after?.status).toBe('captured');
    expect(evolution?.before?.hash).not.toBe(evolution?.after?.hash);
    expect(evolution?.changed).toBe(true);
    expect(evolution?.unifiedDiff).toContain('-export const answer = 41;');
    expect(evolution?.unifiedDiff).toContain('+export const answer = 42;');
    expect(store.getOverview()).toMatchObject({ snapshots: 2, captureGaps: 0 });
    expect(store.getCaptureHealth()).toMatchObject({ status: 'healthy', fileEvents: 2, coveredFileEvents: 2, uncoveredFileEvents: 0 });
    store.close();
  });

  it('shares file evidence across Cursor callbacks that do not expose the same call ID', () => {
    const { directory, store } = createStore();
    const path = join(directory, 'linked.ts');
    writeFileSync(path, 'export const linked = false;\n');
    const common = {
      conversation_id: 'cursor-linked-edit',
      generation_id: 'generation-1',
      workspace_roots: [directory],
      cwd: directory,
    };
    const before = recordHookEvent(store, 'cursor', 'preToolUse', {
      ...common,
      timestamp: '2026-08-20T12:00:00.000Z',
      tool_name: 'Write',
      tool_use_id: 'write-1',
      tool_input: { file_path: path, content: 'export const linked = true;\n' },
    });
    writeFileSync(path, 'export const linked = true;\n');
    const after = recordHookEvent(store, 'cursor', 'afterFileEdit', {
      ...common,
      timestamp: '2026-08-20T12:00:01.000Z',
      file_path: path,
      edits: [{ old_string: 'false', new_string: 'true' }],
    });

    expect(store.getCallLineage(after.eventId)?.current).toMatchObject({ eventId: before.eventId, callId: 'write-1', facets: 2, outcome: 'success' });
    expect(store.getCodeEvolution(after.eventId)).toMatchObject({ path, changed: true, gaps: [] });
    expect(store.getCodeEvolution(after.eventId)?.unifiedDiff).toContain('+export const linked = true;');
    expect(store.getCaptureHealth()).toMatchObject({ fileEvents: 2, coveredFileEvents: 2, uncoveredFileEvents: 0 });
    store.close();
  });

  it('surfaces intentional sensitive-file omissions as capture gaps', () => {
    const { directory, store } = createStore();
    const path = join(directory, '.env');
    writeFileSync(path, 'API_KEY=do-not-store\n');

    const receipt = recordHookEvent(store, 'cursor', 'beforeFileEdit', {
      conversation_id: 'sensitive-session',
      workspace_path: directory,
      generation_id: 'generation-1',
      tool_call_id: 'edit-1',
      file_path: path,
    });

    expect(receipt.gapEventIds).toHaveLength(1);
    expect(store.getSession(receipt.sessionId)?.metrics.captureGaps).toBe(1);
    const gap = store.getEvent(receipt.gapEventIds[0]);
    expect(gap?.kind).toBe('gap');
    expect(gap?.payload).toMatchObject({ code: 'sensitive_path' });
    expect(store.getCodeEvolution(receipt.eventId)?.gaps).toMatchObject([{ code: 'sensitive_path' }]);
    store.close();
  });

  it('retains every path in a multi-file mutation', () => {
    const { directory, store } = createStore();
    const first = join(directory, 'first.ts');
    const second = join(directory, 'second.ts');
    writeFileSync(first, 'export const first = 1;\n');
    writeFileSync(second, 'export const second = 1;\n');
    const patch = `*** Begin Patch\n*** Update File: ${first}\n*** Update File: ${second}\n*** End Patch`;
    const common = { session_id: 'multi-edit', cwd: directory, tool_name: 'apply_patch', tool_use_id: 'patch-1', tool_input: patch };

    const before = recordHookEvent(store, 'claude', 'PreToolUse', { ...common, timestamp: '2026-08-20T12:00:00.000Z' });
    writeFileSync(first, 'export const first = 2;\n');
    writeFileSync(second, 'export const second = 2;\n');
    const after = recordHookEvent(store, 'claude', 'PostToolUse', { ...common, timestamp: '2026-08-20T12:00:01.000Z', tool_response: { ok: true } });

    expect(before.snapshots).toBe(2);
    expect(after.snapshots).toBe(2);
    const firstEvolution = store.getCodeEvolution(before.eventId);
    expect(firstEvolution?.availablePaths).toEqual([first, second]);
    expect(firstEvolution?.unifiedDiff).toContain('-export const first = 1;');
    const secondEvolution = store.getCodeEvolution(before.eventId, second);
    expect(secondEvolution?.path).toBe(second);
    expect(secondEvolution?.unifiedDiff).toContain('+export const second = 2;');
    store.close();
  });

  it('masks secrets without corrupting token telemetry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-redaction-'));
    tempDirectories.push(directory);
    const policy = loadEvidencePolicy({ redactionMode: 'mask' }, {});
    const store = new RecorderStore(join(directory, 'recorder.db'), policy);

    const receipt = recordHookEvent(store, 'compatible', 'UserPromptSubmit', {
      schema: 'afr.event.v1',
      sessionId: 'redacted-session',
      timestamp: '2026-08-20T12:00:00.000Z',
      cwd: directory,
      prompt: 'Use sk-proj-abcdefghijklmnop for this request',
      api_key: 'plaintext-secret',
      input_tokens: 125,
      output_tokens: 17,
    });

    const event = store.getEvent(receipt.eventId)!;
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('plaintext-secret');
    expect(serialized).not.toContain('sk-proj-abcdefghijklmnop');
    expect(serialized).toContain('[REDACTED');
    expect(event.tokensIn).toBe(125);
    expect(event.tokensOut).toBe(17);
    store.close();
  });

  it('previews retention and only removes evidence after explicit apply', () => {
    const { directory, store } = createStore();
    const path = join(directory, 'retained.txt');
    writeFileSync(path, 'before\n');
    const common = { session_id: 'retention-session', cwd: directory, tool_name: 'Edit', tool_use_id: 'edit-1', tool_input: { file_path: path } };
    const before = recordHookEvent(store, 'claude', 'PreToolUse', { ...common, timestamp: '2020-01-01T00:00:00.000Z' });
    writeFileSync(path, 'after\n');
    recordHookEvent(store, 'claude', 'PostToolUse', { ...common, timestamp: '2020-01-01T00:00:01.000Z' });

    const options = { rawBefore: '2021-01-01T00:00:00.000Z', snapshotsBefore: '2100-01-01T00:00:00.000Z' };
    const preview = store.applyRetention(options);
    expect(preview).toMatchObject({ rawEvents: 2, snapshots: 2, applied: false });
    expect(store.getEvent(before.eventId)?.raw).toBeDefined();
    expect(store.getCodeEvolution(before.eventId)?.unifiedDiff).toContain('-before');

    const applied = store.applyRetention({ ...options, apply: true });
    expect(applied).toMatchObject({ rawEvents: 2, snapshots: 2, applied: true });
    expect(applied.blobs).toBe(2);
    expect(store.getEvent(before.eventId)?.raw).toBeUndefined();
    expect(store.getEvent(before.eventId)?.payload).toMatchObject({ phase: 'call' });
    expect(store.getCodeEvolution(before.eventId)).toMatchObject({ unifiedDiff: null, changed: null });
    store.close();
  });

  it('compares canonical metrics across providers and exposes the schema version', () => {
    const { directory, store } = createStore();
    recordHookEvent(store, 'claude', 'UserPromptSubmit', { session_id: 'baseline', cwd: directory, prompt: 'Run checks' });
    recordHookEvent(store, 'cursor', 'beforeSubmitPrompt', { conversation_id: 'target', workspace_path: directory, prompt: 'Run checks' });
    recordHookEvent(store, 'cursor', 'beforeShellExecution', {
      conversation_id: 'target',
      workspace_path: directory,
      command: 'npm test',
      tool_call_id: 'test-1',
    });
    recordHookEvent(store, 'cursor', 'postToolUseFailure', {
      conversation_id: 'target',
      workspace_path: directory,
      tool_name: 'Shell',
      tool_call_id: 'test-1',
      tool_input: { command: 'npm test' },
      error_message: 'failed',
    });

    const comparison = store.compareSessions('claude:baseline', 'cursor:target');
    expect(comparison?.metricDelta).toMatchObject({ totalEvents: 2, testRuns: 1, errors: 1 });
    expect(comparison?.kindDelta).toMatchObject({ test: 2 });
    expect(store.getOverview().schemaVersion).toBe(7);
    store.close();
  });

  it('backfills an explicit gap when upgrading pre-snapshot file evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-migration-'));
    tempDirectories.push(directory);
    const database = join(directory, 'recorder.db');
    let store = new RecorderStore(database);
    store.upsertSession({
      id: 'codex:legacy',
      provider: 'codex',
      nativeSessionId: 'legacy',
      title: 'Legacy',
      startedAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      projectName: 'legacy',
      sourcePath: '/legacy.jsonl',
      status: 'complete',
    });
    store.insertEventWithMetrics({
      id: 'evt:legacy-file',
      sessionId: 'codex:legacy',
      sequence: 10,
      timestamp: '2020-01-01T00:00:00.000Z',
      durationMs: null,
      kind: 'file',
      title: 'Legacy file action',
      summary: 'Path was not recorded',
      status: 'running',
      actor: 'assistant',
      turnId: null,
      callId: 'legacy-call',
      parentId: null,
      tokensIn: null,
      tokensOut: null,
      cachedTokens: null,
      costUsd: null,
      command: null,
      path: null,
      payload: { phase: 'call' },
    });
    store.close();
    const native = new DatabaseSync(database);
    native.prepare("UPDATE recorder_meta SET value = '2' WHERE key = 'schema_version'").run();
    native.close();

    store = new RecorderStore(database);
    expect(store.getOverview().schemaVersion).toBe(7);
    expect(store.getSession('codex:legacy')?.metrics.captureGaps).toBe(1);
    expect(store.getEvents('codex:legacy').map((event) => event.kind)).toEqual(['file', 'gap']);
    expect(store.getEvents('codex:legacy')[1].payload).toEqual({});
    expect(store.getEvent(store.getEvents('codex:legacy')[1].id)?.payload).toMatchObject({ code: 'legacy_snapshot_unavailable' });
    store.close();
  });

  it('materializes stale unmatched tool calls as timeline gaps', () => {
    const { directory, store } = createStore();
    recordHookEvent(store, 'cursor', 'beforeShellExecution', {
      conversation_id: 'stale-call',
      workspace_path: directory,
      timestamp: '2020-01-01T00:00:00.000Z',
      command: 'node task.js',
    });

    expect(store.recordStaleCallGaps(Date.parse('2020-01-01T00:10:00.000Z'))).toBe(1);
    expect(store.recordStaleCallGaps(Date.parse('2020-01-01T00:10:00.000Z'))).toBe(0);
    const events = store.getEvents('cursor:stale-call');
    expect(events.map((event) => event.kind)).toEqual(['terminal', 'gap']);
    expect(store.getEvent(events[1].id)?.payload).toMatchObject({ code: 'tool_result_unavailable' });
    store.close();
  });

  it('materializes an explicit gap for a file action whose provider exposed no path', () => {
    const { store } = createStore();
    store.upsertSession({
      id: 'codex:pathless',
      provider: 'codex',
      nativeSessionId: 'pathless',
      title: 'Pathless',
      startedAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      projectName: 'pathless',
      sourcePath: '/pathless.jsonl',
      status: 'complete',
    });
    store.insertEventWithMetrics({
      id: 'evt:pathless',
      sessionId: 'codex:pathless',
      sequence: 10,
      timestamp: '2020-01-01T00:00:00.000Z',
      durationMs: null,
      kind: 'file',
      title: 'Pathless file action',
      summary: 'Provider omitted the path',
      status: 'success',
      actor: 'runtime',
      turnId: null,
      callId: null,
      parentId: null,
      tokensIn: null,
      tokensOut: null,
      cachedTokens: null,
      costUsd: null,
      command: null,
      path: null,
      payload: { phase: 'result' },
    });

    expect(store.recordUncoveredFileGaps()).toBe(1);
    expect(store.recordUncoveredFileGaps()).toBe(0);
    expect(store.getCaptureHealth()).toMatchObject({ fileEvents: 1, coveredFileEvents: 1, uncoveredFileEvents: 0 });
    expect(store.getEvents('codex:pathless').map((event) => event.kind)).toEqual(['file', 'gap']);
    expect(store.getEvent(store.getEvents('codex:pathless')[1].id)?.payload).toMatchObject({ code: 'file_path_unavailable' });
    store.close();
  });

  it('encrypts sensitive live evidence and enforces private filesystem modes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-encrypted-store-'));
    tempDirectories.push(directory);
    const database = join(directory, 'recorder.db');
    const store = new RecorderStore(database);
    recordHookEvent(store, 'compatible', null, {
      schema: 'afr.event.v1',
      sessionId: 'encrypted',
      event: 'prompt.submit',
      timestamp: '2026-08-20T12:00:00.000Z',
      prompt: 'private flight evidence phrase',
      cwd: directory,
    });
    const overview = store.getOverview();
    expect(overview.storageSecurity).toMatchObject({
      databaseEncryption: 'aes-256-gcm-sensitive-columns',
      plaintextMetadata: true,
      directoryMode: '0700',
      databaseMode: '0600',
    });
    store.close();

    const native = new DatabaseSync(database, { readOnly: true });
    const row = native.prepare('SELECT payload_json, raw_json FROM events LIMIT 1').get() as { payload_json: string; raw_json: string };
    expect(row.payload_json).toMatch(/^afr\.enc\.v1:/);
    expect(row.raw_json).toMatch(/^afr\.enc\.v1:/);
    expect(`${row.payload_json}${row.raw_json}`).not.toContain('private flight evidence phrase');
    native.close();
    if (process.platform !== 'win32') {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(database).mode & 0o777).toBe(0o600);
    }

    const reopened = new RecorderStore(database);
    expect(JSON.stringify(reopened.getSessionEventsDetailed('compatible:encrypted'))).toContain('private flight evidence phrase');
    reopened.close();
  });

  it('detects commits from an external hook process through SQLite data_version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-delivery-'));
    tempDirectories.push(directory);
    const database = join(directory, 'recorder.db');
    const serverStore = new RecorderStore(database);
    const hookStore = new RecorderStore(database);
    const before = serverStore.dataVersion();
    hookStore.recordHeartbeat('hook:cursor', 'postToolUse');
    expect(serverStore.dataVersion()).toBeGreaterThan(before);
    expect(serverStore.getCaptureHealth().delivery.components).toMatchObject([{ component: 'hook:cursor', state: 'active' }]);
    hookStore.close();
    serverStore.close();
  });
});

function createStore(): { directory: string; store: RecorderStore } {
  const directory = mkdtempSync(join(tmpdir(), 'afr-evidence-'));
  tempDirectories.push(directory);
  return { directory, store: new RecorderStore(join(directory, 'recorder.db')) };
}
