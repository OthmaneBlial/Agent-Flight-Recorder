import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importCodexFile } from '../src/server/adapters/codex.js';
import { RecorderStore } from '../src/server/store.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Codex adapter', () => {
  it('imports and incrementally resumes a native rollout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-codex-'));
    tempDirectories.push(directory);
    const source = join(directory, 'rollout.jsonl');
    const database = join(directory, 'recorder.db');
    const lines = [
      native(1, 'session_meta', { id: 'session-1', cwd: '/work/alpha', cli_version: '1.2.3', model_provider: 'openai' }),
      native(2, 'turn_context', { approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, turn_id: 'turn-1' }),
      native(3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the failing parser' }] }),
      native(4, 'response_item', { type: 'reasoning', summary: [], encrypted_content: 'ciphertext' }),
      native(5, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'call-1', input: 'await tools.exec_command({cmd: "npm test"})' }),
      native(6, 'response_item', { type: 'custom_tool_call_output', call_id: 'call-1', output: [{ type: 'input_text', text: 'Process exited with code 1' }] }),
    ];
    writeFileSync(source, `${lines.join('\n')}\n`);
    const store = new RecorderStore(database);

    const first = await importCodexFile(source, store);
    expect(first.changed).toBe(true);
    expect(first.events).toBe(6);
    expect(store.getSessions()).toHaveLength(1);
    expect(store.getSessions()[0].title).toBe('Fix the failing parser');
    expect(store.getSessions()[0].metrics.testRuns).toBe(1);
    expect(store.getSessions()[0].metrics.errors).toBe(1);

    const unchanged = await importCodexFile(source, store);
    expect(unchanged.changed).toBe(false);

    appendFileSync(
      source,
      `${native(7, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'call-2', input: 'await tools.exec_command({cmd: "npm test"})' })}\n`,
    );
    const resumed = await importCodexFile(source, store);
    expect(resumed.changed).toBe(true);
    expect(resumed.events).toBe(1);
    const retried = store.getEvents('codex:session-1');
    expect(retried).toHaveLength(8);
    expect(retried.map((event) => event.kind)).toContain('retry');
    const secondCall = retried.find((event) => event.callId === 'call-2' && event.kind === 'test');
    const lineage = store.getCallLineage(secondCall!.id);
    expect(lineage?.current?.attempt).toBe(2);
    expect(lineage?.attempts.map((attempt) => attempt.outcome)).toEqual(['error', 'running']);

    appendFileSync(
      source,
      `${native(8, 'response_item', { type: 'custom_tool_call_output', call_id: 'call-2', output: [{ type: 'input_text', text: 'Tests passed' }] })}\n`,
    );
    await importCodexFile(source, store);
    expect(store.getCallLineage(secondCall!.id)?.attempts.map((attempt) => attempt.outcome)).toEqual(['error', 'success']);
    store.close();

    const reopened = new RecorderStore(database);
    expect(reopened.getSession('codex:session-1')?.metrics.retries).toBe(1);
    expect(reopened.getCallLineage(secondCall!.id)?.current?.attempt).toBe(2);
    reopened.close();
  });

  it('keeps the first session identity when a subagent source repeats metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-codex-meta-'));
    tempDirectories.push(directory);
    const source = join(directory, 'subagent.jsonl');
    writeFileSync(
      source,
      [
        native(0, 'session_meta', { id: 'source-session', session_id: 'parent-session', cwd: '/work/alpha' }),
        native(1, 'session_meta', { id: 'nested-meta', session_id: 'parent-session', cwd: '/work/alpha' }),
        native(2, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }),
      ].join('\n') + '\n',
    );
    const store = new RecorderStore(join(directory, 'recorder.db'));

    await importCodexFile(source, store);

    expect(store.getSessions()).toHaveLength(1);
    expect(store.getSession('codex:source-session')?.metrics.totalEvents).toBe(3);
    expect(store.getSession('codex:nested-meta')).toBeNull();
    store.close();
  });

  it('bounds an incremental read to the stat snapshot while an active rollout grows', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-codex-growing-'));
    tempDirectories.push(directory);
    const source = join(directory, 'growing.jsonl');
    writeFileSync(
      source,
      [
        native(1, 'session_meta', { id: 'growing-session', cwd: '/work/growing' }),
        native(2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start' }] }),
      ].join('\n') + '\n',
    );
    const initialSize = statSize(source);
    const store = new RecorderStore(join(directory, 'recorder.db'));

    const firstImport = importCodexFile(source, store);
    appendFileSync(
      source,
      `${native(3, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Appended during read' }] })}\n`,
    );
    await firstImport;

    const firstSource = store.getSource(source)!;
    expect(firstSource.byteOffset).toBe(initialSize);
    expect(firstSource.byteOffset).toBeLessThanOrEqual(firstSource.size);
    expect(store.getEvents('codex:growing-session')).toHaveLength(2);

    await importCodexFile(source, store);
    expect(store.getEvents('codex:growing-session')).toHaveLength(3);
    store.close();
  });

  it('normalizes legacy and runtime-completion action records without double-counting facets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-codex-runtime-items-'));
    tempDirectories.push(directory);
    const source = join(directory, 'runtime-items.jsonl');
    const changedPath = join(directory, 'changed.ts');
    writeFileSync(
      source,
      [
        native(1, 'session_meta', { id: 'runtime-items', cwd: directory }),
        native(2, 'event_msg', { type: 'user_message', message: 'Run the old event stream', images: [], local_images: [], text_elements: [] }),
        native(3, 'event_msg', { type: 'agent_message', message: 'Starting now', phase: 'commentary' }),
        native(4, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'exec-1', arguments: JSON.stringify({ cmd: 'npm test' }) }),
        native(5, 'event_msg', {
          type: 'exec_command_end',
          call_id: 'exec-1',
          command: ['/bin/zsh', '-lc', 'npm test'],
          cwd: directory,
          aggregated_output: 'passed',
          exit_code: 0,
          status: 'completed',
          duration: { secs: 0, nanos: 5_000_000 },
        }),
        native(6, 'response_item', { type: 'function_call_output', call_id: 'exec-1', output: 'passed' }),
        native(7, 'event_msg', {
          type: 'item_completed',
          started_at_ms: 10,
          completed_at_ms: 15,
          item: {
            type: 'CommandExecution',
            id: 'runtime-exec-1',
            command: ['/bin/zsh', '-lc', 'npm test'],
            cwd: directory,
            aggregated_output: 'passed',
            exit_code: 0,
            status: 'completed',
            duration: { secs: 0, nanos: 5_000_000 },
          },
        }),
        native(8, 'response_item', {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'patch-1',
          input: `*** Begin Patch\n*** Update File: ${changedPath}\n*** End Patch`,
        }),
        native(9, 'event_msg', {
          type: 'patch_apply_end',
          call_id: 'patch-1',
          success: true,
          status: 'completed',
          changes: { [changedPath]: { type: 'update' } },
        }),
        native(10, 'event_msg', { type: 'context_compacted' }),
        native(11, 'event_msg', { type: 'turn_aborted', reason: 'operator interrupt', duration_ms: 20 }),
      ].join('\n') + '\n',
    );
    const store = new RecorderStore(join(directory, 'recorder.db'));

    await importCodexFile(source, store);

    const events = store.getEvents('codex:runtime-items');
    expect(events.map((event) => event.kind)).toEqual([
      'lifecycle',
      'prompt',
      'response',
      'test',
      'test',
      'test',
      'test',
      'file',
      'gap',
      'file',
      'context',
      'error',
    ]);
    expect(store.getSession('codex:runtime-items')?.metrics).toMatchObject({ toolCalls: 2, testRuns: 1, fileChanges: 1, errors: 1 });
    const command = events.find((event) => event.callId === 'exec-1' && event.status === 'running')!;
    expect(store.getCallLineage(command.id)?.current).toMatchObject({ outcome: 'success', facets: 4 });
    const patch = events.find((event) => event.callId === 'patch-1' && event.status === 'running')!;
    expect(store.getCallLineage(patch.id)?.current).toMatchObject({ outcome: 'success', facets: 2 });
    store.close();
  });

  it('separates Codex escalation requests from terminal execution evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-codex-permission-'));
    tempDirectories.push(directory);
    const source = join(directory, 'permission.jsonl');
    writeFileSync(
      source,
      [
        native(1, 'session_meta', { id: 'permission-session', cwd: directory }),
        native(2, 'response_item', {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'escalated-1',
          arguments: JSON.stringify({ cmd: 'echo ok', sandbox_permissions: 'require_escalated', justification: 'Needs a local capability' }),
        }),
        native(3, 'response_item', { type: 'function_call_output', call_id: 'escalated-1', output: 'ok' }),
      ].join('\n') + '\n',
    );
    const store = new RecorderStore(join(directory, 'recorder.db'));

    await importCodexFile(source, store);

    const events = store.getEvents('codex:permission-session');
    expect(events.map((event) => event.kind)).toEqual(['lifecycle', 'permission', 'terminal', 'terminal']);
    expect(store.getSession('codex:permission-session')?.metrics).toMatchObject({ toolCalls: 1, terminalCommands: 1 });
    const permission = events.find((event) => event.kind === 'permission')!;
    expect(store.getPermissionTrace(permission.id)?.current).toMatchObject({ outcome: 'executed', assurance: 'inferred', callId: 'escalated-1' });
    store.close();
  });
});

function native(ordinal: number, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp: `2026-08-20T10:00:${String(ordinal).padStart(2, '0')}.000Z`, type, ordinal, payload });
}

function statSize(path: string): number {
  return statSync(path).size;
}
