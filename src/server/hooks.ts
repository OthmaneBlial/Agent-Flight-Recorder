import type { EventKind, EventStatus, Provider } from '../shared/types.js';
import type { EventInput, SessionInput } from './model.js';
import { RecorderStore } from './store.js';
import { captureFileBoundary } from './snapshots.js';
import {
  eventKindForTool,
  extractCommands,
  extractPaths,
  inferResultStatus,
  outputText,
  projectName,
  stableId,
  summarize,
} from './adapters/helpers.js';

type JsonRecord = Record<string, unknown>;

export interface HookReceipt {
  sessionId: string;
  eventId: string;
  eventIds: string[];
  kind: EventKind;
  status: EventStatus;
  snapshots: number;
  gapEventIds: string[];
}

export function recordHookEvent(
  store: RecorderStore,
  provider: Provider,
  explicitEvent: string | null,
  payloadValue: unknown,
): HookReceipt {
  store.recordHeartbeat(`hook:${provider}`, explicitEvent ?? 'provider envelope');
  const payload = object(payloadValue);
  if (provider === 'compatible') validateCompatibleEnvelope(payload, explicitEvent);
  const eventName = explicitEvent ?? text(payload.hook_event_name) ?? text(payload.event) ?? text(payload.type) ?? 'unknown';
  const nativeSessionId = firstText(payload, ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'composer_id', 'composerId', 'thread_id', 'threadId'])
    ?? `unscoped-${stableId(provider, firstText(payload, ['cwd', 'workspace', 'workspace_path']), new Date().toISOString().slice(0, 10))}`;
  const sessionId = `${provider}:${nativeSessionId}`;
  const timestamp = timestampFor(payload);
  const workspaceRoots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots.filter((value): value is string => typeof value === 'string') : [];
  const cwd = firstText(payload, ['cwd', 'workspace', 'workspace_path', 'project_path', 'projectPath']) ?? workspaceRoots[0] ?? null;
  const existing = store.getSession(sessionId);
  const prompt = firstText(payload, ['prompt', 'user_prompt', 'userPrompt', 'message']);
  const ended = /session.?end|session.?stop|conversation.?end/i.test(eventName);
  const sessionTitle = firstText(payload, ['session_title', 'sessionTitle']);
  const session: SessionInput = {
    id: sessionId,
    provider,
    nativeSessionId,
    title: existing?.title ?? sessionTitle ?? (prompt ? summarize(prompt, 92) : projectName(cwd)),
    startedAt: existing?.startedAt ?? timestamp,
    endedAt: ended ? timestamp : existing?.endedAt ?? null,
    updatedAt: timestamp,
    cwd: cwd ?? existing?.cwd ?? null,
    projectName: existing?.projectName ?? projectName(cwd),
    agentVersion: firstText(payload, ['version', 'agent_version', 'agentVersion', 'cursor_version']) ?? existing?.agentVersion ?? null,
    model: firstText(payload, ['model', 'model_id', 'modelId']) ?? existing?.model ?? null,
    sourcePath: `hook:${provider}:${nativeSessionId}`,
    status: ended ? 'complete' : 'live',
  };
  store.upsertSession(session);

  const batchCalls = /posttoolbatch/i.test(eventName) && Array.isArray(payload.tool_calls) ? payload.tool_calls : null;
  const sequence = store.allocateSequences(sessionId, batchCalls?.length ?? 1);
  const events = batchCalls?.length
    ? batchCalls.map((call, index) => normalizeHook(provider, eventName, { ...payload, ...object(call), hook_event_name: eventName }, sessionId, sequence + index * 10, timestamp))
    : [normalizeHook(provider, eventName, payload, sessionId, sequence, timestamp)];
  let snapshots = 0;
  const gapEventIds: string[] = [];
  for (const event of events) {
    store.insertEventWithMetrics(event);
    if (event.kind === 'file' && event.path) {
      const normalized = object(event.payload);
      const phase = normalized.phase === 'call' && event.status === 'running' ? 'before' : 'after';
      const paths = filePaths(event);
      for (const path of paths) {
        const captured = captureFileBoundary(store, event, session, phase, 'exact', path);
        if (captured.snapshotId) snapshots += 1;
        if (captured.gapEventId) gapEventIds.push(captured.gapEventId);
      }
    }
  }
  store.setLastIngestedAt(new Date().toISOString());
  return { sessionId, eventId: events[0].id, eventIds: events.map((event) => event.id), kind: events[0].kind, status: events[0].status, snapshots, gapEventIds };
}

function validateCompatibleEnvelope(payload: JsonRecord, explicitEvent: string | null): void {
  if (payload.schema !== 'afr.event.v1') throw new Error('Compatible events require schema "afr.event.v1"');
  if (!firstText(payload, ['sessionId', 'session_id'])) throw new Error('Compatible events require sessionId');
  if (!explicitEvent && !firstText(payload, ['event', 'type'])) throw new Error('Compatible events require event');
  const timestamp = payload.timestamp;
  if (typeof timestamp !== 'string' || Number.isNaN(new Date(timestamp).getTime())) throw new Error('Compatible events require an ISO timestamp');
}

function filePaths(event: EventInput): string[] {
  const normalized = object(event.payload);
  const paths = Array.isArray(normalized.paths) ? normalized.paths.filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
  return [...new Set([event.path, ...paths].filter((value): value is string => Boolean(value)))];
}

function normalizeHook(
  provider: Provider,
  eventName: string,
  payload: JsonRecord,
  sessionId: string,
  sequence: number,
  timestamp: string,
): EventInput {
  const lower = eventName.toLowerCase().replace(/[_\s.-]+/g, '');
  const toolName = firstText(payload, ['tool_name', 'toolName', 'tool', 'command_type', 'commandType']) ?? nestedText(payload, ['tool', 'name']) ?? 'tool';
  const toolInput = parseJsonValue(first(payload, ['tool_input', 'toolInput', 'input', 'arguments']) ?? nested(payload, ['tool', 'input']) ?? {});
  const toolOutput = first(payload, ['tool_response', 'toolResponse', 'tool_output', 'toolOutput', 'output', 'result', 'result_json', 'error', 'error_message']);
  const command = /mcp/i.test(eventName) ? extractCommands(toolInput) : firstText(payload, ['command']) ?? extractCommands(toolInput);
  const paths = [...extractPaths(toolInput), ...candidatePaths(payload)];
  const callId = firstText(payload, ['tool_use_id', 'toolUseId', 'call_id', 'callId', 'tool_call_id', 'toolCallId']);
  const requestedStatus = eventStatus(firstText(payload, ['status']));
  const usage = object(payload.usage ?? payload.tokens);
  const common = {
    id: `evt:${stableId('hook', provider, sessionId, sequence, eventName, callId)}`,
    sessionId,
    sequence,
    timestamp,
    durationMs: durationMs(payload),
    actor: actorFor(eventName),
    turnId: firstText(payload, ['turn_id', 'turnId', 'prompt_id', 'promptId', 'generation_id', 'generationId']),
    callId,
    parentId: firstText(payload, ['parent_id', 'parentId', 'parent_agent_id', 'parentAgentId']),
    tokensIn: token(payload, ['input_tokens', 'inputTokens']),
    tokensOut: token(payload, ['output_tokens', 'outputTokens']),
    cachedTokens: token(payload, ['cached_input_tokens', 'cachedTokens', 'cache_read_tokens']),
    costUsd: numeric(first(payload, ['cost_usd', 'costUsd', 'cost'])) ?? numeric(first(usage, ['cost_usd', 'costUsd', 'cost'])),
    command,
    path: paths[0] ?? null,
    raw: payload,
  };

  if (/userprompt|promptsubmit|beforesubmitprompt|afteruserprompt/.test(lower)) {
    const prompt = firstText(payload, ['prompt', 'user_prompt', 'userPrompt', 'message']) ?? outputText(toolInput);
    return { ...common, kind: 'prompt', title: 'Operator prompt', summary: summarize(prompt), status: 'success', actor: 'user', payload: { providerEvent: eventName, prompt } };
  }
  if (lower.includes('permission')) {
    const status = /denied|reject/.test(lower) ? 'blocked' : /approved|allow/.test(lower) ? 'success' : 'running';
    return { ...common, kind: 'permission', title: `Permission · ${toolName}`, summary: summarize(command ?? JSON.stringify(toolInput)), status, payload: { providerEvent: eventName, phase: status === 'running' ? 'request' : 'result', tool: toolName, input: toolInput, decision: first(payload, ['decision', 'permission_decision']) } };
  }
  if (/pretool|beforetool|toolbefore|beforeshell|shellbefore|beforemcp|mcpbefore|beforeread|beforetabfileread|beforefile|toolstart|commandstart/.test(lower)) {
    const kind = /shell|command/.test(lower) ? eventKindForTool('terminal', { command }) : /read/.test(lower) ? 'tool' : /file/.test(lower) ? 'file' : eventKindForTool(toolName, toolInput);
    const resultExpected = !/beforereadfile|beforetabfileread/.test(lower);
    return { ...common, kind, title: hookToolTitle(kind, toolName, resultExpected ? 'started' : 'observed'), summary: summarize(command ?? (paths.join(', ') || JSON.stringify(toolInput))), status: resultExpected ? 'running' : 'neutral', payload: { providerEvent: eventName, phase: 'call', tool: toolName, input: toolInput, paths, resultExpected } };
  }
  if (/afterfileedit|aftertabfileedit|filechanged|fileedit|afteredit|filesaved|filewritten/.test(lower)) {
    return { ...common, kind: 'file', title: 'File mutation', summary: paths.join(', ') || 'File change reported', status: /error|failure/.test(lower) ? 'error' : 'success', payload: { providerEvent: eventName, phase: 'result', paths, edits: payload.edits ?? null, input: toolInput } };
  }
  if (/posttool|aftertool|toolafter|aftershell|shellafter|aftermcp|mcpafter|afterfile|toolend|commandend|toolfailure|toolerror/.test(lower)) {
    const kind = /shell|command/.test(lower) ? eventKindForTool('terminal', { command }) : /file/.test(lower) ? 'file' : eventKindForTool(toolName, toolInput);
    const inferred = inferResultStatus(toolOutput);
    const status: EventStatus = /failure|error/.test(lower) || first(payload, ['error', 'failure']) ? 'error' : requestedStatus ?? inferred;
    return { ...common, kind, title: hookToolTitle(kind, toolName, status === 'error' ? 'failed' : 'completed'), summary: summarize(outputText(toolOutput) || command || JSON.stringify(toolInput)), status, actor: 'runtime', payload: { providerEvent: eventName, phase: 'result', tool: toolName, input: toolInput, output: toolOutput, paths } };
  }
  if (/reason|thinking|thought|analysis/.test(lower)) {
    const reasoning = firstText(payload, ['reasoning', 'text', 'message']) ?? outputText(toolOutput);
    return { ...common, kind: 'reasoning', title: 'Reasoning stage', summary: summarize(reasoning) || 'Reasoning stage reported', status: 'success', actor: 'assistant', payload: { providerEvent: eventName, reasoning } };
  }
  if (/response|assistantmessage|agentmessage|messagedisplay/.test(lower)) {
    const response = firstText(payload, ['response', 'text', 'message', 'delta', 'last_assistant_message']) ?? outputText(toolOutput);
    return { ...common, kind: 'response', title: 'Agent response', summary: summarize(response), status: 'success', actor: 'assistant', payload: { providerEvent: eventName, response } };
  }
  if (/compact|context/.test(lower)) {
    return { ...common, kind: 'context', title: humanize(eventName), summary: summarize(firstText(payload, ['trigger', 'reason', 'message']) ?? 'Context state changed'), status: 'neutral', actor: 'runtime', payload: { providerEvent: eventName, ...payload } };
  }
  if (/error|failure/.test(lower)) {
    return { ...common, kind: 'error', title: humanize(eventName), summary: summarize(outputText(toolOutput) || firstText(payload, ['message']) || 'Provider reported a failure'), status: 'error', actor: 'runtime', payload: { providerEvent: eventName, ...payload } };
  }
  const lifecycleStatus: EventStatus = /start|resume/.test(lower) ? 'running' : /stop|end|complete/.test(lower) ? 'success' : 'neutral';
  return { ...common, kind: 'lifecycle', title: humanize(eventName), summary: lifecycleSummary(eventName, payload), status: lifecycleStatus, payload: { providerEvent: eventName, ...payload } };
}

function hookToolTitle(kind: EventKind, tool: string, phase: string): string {
  const noun = kind === 'terminal' ? 'Terminal command' : kind === 'test' ? 'Verification run' : kind === 'file' ? 'File operation' : 'Tool';
  return `${noun} ${phase} · ${tool}`;
}

function actorFor(eventName: string): string {
  return /user|prompt/i.test(eventName) ? 'user' : /post|after|result|stop|end/i.test(eventName) ? 'runtime' : 'assistant';
}

function lifecycleSummary(eventName: string, payload: JsonRecord): string {
  return summarize(firstText(payload, ['reason', 'message', 'source', 'agent_type', 'agentType']) ?? `Provider emitted ${eventName}`);
}

function candidatePaths(payload: JsonRecord): string[] {
  const values = ['file_path', 'filePath', 'path', 'workspace_file', 'workspaceFile']
    .map((key) => payload[key])
    .filter((value): value is string => typeof value === 'string');
  return [...new Set(values)];
}

function durationMs(payload: JsonRecord): number | null {
  const direct = numeric(first(payload, ['duration_ms', 'durationMs', 'duration', 'elapsed_ms', 'elapsedMs']));
  if (direct !== null) return direct;
  const start = numeric(first(payload, ['started_at', 'startedAt', 'start_time', 'startTime']));
  const end = numeric(first(payload, ['completed_at', 'completedAt', 'end_time', 'endTime']));
  return start !== null && end !== null ? Math.max(0, end - start) : null;
}

function timestampFor(payload: JsonRecord): string {
  const value = first(payload, ['timestamp', 'created_at', 'createdAt', 'time']);
  const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function token(payload: JsonRecord, keys: string[]): number | null {
  const direct = numeric(first(payload, keys));
  if (direct !== null) return direct;
  const usage = object(payload.usage ?? payload.tokens);
  return numeric(first(usage, keys));
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventStatus(value: string | null): EventStatus | null {
  return value && ['neutral', 'running', 'success', 'error', 'blocked'].includes(value) ? value as EventStatus : null;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function first(record: JsonRecord, keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return null;
}

function firstText(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value;
  }
  return null;
}

function nested(record: JsonRecord, path: string[]): unknown {
  let value: unknown = record;
  for (const key of path) value = object(value)[key];
  return value;
}

function nestedText(record: JsonRecord, path: string[]): string | null {
  return text(nested(record, path));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}
