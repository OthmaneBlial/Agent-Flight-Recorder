import { createReadStream, statSync } from 'node:fs';
import type { EventKind, EventStatus } from '../../shared/types.js';
import type { EventInput, SessionInput } from '../model.js';
import { RecorderStore } from '../store.js';
import { captureFileBoundary, recordHistoricalSnapshotGap } from '../snapshots.js';
import {
  eventKindForTool,
  extractCommands,
  extractPaths,
  inferResultStatus,
  outputText,
  projectName,
  stableId,
  summarize,
  textFromContent,
  toolNames,
} from './helpers.js';

type JsonRecord = Record<string, unknown>;
const CODEX_ADAPTER_VERSION = 5;

interface CallDescriptor {
  kind: EventKind;
  title: string;
  command: string | null;
  path: string | null;
  paths: string[];
  timestamp: string;
}

export interface ImportStats {
  changed: boolean;
  sessionId: string | null;
  events: number;
}

export async function importCodexFile(sourcePath: string, store: RecorderStore): Promise<ImportStats> {
  const stat = statSync(sourcePath);
  let source = store.getSource(sourcePath);
  if (source && source.adapterVersion !== CODEX_ADAPTER_VERSION) {
    store.clearSource(sourcePath);
    source = null;
  }
  if (source && source.byteOffset === stat.size && source.size === stat.size && source.mtimeMs === stat.mtimeMs) {
    return { changed: false, sessionId: source.sessionId, events: 0 };
  }
  if (source && (stat.size < source.byteOffset || !source.sessionId || !store.getSession(source.sessionId))) {
    store.clearSource(sourcePath);
    source = null;
  }

  const start = source?.byteOffset ?? 0;
  let consumedOffset = start;
  let buffer = Buffer.alloc(0);
  let sessionId = source?.sessionId ?? null;
  let session = sessionId ? store.getSession(sessionId) : null;
  let sessionInput: SessionInput | null = session
    ? {
        ...session,
        nativeSessionId: session.nativeSessionId,
        sourcePath,
      }
    : null;
  let inserted = 0;
  const calls = new Map<string, CallDescriptor>();
  let fallbackOrdinal = start > 0 ? Math.floor(start / 10) : 0;

  const processLine = (line: Buffer): void => {
    const text = line.toString('utf8').trim();
    if (!text) return;
    let record: JsonRecord;
    try {
      record = JSON.parse(text) as JsonRecord;
    } catch {
      return;
    }
    const payload = object(record.payload);
    if (record.type === 'session_meta' && !sessionId) {
      const nativeId = string(payload.id) || string(payload.session_id) || stableId(sourcePath);
      sessionId = `codex:${nativeId}`;
      const cwd = string(payload.cwd);
      const timestamp = iso(record.timestamp ?? payload.timestamp);
      sessionInput = {
        id: sessionId,
        provider: 'codex',
        nativeSessionId: nativeId,
        title: projectName(cwd),
        startedAt: timestamp,
        updatedAt: timestamp,
        cwd,
        projectName: projectName(cwd),
        agentVersion: string(payload.cli_version),
        model: string(payload.model_provider),
        sourcePath,
        status: 'live',
      };
      store.upsertSession(sessionInput);
    }
    if (!sessionId || !sessionInput) return;

    const ordinal = finiteNumber(record.ordinal) ?? ++fallbackOrdinal;
    const sequence = ordinal * 10;
    const mapped = mapCodexRecord(record, sessionId, sequence, calls);
    for (const event of mapped) {
      if (payloadTypeIsToolOutput(payload) && event.callId && event.kind === 'tool') {
        const invocation = store.getCallInvocation(sessionId, event.callId);
        if (invocation) {
          event.kind = invocation.kind;
          event.title = `${invocation.title} result`;
          event.command = invocation.command;
          event.path = invocation.path;
          event.payload = { ...object(event.payload), paths: payloadPaths(invocation.payload) };
        }
      }
      if (store.insertEventWithMetrics(event)) {
        inserted += 1;
        if (event.kind === 'file' && event.path) {
          const normalized = object(event.payload);
          for (const path of eventPaths(event)) {
            if (start > 0) {
              const phase = normalized.phase === 'call' ? 'before' : 'after';
              captureFileBoundary(store, event, sessionInput, phase, 'best-effort', path);
              if (phase === 'before') store.insertCaptureGap(event, 'best_effort_pre_state', 'Codex was observed through its append-only log; the captured pre-state may already include the completed mutation.', path);
            } else if (normalized.phase === 'call' || !event.callId || !store.getCallInvocation(sessionId, event.callId)) {
              recordHistoricalSnapshotGap(store, { ...event, path });
            }
          }
        }
      }
    }

    const timestamp = iso(record.timestamp);
    sessionInput.updatedAt = timestamp;
    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const content = textFromContent(payload.content);
      if (isUsefulTitle(content) && sessionInput.title === sessionInput.projectName) sessionInput.title = summarize(content, 92);
    }
  };

  if (start < stat.size) {
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(sourcePath, { start, end: stat.size - 1 });
      stream.on('data', (chunk: Buffer | string) => {
        buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
        let newline = buffer.indexOf(10);
        while (newline >= 0) {
          const line = buffer.subarray(0, newline);
          processLine(line);
          consumedOffset += newline + 1;
          buffer = buffer.subarray(newline + 1);
          newline = buffer.indexOf(10);
        }
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  }

  if (!sessionId || !sessionInput) throw new Error('Codex source has no session metadata');
  store.upsertSession(sessionInput);
  store.refreshSessionMetrics(sessionId);
  store.setSource({
    sourcePath,
    provider: 'codex',
    sessionId,
    byteOffset: consumedOffset,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    updatedAt: new Date().toISOString(),
    adapterVersion: CODEX_ADAPTER_VERSION,
  });
  return { changed: true, sessionId, events: inserted };
}

function payloadTypeIsToolOutput(payload: JsonRecord): boolean {
  return payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output';
}

function mapCodexRecord(
  record: JsonRecord,
  sessionId: string,
  sequence: number,
  calls: Map<string, CallDescriptor>,
): EventInput[] {
  const payload = object(record.payload);
  const type = string(record.type) ?? 'unknown';
  const payloadType = string(payload.type);
  const timestamp = iso(record.timestamp);
  const base = {
    sessionId,
    sequence,
    timestamp,
    durationMs: null,
    actor: null,
    turnId: string(payload.turn_id),
    callId: string(payload.call_id),
    parentId: null,
    tokensIn: null,
    tokensOut: null,
    cachedTokens: null,
    costUsd: null,
    command: null,
    path: null,
    raw: record,
  };
  const id = (suffix = '') => `evt:${stableId(sessionId, sequence, suffix)}`;

  if (type === 'session_meta') {
    return [{ ...base, id: id(), kind: 'lifecycle', title: 'Recorder attached', summary: `Codex ${string(payload.cli_version) ?? 'unknown version'} · ${string(payload.cwd) ?? 'unknown workspace'}`, status: 'success', actor: 'codex', payload }];
  }
  if (type === 'turn_context') {
    return [{
      ...base,
      id: id(),
      kind: 'permission',
      title: 'Execution policy applied',
      summary: `${string(payload.approval_policy) ?? 'unknown approval'} · ${policyName(payload.sandbox_policy)}`,
      status: 'neutral',
      actor: 'runtime',
      turnId: string(payload.turn_id),
      payload: compactPayload(payload, ['approval_policy', 'sandbox_policy', 'cwd', 'workspace_roots', 'model', 'effort', 'collaboration_mode']),
    }];
  }
  if (type === 'world_state') {
    return [{ ...base, id: id(), kind: 'context', title: 'Workspace state captured', summary: payload.full === true ? 'Full workspace state snapshot' : 'Workspace state delta', status: 'neutral', actor: 'runtime', payload }];
  }
  if (type === 'response_item' && payloadType === 'message') {
    const role = string(payload.role) ?? 'unknown';
    const content = textFromContent(payload.content);
    const kind = role === 'user' ? 'prompt' : role === 'assistant' ? 'response' : 'context';
    const title = role === 'user' ? 'Operator prompt' : role === 'assistant' ? (payload.phase === 'commentary' ? 'Agent progress update' : 'Agent response') : `${capitalize(role)} instruction`;
    return [{ ...base, id: id(), kind, title, summary: summarize(content) || 'Empty message', status: 'success', actor: role, payload: { role, phase: payload.phase ?? null, content } }];
  }
  if (type === 'response_item' && payloadType === 'reasoning') {
    const summary = textFromContent(payload.summary);
    const encryptedLength = typeof payload.encrypted_content === 'string' ? payload.encrypted_content.length : 0;
    return [{ ...base, id: id(), kind: 'reasoning', title: 'Reasoning stage', summary: summary || `Encrypted reasoning payload · ${formatBytes(encryptedLength)}`, status: 'success', actor: 'assistant', payload: { summary, encryptedBytes: encryptedLength } }];
  }
  if (type === 'response_item' && (payloadType === 'custom_tool_call' || payloadType === 'function_call')) {
    const name = string(payload.name) ?? 'unknown tool';
    const input = payload.input ?? parseJson(string(payload.arguments)) ?? payload.arguments ?? {};
    const names = toolNames(name, input);
    const command = extractCommands(input);
    const paths = extractPaths(input);
    const kind = eventKindForTool(names.join(' '), input);
    const callId = string(payload.call_id) ?? string(payload.id) ?? stableId(sessionId, sequence);
    const descriptor: CallDescriptor = { kind, title: toolTitle(kind, names), command, path: paths[0] ?? null, paths, timestamp };
    calls.set(callId, descriptor);
    const action: EventInput = {
      ...base,
      id: id(),
      kind,
      title: descriptor.title,
      summary: summarize(command ?? paths.join(', ') ?? JSON.stringify(input)),
      status: 'running',
      actor: 'assistant',
      callId,
      command,
      path: paths[0] ?? null,
      payload: { phase: 'call', tools: names, input, paths },
    };
    if (!requestsEscalation(input)) return [action];
    const permission: EventInput = {
      ...base,
      id: id('permission'),
      sequence: sequence - 0.001,
      kind: 'permission',
      title: `Permission requested · ${names.join(' + ') || name}`,
      summary: summarize(command ?? paths.join(', ') ?? JSON.stringify(input)),
      status: 'running',
      actor: 'assistant',
      callId,
      command,
      path: paths[0] ?? null,
      payload: { phase: 'request', tool: names, input, source: 'sandbox_permissions' },
    };
    return [permission, action];
  }
  if (type === 'response_item' && (payloadType === 'custom_tool_call_output' || payloadType === 'function_call_output')) {
    const callId = string(payload.call_id);
    const descriptor = callId ? calls.get(callId) : undefined;
    const output = payload.output;
    const status = inferResultStatus(output);
    return [{
      ...base,
      id: id(),
      kind: descriptor?.kind ?? 'tool',
      title: `${descriptor?.title ?? 'Tool'} result`,
      summary: summarize(outputText(output)) || (status === 'success' ? 'Completed without textual output' : 'Failed without textual output'),
      status,
      actor: 'runtime',
      callId,
      command: descriptor?.command ?? null,
      path: descriptor?.path ?? null,
      durationMs: descriptor ? Math.max(0, Date.parse(timestamp) - Date.parse(descriptor.timestamp)) : null,
      payload: { phase: 'result', output, paths: descriptor?.paths ?? [] },
    }];
  }
  if (type === 'event_msg' && payloadType === 'token_count') {
    const info = object(payload.info);
    const total = object(info.total_token_usage);
    const last = object(info.last_token_usage);
    return [{
      ...base,
      id: id(),
      kind: 'token',
      title: 'Token meter updated',
      summary: `${formatNumber(finiteNumber(total.total_tokens) ?? 0)} total · +${formatNumber(finiteNumber(last.total_tokens) ?? 0)} last step`,
      status: 'neutral',
      actor: 'runtime',
      tokensIn: finiteNumber(total.input_tokens),
      tokensOut: finiteNumber(total.output_tokens),
      cachedTokens: finiteNumber(total.cached_input_tokens),
      payload: { total, last, contextWindow: info.model_context_window ?? null, rateLimits: payload.rate_limits ?? null },
    }];
  }
  if (type === 'event_msg' && payloadType === 'user_message') {
    const message = string(payload.message) ?? '';
    return [{ ...base, id: id(), kind: 'prompt', title: 'Operator prompt', summary: summarize(message) || 'Empty prompt', status: 'success', actor: 'user', payload: { message, images: payload.images ?? [], localImages: payload.local_images ?? [], textElements: payload.text_elements ?? [] } }];
  }
  if (type === 'event_msg' && payloadType === 'agent_message') {
    const message = string(payload.message) ?? '';
    const phase = string(payload.phase);
    return [{ ...base, id: id(), kind: 'response', title: phase === 'commentary' ? 'Agent progress update' : 'Agent response', summary: summarize(message) || 'Empty response', status: 'success', actor: 'assistant', payload: { message, phase, memoryCitation: payload.memory_citation ?? null } }];
  }
  if (type === 'event_msg' && payloadType === 'exec_command_end') {
    const command = nativeCommand(payload.command);
    const input = { command, cwd: string(payload.cwd) };
    const status = commandResultStatus(payload);
    return [{
      ...base, id: id(), kind: eventKindForTool('exec_command', input), title: `${toolTitle(eventKindForTool('exec_command', input), ['exec_command'])} result`,
      summary: summarize(nativeOutput(payload)) || `Command ${status}`, status, actor: 'runtime', callId: string(payload.call_id), command,
      durationMs: nativeDurationMs(payload.duration), payload: { phase: 'result', tool: 'exec_command', input, output: nativeOutput(payload), exitCode: finiteNumber(payload.exit_code), processId: payload.process_id ?? null },
    }];
  }
  if (type === 'event_msg' && payloadType === 'patch_apply_end') {
    const changes = object(payload.changes);
    const paths = Object.keys(changes);
    const status: EventStatus = payload.success === false || string(payload.status) === 'failed' ? 'error' : 'success';
    return [{
      ...base, id: id(), kind: 'file', title: 'File mutation result · apply_patch', summary: summarize(paths.join(', ') || nativeOutput(payload)) || `Patch ${status}`,
      status, actor: 'runtime', callId: string(payload.call_id), path: paths[0] ?? null,
      payload: { phase: 'result', tool: 'apply_patch', input: { paths }, output: nativeOutput(payload), paths, changes },
    }];
  }
  if (type === 'event_msg' && payloadType === 'view_image_tool_call') {
    const path = string(payload.path);
    return [{ ...base, id: id(), kind: 'tool', title: 'Tool invocation · view_image', summary: path ?? 'Image inspection', status: 'running', actor: 'assistant', callId: string(payload.call_id), path, payload: { phase: 'call', tool: 'view_image', input: { path }, paths: path ? [path] : [] } }];
  }
  if (type === 'event_msg' && payloadType === 'web_search_call') {
    const input = payload.action ?? {};
    return [{ ...base, id: id(), kind: 'tool', title: 'Tool invocation · web_search', summary: summarize(JSON.stringify(input)), status: 'running', actor: 'assistant', payload: { phase: 'call', tool: 'web_search', input } }];
  }
  if (type === 'event_msg' && payloadType === 'web_search_end') {
    const input = payload.action ?? {};
    return [{ ...base, id: id(), kind: 'tool', title: 'Tool invocation · web_search result', summary: summarize(JSON.stringify(input)), status: 'success', actor: 'runtime', callId: string(payload.call_id), payload: { phase: 'result', tool: 'web_search', input, output: { query: payload.query ?? null } } }];
  }
  if (type === 'event_msg' && payloadType === 'tool_search_call') {
    const input = payload.arguments ?? {};
    return [{ ...base, id: id(), kind: 'tool', title: 'Tool invocation · tool_search', summary: summarize(JSON.stringify(input)), status: 'running', actor: 'assistant', callId: string(payload.call_id), payload: { phase: 'call', tool: 'tool_search', input, execution: payload.execution ?? null } }];
  }
  if (type === 'event_msg' && payloadType === 'tool_search_output') {
    const input = {};
    return [{ ...base, id: id(), kind: 'tool', title: 'Tool invocation · tool_search result', summary: `${Array.isArray(payload.tools) ? payload.tools.length : 0} tools returned`, status: string(payload.status) === 'failed' ? 'error' : 'success', actor: 'runtime', callId: string(payload.call_id), payload: { phase: 'result', tool: 'tool_search', input, output: payload.tools ?? [], execution: payload.execution ?? null } }];
  }
  if (type === 'event_msg' && payloadType === 'mcp_tool_call_end') {
    const invocation = object(payload.invocation);
    const tool = `mcp__${string(invocation.server) ?? 'unknown'}__${string(invocation.tool) ?? 'unknown'}`;
    const input = invocation.arguments ?? {};
    const result = payload.result ?? null;
    return [{ ...base, id: id(), kind: 'tool', title: `Tool invocation · ${tool} result`, summary: summarize(outputText(result)), status: inferResultStatus(result), actor: 'runtime', callId: string(payload.call_id), durationMs: nativeDurationMs(payload.duration), payload: { phase: 'result', tool, input, output: result, connectorId: payload.connector_id ?? null } }];
  }
  if (type === 'event_msg' && payloadType === 'task_started') {
    return [{ ...base, id: id(), kind: 'lifecycle', title: 'Agent turn started', summary: `Turn ${string(payload.turn_id)?.slice(0, 8) ?? 'unknown'} · ${formatNumber(finiteNumber(payload.model_context_window) ?? 0)} token context`, status: 'running', actor: 'runtime', payload }];
  }
  if (type === 'event_msg' && payloadType === 'task_complete') {
    return [{ ...base, id: id(), kind: 'lifecycle', title: 'Agent turn completed', summary: summarize(string(payload.last_agent_message) ?? 'Turn complete'), status: 'success', actor: 'runtime', payload }];
  }
  if (type === 'event_msg' && payloadType === 'thread_goal_updated') {
    const goal = object(payload.goal);
    return [{ ...base, id: id(), kind: 'context', title: 'Thread objective updated', summary: summarize(string(goal.objective) ?? 'Objective state changed'), status: 'neutral', actor: 'operator', payload }];
  }
  if (type === 'event_msg' && payloadType === 'item_completed') {
    const item = object(payload.item);
    const duration = Math.max(0, (finiteNumber(payload.completed_at_ms) ?? 0) - (finiteNumber(payload.started_at_ms) ?? 0));
    const itemType = string(item.type) ?? 'item';
    const itemId = string(item.id);
    if (itemType === 'UserMessage' || itemType === 'AgentMessage') {
      const content = textFromContent(item.content);
      const isUser = itemType === 'UserMessage';
      return [{ ...base, id: id(), kind: isUser ? 'prompt' : 'response', title: isUser ? 'Operator prompt completed' : string(item.phase) === 'commentary' ? 'Agent progress completed' : 'Agent response completed', summary: summarize(content) || `Empty ${itemType}`, status: 'success', actor: isUser ? 'user' : 'assistant', durationMs: duration, payload: { item } }];
    }
    if (itemType === 'Reasoning') {
      const summary = Array.isArray(item.summary_text) ? (item.summary_text as unknown[]).filter((value): value is string => typeof value === 'string').join('\n') : '';
      return [{ ...base, id: id(), kind: 'reasoning', title: 'Reasoning stage completed', summary: summarize(summary) || 'Reasoning stage completed', status: 'success', actor: 'assistant', durationMs: duration, payload: { itemType, itemId, summary } }];
    }
    if (itemType === 'CommandExecution') {
      const command = nativeCommand(item.command);
      const input = { command, cwd: string(item.cwd) };
      const kind = eventKindForTool('exec_command', input);
      return [{ ...base, id: id(), kind, title: `${toolTitle(kind, ['exec_command'])} completed`, summary: summarize(nativeOutput(item)) || `Command ${commandResultStatus(item)}`, status: commandResultStatus(item), actor: 'runtime', callId: itemId, command, durationMs: nativeDurationMs(item.duration) ?? duration, payload: { phase: 'result', tool: 'exec_command', input, output: nativeOutput(item), exitCode: finiteNumber(item.exit_code), runtimeItemId: itemId } }];
    }
    if (itemType === 'FileChange') {
      const changes = object(item.changes);
      const paths = Object.keys(changes);
      const status: EventStatus = string(item.status) === 'failed' ? 'error' : 'success';
      return [{ ...base, id: id(), kind: 'file', title: 'File mutation completed', summary: summarize(paths.join(', ') || nativeOutput(item)), status, actor: 'runtime', callId: itemId, path: paths[0] ?? null, durationMs: duration, payload: { phase: 'result', tool: 'apply_patch', input: { paths }, output: nativeOutput(item), paths, changes, runtimeItemId: itemId } }];
    }
    if (itemType === 'ImageView') {
      const path = string(item.path);
      return [{ ...base, id: id(), kind: 'tool', title: 'Tool invocation · view_image result', summary: path ?? 'Image inspection completed', status: 'success', actor: 'runtime', callId: itemId, path, durationMs: duration, payload: { phase: 'result', tool: 'view_image', input: { path }, output: null, runtimeItemId: itemId } }];
    }
    if (itemType === 'McpToolCall') {
      const tool = `mcp__${string(item.server) ?? 'unknown'}__${string(item.tool) ?? 'unknown'}`;
      const input = item.arguments ?? {};
      return [{ ...base, id: id(), kind: 'tool', title: `Tool invocation · ${tool} completed`, summary: summarize(outputText(item.result)), status: inferResultStatus(item.result), actor: 'runtime', callId: itemId, durationMs: nativeDurationMs(item.duration) ?? duration, payload: { phase: 'result', tool, input, output: item.result ?? null, runtimeItemId: itemId } }];
    }
    if (itemType === 'Extension') {
      const input = item.action ?? { query: item.query ?? null };
      return [{ ...base, id: id(), kind: 'tool', title: `Extension completed · ${string(item.kind) ?? 'search'}`, summary: summarize(string(item.query) ?? JSON.stringify(input)), status: 'success', actor: 'runtime', callId: itemId, durationMs: duration, payload: { phase: 'result', tool: string(item.kind) ?? 'extension', input, output: item.results ?? [], runtimeItemId: itemId } }];
    }
    if (itemType === 'ContextCompaction') return [{ ...base, id: id(), kind: 'context', title: 'Context compaction completed', summary: 'Runtime context was compacted', status: 'success', actor: 'runtime', durationMs: duration, payload: { itemType, itemId } }];
    if (itemType === 'Plan') return [{ ...base, id: id(), kind: 'context', title: 'Plan updated', summary: summarize(string(item.text) ?? 'Plan state changed'), status: 'success', actor: 'assistant', durationMs: duration, payload: { item } }];
    if (itemType === 'SubAgentActivity') return [{ ...base, id: id(), kind: 'lifecycle', title: 'Subagent activity completed', summary: `${string(item.kind) ?? 'activity'} · ${string(item.agent_thread_id) ?? 'unknown agent'}`, status: 'success', actor: 'runtime', callId: itemId, durationMs: duration, payload: { item } }];
    if (itemType === 'CollabAgentToolCall') return [{ ...base, id: id(), kind: 'tool', title: `Collaboration tool completed · ${string(item.tool) ?? 'agent tool'}`, summary: summarize(JSON.stringify(item.receiver_agents ?? item.receiver_thread_ids ?? [])), status: string(item.status) === 'failed' ? 'error' : 'success', actor: 'runtime', callId: itemId, durationMs: duration, payload: { phase: 'result', tool: string(item.tool) ?? 'collaboration', input: { receiverAgents: item.receiver_agents ?? [], receiverThreadIds: item.receiver_thread_ids ?? [] }, output: item.agents_states ?? {}, runtimeItemId: itemId } }];
    return [{ ...base, id: id(), kind: 'lifecycle', title: 'Runtime item completed', summary: `${itemType} · ${duration} ms`, status: 'success', actor: 'runtime', durationMs: duration, payload: compactPayload(payload, ['started_at_ms', 'completed_at_ms', 'turn_id', 'item']) }];
  }
  if (type === 'event_msg' && payloadType === 'turn_aborted') {
    return [{ ...base, id: id(), kind: 'error', title: 'Agent turn aborted', summary: summarize(string(payload.reason) ?? 'Turn aborted'), status: 'error', actor: 'runtime', durationMs: finiteNumber(payload.duration_ms), payload }];
  }
  if (type === 'event_msg' && payloadType === 'thread_rolled_back') {
    return [{ ...base, id: id(), kind: 'context', title: 'Thread rolled back', summary: `${finiteNumber(payload.num_turns) ?? 0} turns rolled back`, status: 'success', actor: 'runtime', payload }];
  }
  if (type === 'event_msg' && (payloadType === 'context_compacted' || payloadType === 'thread_settings_applied')) {
    return [{ ...base, id: id(), kind: 'context', title: payloadType === 'context_compacted' ? 'Context compacted' : 'Thread settings applied', summary: payloadType === 'context_compacted' ? 'Runtime context was compacted' : 'Execution settings changed', status: 'success', actor: 'runtime', payload }];
  }
  if (type === 'compacted') {
    return [{ ...base, id: id(), kind: 'context', title: 'Compacted history record', summary: 'Native history compaction boundary', status: 'success', actor: 'runtime', payload }];
  }
  if (type === 'inter_agent_communication_metadata') {
    return [{ ...base, id: id(), kind: 'lifecycle', title: 'Inter-agent communication', summary: 'Native collaboration routing metadata', status: 'success', actor: 'runtime', payload }];
  }
  const title = payloadType ? `${humanize(payloadType)}` : `${humanize(type)}`;
  return [{ ...base, id: id(), kind: 'context', title, summary: `Native ${type} record`, status: 'neutral', actor: 'runtime', payload }];
}

function payloadPaths(payload: unknown): string[] {
  const paths = object(payload).paths;
  return Array.isArray(paths) ? paths.filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
}

function eventPaths(event: EventInput): string[] {
  return [...new Set([event.path, ...payloadPaths(event.payload)].filter((value): value is string => Boolean(value)))];
}

function toolTitle(kind: EventKind, names: string[]): string {
  const label = kind === 'file' ? 'File mutation' : kind === 'test' ? 'Verification run' : kind === 'terminal' ? 'Terminal command' : kind === 'permission' ? 'Permission request' : 'Tool invocation';
  return names.length ? `${label} · ${names.join(' + ')}` : label;
}

function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function iso(value: unknown): string {
  const date = typeof value === 'number' || typeof value === 'string' ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function policyName(value: unknown): string {
  const policy = object(value);
  return string(policy.type) ?? string(policy.mode) ?? summarize(JSON.stringify(policy), 80) ?? 'unknown sandbox';
}

function compactPayload(payload: JsonRecord, keys: string[]): JsonRecord {
  return Object.fromEntries(keys.filter((key) => key in payload).map((key) => [key, payload[key]]));
}

function nativeCommand(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const parts = value.filter((entry): entry is string => typeof entry === 'string');
  const shellFlag = parts.findIndex((entry) => entry === '-c' || entry === '-lc');
  if (shellFlag >= 0 && parts[shellFlag + 1]) return parts[shellFlag + 1];
  return parts.join(' ') || null;
}

function requestsEscalation(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === 'string') return /require_escalated/.test(value);
  const input = object(value);
  return input.sandbox_permissions === 'require_escalated' || input.sandboxPermissions === 'require_escalated';
}

function nativeOutput(value: JsonRecord): string {
  return string(value.formatted_output)
    ?? string(value.aggregated_output)
    ?? [string(value.stdout), string(value.stderr)].filter((entry): entry is string => Boolean(entry)).join('\n')
    ?? '';
}

function nativeDurationMs(value: unknown): number | null {
  const duration = object(value);
  const seconds = finiteNumber(duration.secs);
  const nanos = finiteNumber(duration.nanos);
  if (seconds === null && nanos === null) return null;
  return Math.max(0, (seconds ?? 0) * 1_000 + (nanos ?? 0) / 1_000_000);
}

function commandResultStatus(value: JsonRecord): EventStatus {
  const exitCode = finiteNumber(value.exit_code);
  if ((exitCode !== null && exitCode !== 0) || ['failed', 'error'].includes(string(value.status) ?? '')) return 'error';
  return 'success';
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

function isUsefulTitle(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 2 && !trimmed.startsWith('<') && !trimmed.startsWith('# AGENTS.md');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}
