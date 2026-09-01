import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordHookEvent } from '../src/server/hooks.js';
import { CLAUDE_HOOK_EVENTS, CODEX_HOOK_EVENTS, CURSOR_HOOK_EVENTS, generateHookConfig } from '../src/server/hook-config.js';
import { RecorderStore } from '../src/server/store.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('provider hook bridge', () => {
  it('captures Claude Code session, prompt, tool, failure, and permission signals', () => {
    const store = createStore();
    const common = { session_id: 'claude-session', cwd: '/work/alpha', timestamp: '2026-08-20T12:00:00.000Z' };
    recordHookEvent(store, 'claude', 'SessionStart', { ...common, source: 'startup' });
    recordHookEvent(store, 'claude', 'UserPromptSubmit', { ...common, prompt: 'Repair the parser' });
    recordHookEvent(store, 'claude', 'PreToolUse', { ...common, tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'npm test' } });
    recordHookEvent(store, 'claude', 'PostToolUseFailure', {
      ...common,
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      tool_input: { command: 'npm test' },
      error: 'one test failed',
    });
    recordHookEvent(store, 'claude', 'PermissionRequest', { ...common, tool_name: 'Bash', tool_input: { command: 'git push' } });

    const session = store.getSession('claude:claude-session');
    expect(session?.title).toBe('alpha');
    expect(session?.metrics.testRuns).toBe(1);
    expect(session?.metrics.errors).toBe(1);
    expect(store.getEvents(session!.id).map((event) => event.kind)).toEqual(['lifecycle', 'prompt', 'test', 'test', 'permission']);
    const permission = store.getEvents(session!.id).find((event) => event.kind === 'permission');
    expect(store.getPermissionTrace(permission!.id)?.current).toMatchObject({ outcome: 'pending', assurance: 'unresolved' });
    expect(store.recordStalePermissionUnknowns(Date.parse('2026-08-20T12:10:00.000Z'))).toBe(1);
    expect(store.getPermissionTrace(permission!.id)?.current).toMatchObject({ outcome: 'unknown', assurance: 'unresolved' });
    store.close();
  });

  it('separates explicit permission decisions from inferred execution', () => {
    const store = createStore();
    const common = { session_id: 'permission-session', cwd: '/work/permission' };
    const request = recordHookEvent(store, 'claude', 'PermissionRequest', {
      ...common,
      timestamp: '2026-08-20T12:00:00.000Z',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
    });
    const result = recordHookEvent(store, 'claude', 'PostToolUse', {
      ...common,
      timestamp: '2026-08-20T12:00:02.000Z',
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      tool_input: { command: 'git push' },
      tool_response: 'done',
    });
    expect(store.getPermissionTrace(request.eventId)?.current).toMatchObject({
      outcome: 'executed',
      assurance: 'inferred',
      decisionEventId: result.eventId,
      callId: 'tool-1',
    });

    const denied = recordHookEvent(store, 'cursor', 'postToolUseFailure', {
      conversation_id: 'cursor-permission',
      workspace_path: '/work/permission',
      timestamp: '2026-08-20T12:01:00.000Z',
      tool_name: 'Shell',
      tool_use_id: 'tool-denied',
      tool_input: { command: 'rm guarded' },
      failure_type: 'permission_denied',
      error_message: 'Denied by user',
    });
    expect(store.getPermissionTrace(denied.eventId)?.current).toMatchObject({
      outcome: 'denied',
      assurance: 'explicit',
      decisionEventId: denied.eventId,
      callId: 'tool-denied',
    });

    const compatible = { schema: 'afr.event.v1', sessionId: 'compatible-permission', cwd: '/work/permission' };
    const compatibleRequest = recordHookEvent(store, 'compatible', null, {
      ...compatible,
      event: 'permission.request',
      timestamp: '2026-08-20T12:02:00.000Z',
      tool: 'Shell',
      input: { command: 'deploy' },
    });
    recordHookEvent(store, 'compatible', null, {
      ...compatible,
      event: 'permission.approved',
      timestamp: '2026-08-20T12:02:01.000Z',
      tool: 'Shell',
      input: { command: 'deploy' },
      decision: { behavior: 'allow' },
    });
    expect(store.getPermissionTrace(compatibleRequest.eventId)?.current).toMatchObject({ outcome: 'allowed', assurance: 'explicit' });
    store.close();
  });

  it('maps Cursor shell and prompt events without provider-specific storage', () => {
    const store = createStore();
    const common = { conversation_id: 'cursor-session', workspace_path: '/work/beta', timestamp: '2026-08-20T13:00:00.000Z' };
    recordHookEvent(store, 'cursor', 'beforeSubmitPrompt', { ...common, prompt: 'Check the build' });
    const before = recordHookEvent(store, 'cursor', 'beforeShellExecution', { ...common, command: 'pnpm build', sandbox: true });
    const after = recordHookEvent(store, 'cursor', 'afterShellExecution', {
      ...common,
      command: 'pnpm build',
      output: 'done',
      duration_ms: 820,
      sandbox: true,
    });

    const events = store.getEvents('cursor:cursor-session');
    expect(events.map((event) => event.kind)).toEqual(['prompt', 'test', 'test']);
    expect(events[2].durationMs).toBe(820);
    expect(store.getSession('cursor:cursor-session')?.metrics.testRuns).toBe(1);
    expect(store.getCallLineage(before.eventId)?.current).toMatchObject({ callId: null, outcome: 'success', facets: 2, startObserved: true });
    expect(store.getCallLineage(after.eventId)?.current?.eventId).toBe(before.eventId);
    store.close();
  });

  it('derives durable retry lineage only after an observed failed attempt', () => {
    const store = createStore();
    const common = { conversation_id: 'retry-session', workspace_path: '/work/retry' };
    recordHookEvent(store, 'cursor', 'beforeShellExecution', { ...common, timestamp: '2026-08-20T13:00:00.000Z', command: 'pnpm test' });
    recordHookEvent(store, 'cursor', 'afterShellExecution', {
      ...common,
      timestamp: '2026-08-20T13:00:01.000Z',
      command: 'pnpm test',
      output: 'Process exited with code 1',
    });
    const second = recordHookEvent(store, 'cursor', 'beforeShellExecution', { ...common, timestamp: '2026-08-20T13:00:02.000Z', command: 'pnpm test' });
    recordHookEvent(store, 'cursor', 'afterShellExecution', { ...common, timestamp: '2026-08-20T13:00:03.000Z', command: 'pnpm test', output: 'passed' });
    recordHookEvent(store, 'cursor', 'beforeShellExecution', { ...common, timestamp: '2026-08-20T13:00:04.000Z', command: 'pnpm test' });

    const events = store.getEvents('cursor:retry-session');
    expect(events.filter((event) => event.kind === 'retry')).toHaveLength(1);
    expect(store.getSession('cursor:retry-session')?.metrics.retries).toBe(1);
    const lineage = store.getCallLineage(second.eventId);
    expect(lineage?.current?.attempt).toBe(2);
    expect(lineage?.attempts.map((attempt) => attempt.outcome)).toEqual(['error', 'success', 'running']);

    store.rebuildCallCorrelations('cursor:retry-session');
    expect(store.getEvents('cursor:retry-session').filter((event) => event.kind === 'retry')).toHaveLength(1);
    expect(store.getCallLineage(second.eventId)?.attempts).toHaveLength(3);
    store.close();
  });

  it('does not label a distant repeated action as a retry or attach a late orphan result', () => {
    const store = createStore();
    const common = { conversation_id: 'bounded-correlation', workspace_path: '/work/bounded' };
    recordHookEvent(store, 'cursor', 'beforeShellExecution', { ...common, timestamp: '2026-08-20T13:00:00.000Z', command: 'pnpm test' });
    recordHookEvent(store, 'cursor', 'afterShellExecution', {
      ...common,
      timestamp: '2026-08-20T13:00:01.000Z',
      command: 'pnpm test',
      output: 'Process exited with code 1',
    });
    const distant = recordHookEvent(store, 'cursor', 'beforeShellExecution', { ...common, timestamp: '2026-08-20T13:10:02.000Z', command: 'pnpm test' });
    expect(store.getEvents('cursor:bounded-correlation').filter((event) => event.kind === 'retry')).toHaveLength(0);
    expect(store.getCallLineage(distant.eventId)?.current?.attempt).toBe(2);

    const firstEdit = recordHookEvent(store, 'cursor', 'afterFileEdit', {
      ...common,
      timestamp: '2026-08-20T14:00:00.000Z',
      file_path: '/work/bounded/file.ts',
      edits: [],
    });
    const lateEdit = recordHookEvent(store, 'cursor', 'afterFileEdit', {
      ...common,
      timestamp: '2026-08-20T15:00:00.000Z',
      file_path: '/work/bounded/file.ts',
      edits: [],
    });
    expect(store.getCallLineage(firstEdit.eventId)?.current).toMatchObject({ eventId: firstEdit.eventId, startObserved: false });
    expect(store.getCallLineage(lateEdit.eventId)?.current).toMatchObject({ eventId: lateEdit.eventId, startObserved: false });
    expect(store.getSession('cursor:bounded-correlation')?.metrics.fileChanges).toBe(2);
    store.close();
  });

  it('retains every native Cursor callback while merging duplicate facets into one logical action', () => {
    const store = createStore();
    const common = {
      conversation_id: 'cursor-facets',
      generation_id: 'generation-1',
      workspace_roots: ['/work/facets'],
      cwd: '/work/facets',
      timestamp: '2026-08-20T13:10:00.000Z',
    };
    const pre = recordHookEvent(store, 'cursor', 'preToolUse', {
      ...common,
      tool_name: 'Shell',
      tool_use_id: 'tool-1',
      tool_input: { command: 'pnpm test' },
    });
    const before = recordHookEvent(store, 'cursor', 'beforeShellExecution', { ...common, command: 'pnpm test', sandbox: true });
    const after = recordHookEvent(store, 'cursor', 'afterShellExecution', {
      ...common,
      command: 'pnpm test',
      output: 'Process exited with code 1',
      duration: 12,
      sandbox: true,
    });
    const post = recordHookEvent(store, 'cursor', 'postToolUseFailure', {
      ...common,
      tool_name: 'Shell',
      tool_use_id: 'tool-1',
      tool_input: { command: 'pnpm test' },
      error_message: 'failed',
      failure_type: 'error',
      duration: 12,
    });

    expect(store.getEvents('cursor:cursor-facets')).toHaveLength(4);
    expect(store.getSession('cursor:cursor-facets')?.metrics).toMatchObject({ toolCalls: 1, testRuns: 1, errors: 1 });
    for (const receipt of [pre, before, after, post]) {
      expect(store.getCallLineage(receipt.eventId)?.current).toMatchObject({ eventId: pre.eventId, callId: 'tool-1', outcome: 'error', facets: 4 });
    }
    store.close();
  });

  it('does not invent stale result gaps for Cursor read hooks that have no after event', () => {
    const store = createStore();
    const common = {
      conversation_id: 'cursor-read',
      generation_id: 'generation-1',
      workspace_roots: ['/work/read'],
      cwd: '/work/read',
    };
    const specialized = recordHookEvent(store, 'cursor', 'beforeReadFile', {
      ...common,
      timestamp: '2020-01-01T00:00:00.000Z',
      file_path: '/work/read/input.ts',
      content: 'export {}',
      attachments: [],
    });
    expect(store.getCallLineage(specialized.eventId)?.current).toMatchObject({ outcome: 'unknown', facets: 1 });
    expect(store.recordStaleCallGaps(Date.parse('2020-01-01T00:10:00.000Z'))).toBe(0);

    const generic = recordHookEvent(store, 'cursor', 'preToolUse', {
      ...common,
      timestamp: '2020-01-01T00:00:01.000Z',
      tool_name: 'Read',
      tool_use_id: 'read-1',
      tool_input: { file_path: '/work/read/input.ts' },
    });
    const result = recordHookEvent(store, 'cursor', 'postToolUse', {
      ...common,
      timestamp: '2020-01-01T00:00:02.000Z',
      tool_name: 'Read',
      tool_use_id: 'read-1',
      tool_input: { file_path: '/work/read/input.ts' },
      tool_output: JSON.stringify({ content: 'export {}' }),
      duration: 2,
    });
    expect(store.getSession('cursor:cursor-read')?.metrics.toolCalls).toBe(1);
    for (const receipt of [specialized, generic, result]) {
      expect(store.getCallLineage(receipt.eventId)?.current).toMatchObject({ eventId: specialized.eventId, callId: 'read-1', outcome: 'success', facets: 3 });
    }
    store.close();
  });

  it('expands Claude tool batches into individually replayable calls', () => {
    const store = createStore();
    const receipt = recordHookEvent(store, 'claude', 'PostToolBatch', {
      session_id: 'batch-session',
      cwd: '/work/batch',
      tool_calls: [
        { tool_name: 'Read', tool_use_id: 'read-1', tool_input: { file_path: '/work/batch/a.ts' }, tool_response: { content: 'a' } },
        { tool_name: 'Bash', tool_use_id: 'shell-1', tool_input: { command: 'npm test' }, tool_response: { output: 'passed' } },
      ],
    });
    expect(receipt.eventIds).toHaveLength(2);
    expect(store.getEvents('claude:batch-session').map((event) => event.kind)).toEqual(['tool', 'test']);
    store.close();
  });

  it('generates complete fail-open local hook configurations', () => {
    const codex = generateHookConfig('codex', '/usr/bin/node', '/app/cli.js', '/data') as { hooks: Record<string, unknown[]> };
    const claude = generateHookConfig('claude', '/usr/bin/node', '/app/cli.js', '/data') as { hooks: Record<string, unknown[]> };
    const cursor = generateHookConfig('cursor', '/usr/bin/node', '/app/cli.js', '/data') as {
      version: number;
      hooks: Record<string, Array<{ failClosed: boolean }>>;
    };
    expect(Object.keys(codex.hooks)).toHaveLength(CODEX_HOOK_EVENTS.length);
    expect(JSON.stringify(codex.hooks.PreToolUse)).toContain("'/usr/bin/node' '/app/cli.js' 'hook' '--provider=codex'");
    expect(Object.keys(claude.hooks)).toHaveLength(CLAUDE_HOOK_EVENTS.length);
    expect(Object.keys(cursor.hooks)).toHaveLength(CURSOR_HOOK_EVENTS.length);
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.preToolUse[0].failClosed).toBe(false);
  });

  it('enforces the versioned compatible-agent envelope', () => {
    const store = createStore();
    expect(() => recordHookEvent(store, 'compatible', null, { sessionId: 'demo', event: 'session.start', timestamp: '2026-08-20T12:00:00.000Z' })).toThrow(
      /schema/,
    );
    const receipt = recordHookEvent(store, 'compatible', null, {
      schema: 'afr.event.v1',
      sessionId: 'demo',
      event: 'session.start',
      timestamp: '2026-08-20T12:00:00.000Z',
      cwd: '/work/demo',
    });
    expect(receipt.sessionId).toBe('compatible:demo');
    store.close();
  });
});

function createStore(): RecorderStore {
  const directory = mkdtempSync(join(tmpdir(), 'afr-hooks-'));
  tempDirectories.push(directory);
  return new RecorderStore(join(directory, 'recorder.db'));
}
