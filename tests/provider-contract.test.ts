import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordHookEvent } from '../src/server/hooks.js';
import { CLAUDE_HOOK_EVENTS, CODEX_HOOK_EVENTS, CURSOR_HOOK_EVENTS } from '../src/server/hook-config.js';
import { RecorderStore } from '../src/server/store.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('official provider event contracts', () => {
  it('ingests all 11 documented Codex hook events without dropping the native envelope', () => {
    const store = createStore();
    const receipts = CODEX_HOOK_EVENTS.map((event, index) => {
      const payload = {
        session_id: 'codex-contract',
        turn_id: 'turn-1',
        transcript_path: '/tmp/codex-contract.jsonl',
        cwd: '/work/codex-contract',
        model: 'gpt-5',
        permission_mode: 'workspace-write',
        hook_event_name: event,
        timestamp: new Date(Date.parse('2026-08-20T09:00:00.000Z') + index * 1_000).toISOString(),
        ...codexFields(event),
      };
      return { event, receipt: recordHookEvent(store, 'codex', event, payload) };
    });

    expect(receipts).toHaveLength(CODEX_HOOK_EVENTS.length);
    expect(receipts.flatMap(({ receipt }) => receipt.eventIds)).toHaveLength(CODEX_HOOK_EVENTS.length);
    for (const { event, receipt } of receipts) {
      const stored = store.getEvent(receipt.eventId)!;
      expect(stored.raw).toMatchObject({ hook_event_name: event });
      expect(stored.payload).toMatchObject({ providerEvent: event });
    }
    expect(receipts.find(({ event }) => event === 'UserPromptSubmit')?.receipt.kind).toBe('prompt');
    expect(receipts.find(({ event }) => event === 'PreToolUse')?.receipt.kind).toBe('test');
    expect(receipts.find(({ event }) => event === 'PermissionRequest')?.receipt.kind).toBe('permission');
    expect(receipts.find(({ event }) => event === 'PostCompact')?.receipt.kind).toBe('context');
    store.close();
  });

  it('ingests all 33 documented Claude Code hook events without dropping the native envelope', () => {
    const store = createStore();
    const receipts = CLAUDE_HOOK_EVENTS.map((event, index) => {
      const payload = {
        session_id: 'claude-contract',
        prompt_id: 'prompt-1',
        transcript_path: '/tmp/claude-contract.jsonl',
        cwd: '/work/claude-contract',
        permission_mode: 'default',
        effort: { level: 'high' },
        hook_event_name: event,
        timestamp: new Date(Date.parse('2026-08-20T10:00:00.000Z') + index * 1_000).toISOString(),
        ...claudeFields(event),
      };
      return { event, receipt: recordHookEvent(store, 'claude', event, payload) };
    });

    expect(receipts).toHaveLength(CLAUDE_HOOK_EVENTS.length);
    expect(receipts.flatMap(({ receipt }) => receipt.eventIds)).toHaveLength(CLAUDE_HOOK_EVENTS.length);
    for (const { event, receipt } of receipts) {
      const stored = store.getEvent(receipt.eventId)!;
      expect(stored.raw).toMatchObject({ hook_event_name: event });
      expect(stored.payload).toMatchObject({ providerEvent: event });
    }
    expect(receipts.find(({ event }) => event === 'MessageDisplay')?.receipt.kind).toBe('response');
    expect(receipts.find(({ event }) => event === 'FileChanged')?.receipt.kind).toBe('file');
    expect(receipts.find(({ event }) => event === 'PermissionDenied')?.receipt.kind).toBe('permission');
    expect(receipts.find(({ event }) => event === 'StopFailure')?.receipt.kind).toBe('error');
    store.close();
  });

  it('ingests all 21 documented native Cursor events, including the unscoped workspace event', () => {
    const store = createStore();
    const receipts = CURSOR_HOOK_EVENTS.map((event, index) => {
      const sessionFields =
        event === 'workspaceOpen'
          ? {}
          : {
              conversation_id: 'cursor-contract',
              generation_id: 'generation-1',
              model: 'composer-model',
              model_id: 'model-1',
              model_params: [{ id: 'thinking', value: 'high' }],
              transcript_path: '/tmp/cursor-contract.jsonl',
            };
      const payload = {
        ...sessionFields,
        hook_event_name: event,
        cursor_version: '1.7.0',
        workspace_roots: ['/work/cursor-contract'],
        user_email: null,
        timestamp: new Date(Date.parse('2026-08-20T11:00:00.000Z') + index * 1_000).toISOString(),
        ...cursorFields(event),
      };
      return { event, receipt: recordHookEvent(store, 'cursor', event, payload) };
    });

    expect(receipts).toHaveLength(21);
    expect(receipts.flatMap(({ receipt }) => receipt.eventIds)).toHaveLength(21);
    for (const { event, receipt } of receipts) {
      const stored = store.getEvent(receipt.eventId)!;
      expect(stored.raw).toMatchObject({ hook_event_name: event });
      expect(stored.payload).toMatchObject({ providerEvent: event });
    }
    expect(receipts.find(({ event }) => event === 'afterAgentThought')?.receipt.kind).toBe('reasoning');
    expect(receipts.find(({ event }) => event === 'afterAgentResponse')?.receipt.kind).toBe('response');
    expect(receipts.find(({ event }) => event === 'beforeTabFileRead')?.receipt.kind).toBe('tool');
    expect(receipts.find(({ event }) => event === 'afterTabFileEdit')?.receipt.kind).toBe('file');
    expect(receipts.find(({ event }) => event === 'workspaceOpen')?.receipt.sessionId).toMatch(/^cursor:unscoped-/);
    store.close();
  });
});

function codexFields(event: (typeof CODEX_HOOK_EVENTS)[number]): Record<string, unknown> {
  const fields: Record<(typeof CODEX_HOOK_EVENTS)[number], Record<string, unknown>> = {
    SessionStart: { source: 'startup' },
    SessionEnd: { reason: 'other' },
    SubagentStart: { agent_id: 'agent-1', agent_type: 'explore' },
    PreToolUse: { tool_name: 'Bash', tool_input: { command: 'npm test -- contract' }, tool_use_id: 'codex-tool-1' },
    PermissionRequest: { tool_name: 'Bash', tool_input: { command: 'git push' } },
    PostToolUse: {
      tool_name: 'Bash',
      tool_input: { command: 'npm test -- contract' },
      tool_use_id: 'codex-tool-1',
      tool_output: 'passed',
      duration_ms: 4,
    },
    UserPromptSubmit: { prompt: 'Inspect the contract' },
    PreCompact: { trigger: 'auto' },
    PostCompact: { trigger: 'auto' },
    SubagentStop: { agent_id: 'agent-1', agent_type: 'explore', last_assistant_message: 'Done' },
    Stop: { last_assistant_message: 'Complete' },
  };
  return fields[event];
}

function claudeFields(event: (typeof CLAUDE_HOOK_EVENTS)[number]): Record<string, unknown> {
  const fields: Record<(typeof CLAUDE_HOOK_EVENTS)[number], Record<string, unknown>> = {
    SessionStart: { source: 'startup', model: 'claude-sonnet', session_title: 'Contract' },
    Setup: { trigger: 'init' },
    UserPromptSubmit: { prompt: 'Inspect the contract' },
    UserPromptExpansion: { expansion_type: 'slash_command', command_name: 'review', command_args: '', command_source: 'builtin', prompt: '/review' },
    PreToolUse: { tool_name: 'Bash', tool_input: { command: 'npm test -- contract' }, tool_use_id: 'claude-tool-1' },
    PermissionRequest: { tool_name: 'Bash', tool_input: { command: 'git push' }, permission_suggestions: [] },
    PermissionDenied: { tool_name: 'Bash', tool_input: { command: 'rm guarded' }, tool_use_id: 'claude-denied-1', reason: 'auto mode denied' },
    PostToolUse: {
      tool_name: 'Bash',
      tool_input: { command: 'npm test -- contract' },
      tool_use_id: 'claude-tool-1',
      tool_response: { output: 'passed' },
      duration_ms: 4,
    },
    PostToolUseFailure: {
      tool_name: 'Bash',
      tool_input: { command: 'npm test -- failure' },
      tool_use_id: 'claude-tool-2',
      error: 'failed',
      is_interrupt: false,
      duration_ms: 5,
    },
    PostToolBatch: {
      tool_calls: [
        { tool_name: 'Read', tool_input: { file_path: '/work/claude-contract/a.ts' }, tool_use_id: 'claude-batch-1', tool_response: { content: 'a' } },
      ],
    },
    Notification: { message: 'Waiting for input', title: 'Claude', notification_type: 'permission_prompt' },
    MessageDisplay: { turn_id: 'turn-1', message_id: 'display-1', index: 0, final: true, delta: 'Visible response' },
    SubagentStart: { agent_id: 'agent-1', agent_type: 'Explore' },
    SubagentStop: {
      stop_hook_active: false,
      agent_id: 'agent-1',
      agent_type: 'Explore',
      agent_transcript_path: '/tmp/agent-1.jsonl',
      last_assistant_message: 'Done',
      background_tasks: [],
      session_crons: [],
    },
    TaskCreated: { task_id: 'task-1', task_subject: 'Audit', task_description: 'Inspect hooks', teammate_name: 'researcher' },
    TaskCompleted: { task_id: 'task-1', task_subject: 'Audit', task_description: 'Inspect hooks', teammate_name: 'researcher' },
    Stop: { stop_hook_active: false, last_assistant_message: 'Complete', background_tasks: [], session_crons: [] },
    StopFailure: { error: 'API stopped', error_details: { code: 'overloaded' }, last_assistant_message: 'Partial' },
    TeammateIdle: { teammate_name: 'researcher', team_name: 'audit' },
    InstructionsLoaded: { file_path: '/work/claude-contract/CLAUDE.md', memory_type: 'Project', load_reason: 'session_start' },
    ConfigChange: { source: 'user_settings', file_path: '/tmp/settings.json' },
    CwdChanged: { old_cwd: '/work/old', new_cwd: '/work/claude-contract' },
    DirectoryAdded: { directory: '/work/claude-contract/packages', source: 'slash_command' },
    FileChanged: { file_path: '/work/claude-contract/changed.ts', event: 'change' },
    WorktreeCreate: { name: 'audit-hooks' },
    WorktreeRemove: { worktree_path: '/work/worktrees/audit-hooks' },
    PreCompact: { trigger: 'auto', custom_instructions: '' },
    PostCompact: { trigger: 'auto', compact_summary: 'Compacted state' },
    Elicitation: { mcp_server_name: 'server', message: 'Choose', mode: 'form', elicitation_id: 'elicit-1', requested_schema: { type: 'object' } },
    ElicitationResult: { mcp_server_name: 'server', action: 'accept', mode: 'form', elicitation_id: 'elicit-1', content: { accepted: true } },
    PreModelSwitch: {
      from_model: 'claude-sonnet-5',
      to_model: 'claude-opus-5',
      requested_model: 'opus',
      source: 'command',
      context_tokens: 182_340,
      prompt_cache_warm: true,
      cache_ttl: '5m',
      estimated_cache_write_usd: 1.1396,
      pricing: 'catalog',
    },
    PostModelSwitch: {
      from_model: 'claude-sonnet-5',
      to_model: 'claude-opus-5',
      requested_model: 'opus',
      source: 'command',
      context_tokens: 182_340,
      prompt_cache_warm: true,
      cache_ttl: '5m',
      estimated_cache_write_usd: 1.1396,
      pricing: 'catalog',
    },
    SessionEnd: { reason: 'other' },
  };
  return fields[event];
}

function cursorFields(event: (typeof CURSOR_HOOK_EVENTS)[number]): Record<string, unknown> {
  const fields: Record<(typeof CURSOR_HOOK_EVENTS)[number], Record<string, unknown>> = {
    sessionStart: { session_id: 'cursor-contract', is_background_agent: false, composer_mode: 'agent' },
    sessionEnd: { session_id: 'cursor-contract', reason: 'completed', duration_ms: 500, is_background_agent: false, final_status: 'completed' },
    beforeSubmitPrompt: { prompt: 'Inspect Cursor hooks', attachments: [] },
    preToolUse: { tool_name: 'Shell', tool_input: { command: 'pnpm test -- generic' }, tool_use_id: 'cursor-tool-1', cwd: '/work/cursor-contract' },
    postToolUse: {
      tool_name: 'Shell',
      tool_input: { command: 'pnpm test -- generic' },
      tool_output: JSON.stringify({ output: 'passed' }),
      tool_use_id: 'cursor-tool-1',
      cwd: '/work/cursor-contract',
      duration: 7,
    },
    postToolUseFailure: {
      tool_name: 'Shell',
      tool_input: { command: 'pnpm test -- failed' },
      tool_use_id: 'cursor-tool-2',
      cwd: '/work/cursor-contract',
      error_message: 'failed',
      failure_type: 'error',
      duration: 8,
      is_interrupt: false,
    },
    beforeShellExecution: { command: 'pnpm build', cwd: '/work/cursor-contract', sandbox: true },
    afterShellExecution: { command: 'pnpm build', output: 'done', duration: 9, sandbox: true },
    beforeMCPExecution: { tool_name: 'database_query', tool_input: { query: 'select 1' }, command: 'mcp-server' },
    afterMCPExecution: {
      tool_name: 'database_query',
      tool_input: JSON.stringify({ query: 'select 1' }),
      result_json: JSON.stringify({ rows: [1] }),
      duration: 10,
    },
    beforeReadFile: { file_path: '/work/cursor-contract/read.ts', content: 'export {}', attachments: [] },
    afterFileEdit: { file_path: '/work/cursor-contract/changed.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
    subagentStart: {
      subagent_id: 'subagent-1',
      subagent_type: 'explore',
      task: 'Inspect',
      parent_conversation_id: 'cursor-contract',
      tool_call_id: 'subagent-call-1',
      subagent_model: 'model-1',
      is_parallel_worker: false,
    },
    subagentStop: {
      subagent_type: 'explore',
      status: 'completed',
      task: 'Inspect',
      description: 'Audit',
      summary: 'Done',
      duration_ms: 12,
      message_count: 2,
      tool_call_count: 1,
      loop_count: 1,
      modified_files: [],
      agent_transcript_path: '/tmp/subagent.jsonl',
    },
    afterAgentThought: { text: 'A completed thinking block', duration_ms: 11 },
    afterAgentResponse: { text: 'A final response' },
    preCompact: {
      trigger: 'auto',
      context_usage_percent: 80,
      context_tokens: 80_000,
      context_window_size: 100_000,
      message_count: 30,
      messages_to_compact: 10,
      is_first_compaction: true,
    },
    stop: { status: 'completed', loop_count: 1 },
    beforeTabFileRead: { file_path: '/work/cursor-contract/tab-read.ts', content: 'const tab = true' },
    afterTabFileEdit: { file_path: '/work/cursor-contract/tab-edit.ts', edits: [{ old_string: 'a', new_string: 'b', old_line: 1, new_line: 1 }] },
    workspaceOpen: {},
  };
  return fields[event];
}

function createStore(): RecorderStore {
  const directory = mkdtempSync(join(tmpdir(), 'afr-contract-'));
  tempDirectories.push(directory);
  return new RecorderStore(join(directory, 'recorder.db'));
}
