import { DatabaseSync } from 'node:sqlite';
import type { EventStatus } from '../../shared/types.js';
import type { EventInput, SessionInput } from '../model.js';
import { sqliteSourceStat } from '../discovery.js';
import type { RecorderStore } from '../store.js';
import { recordHistoricalSnapshotGap } from '../snapshots.js';
import { eventKindForTool, extractCommands, extractPaths, projectName, stableId, summarize } from './helpers.js';
import type { ImportStats } from './codex.js';

type NativeRow = Record<string, string | number | bigint | null>;
type JsonRecord = Record<string, unknown>;
const OPENCODE_ADAPTER_VERSION = 3;

export function importOpenCodeDatabase(sourcePath: string, store: RecorderStore): ImportStats {
  const stat = sqliteSourceStat(sourcePath);
  const source = store.getSource(sourcePath);
  if (source && source.adapterVersion === OPENCODE_ADAPTER_VERSION && source.size === stat.size && source.mtimeMs === stat.mtimeMs) {
    return { changed: false, sessionId: null, events: 0 };
  }

  const native = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const sessions = native
      .prepare(`
      SELECT s.*, p.name project_name, p.worktree project_worktree
      FROM session s LEFT JOIN project p ON p.id = s.project_id
      ORDER BY s.time_created ASC
    `)
      .all() as NativeRow[];
    const parts = native.prepare(`
      SELECT p.*, m.data message_data
      FROM part p JOIN message m ON m.id = p.message_id
      WHERE p.session_id = ?
      ORDER BY p.time_created ASC, p.id ASC
    `);

    store.clearSource(sourcePath);
    let events = 0;
    const historicalFileEvents: EventInput[] = [];
    const importedSessionIds: string[] = [];
    store.transaction(() => {
      for (const nativeSession of sessions) {
        const nativeId = String(nativeSession.id);
        const sessionId = `opencode:${nativeId}`;
        const cwd = nullableString(nativeSession.directory) ?? nullableString(nativeSession.project_worktree);
        const startedAt = iso(nativeSession.time_created);
        const updatedAt = iso(nativeSession.time_updated);
        const session: SessionInput = {
          id: sessionId,
          provider: 'opencode',
          nativeSessionId: nativeId,
          title: nullableString(nativeSession.title) ?? nullableString(nativeSession.slug) ?? projectName(cwd),
          startedAt,
          endedAt: nativeSession.time_archived ? iso(nativeSession.time_archived) : null,
          updatedAt,
          cwd,
          projectName: nullableString(nativeSession.project_name) ?? projectName(cwd),
          agentVersion: nullableString(nativeSession.version),
          model: modelName(nativeSession.model),
          sourcePath,
          status: Date.now() - new Date(updatedAt).getTime() < 60_000 ? 'live' : nativeSession.time_archived ? 'complete' : 'unknown',
        };
        store.upsertSession(session);
        importedSessionIds.push(sessionId);

        let sequence = 0;
        let totalInput = 0;
        let totalOutput = 0;
        let totalCached = 0;
        if (nativeSession.permission) {
          const permission = parseJson(String(nativeSession.permission));
          const event = baseEvent(sessionId, ++sequence, startedAt, String(nativeSession.id));
          if (
            store.insertEvent({
              ...event,
              kind: 'permission',
              title: 'Session permission policy',
              summary: summarize(JSON.stringify(permission)),
              status: 'neutral',
              actor: 'runtime',
              payload: permission,
              raw: permission,
            })
          )
            events += 1;
        }

        for (const row of parts.all(nativeId) as NativeRow[]) {
          const data = parseJson(String(row.data)) as JsonRecord;
          const message = parseJson(String(row.message_data)) as JsonRecord;
          const timestamp = iso(row.time_created);
          const event = mapPart(data, message, sessionId, ++sequence, timestamp, String(row.id), {
            input: totalInput,
            output: totalOutput,
            cached: totalCached,
          });
          if (!event) continue;
          if (event.kind === 'token') {
            totalInput = event.tokensIn ?? totalInput;
            totalOutput = event.tokensOut ?? totalOutput;
            totalCached = event.cachedTokens ?? totalCached;
          }
          if (store.insertEvent(event)) {
            events += 1;
            if (event.kind === 'file') historicalFileEvents.push(event);
          }
        }
      }
    });
    for (const event of historicalFileEvents) {
      if (recordHistoricalSnapshotGap(store, event)) events += 1;
    }
    for (const sessionId of importedSessionIds) {
      store.rebuildCallCorrelations(sessionId);
      store.rebuildPermissionFlows(sessionId);
    }

    store.setSource({
      sourcePath,
      provider: 'opencode',
      sessionId: null,
      byteOffset: stat.size,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      updatedAt: new Date().toISOString(),
      adapterVersion: OPENCODE_ADAPTER_VERSION,
    });
    return { changed: true, sessionId: null, events };
  } finally {
    native.close();
  }
}

function mapPart(
  data: JsonRecord,
  message: JsonRecord,
  sessionId: string,
  sequence: number,
  timestamp: string,
  nativeId: string,
  cumulative: { input: number; output: number; cached: number },
): EventInput | null {
  const type = string(data.type) ?? 'unknown';
  const role = string(message.role) ?? 'assistant';
  const event = baseEvent(sessionId, sequence, timestamp, nativeId);
  if (type === 'text') {
    const text = string(data.text) ?? '';
    return {
      ...event,
      kind: role === 'user' ? 'prompt' : 'response',
      title: role === 'user' ? 'Operator prompt' : 'Agent response',
      summary: summarize(text),
      status: 'success',
      actor: role,
      payload: { role, text },
      raw: data,
    };
  }
  if (type === 'reasoning') {
    const text = string(data.text) ?? '';
    return {
      ...event,
      kind: 'reasoning',
      title: 'Reasoning stage',
      summary: summarize(text) || 'Reasoning stage captured',
      status: 'success',
      actor: 'assistant',
      payload: { text, time: data.time ?? null },
      raw: data,
    };
  }
  if (type === 'tool') {
    const tool = string(data.tool) ?? 'unknown tool';
    const state = object(data.state);
    const input = state.input ?? {};
    const kind = eventKindForTool(tool, input);
    const paths = extractPaths(input);
    const status = toolStatus(string(state.status));
    const title = kind === 'file' ? 'File mutation' : kind === 'test' ? 'Verification run' : kind === 'terminal' ? 'Terminal command' : 'Tool invocation';
    return {
      ...event,
      kind,
      title: `${title} · ${tool}`,
      summary: summarize(string(state.title) ?? extractCommands(input) ?? JSON.stringify(input)),
      status,
      actor: 'assistant',
      callId: string(data.callID),
      durationMs: durationFromState(state),
      command: extractCommands(input),
      path: paths[0] ?? null,
      payload: { phase: 'call', tool, state },
      raw: data,
    };
  }
  if (type === 'step-start') {
    return {
      ...event,
      kind: 'lifecycle',
      title: 'Agent step started',
      summary: 'Model execution step entered',
      status: 'running',
      actor: 'runtime',
      payload: data,
      raw: data,
    };
  }
  if (type === 'step-finish') {
    const tokens = object(data.tokens);
    const input = cumulative.input + number(tokens.input);
    const output = cumulative.output + number(tokens.output) + number(tokens.reasoning);
    const cached = cumulative.cached + number(object(tokens.cache).read) + number(tokens.cache_read);
    return {
      ...event,
      kind: 'token',
      title: 'Agent step completed',
      summary: `${formatNumber(number(tokens.input) + number(tokens.output))} tokens · ${string(data.reason) ?? 'complete'}`,
      status: string(data.reason) === 'error' ? 'error' : 'success',
      actor: 'runtime',
      tokensIn: input,
      tokensOut: output,
      cachedTokens: cached,
      costUsd: number(data.cost),
      payload: { tokens, reason: data.reason ?? null, cumulative: { input, output, cached } },
      raw: data,
    };
  }
  if (type === 'file') {
    const filename = string(data.filename);
    return {
      ...event,
      kind: 'artifact',
      title: 'File artifact attached',
      summary: filename ?? string(data.mime) ?? 'File attachment',
      status: 'success',
      actor: role,
      path: filename,
      payload: data,
      raw: data,
    };
  }
  return {
    ...event,
    kind: 'context',
    title: humanize(type),
    summary: `Native OpenCode ${type} record`,
    status: 'neutral',
    actor: role,
    payload: data,
    raw: data,
  };
}

function baseEvent(
  sessionId: string,
  sequence: number,
  timestamp: string,
  nativeId: string,
): Omit<EventInput, 'kind' | 'title' | 'summary' | 'status' | 'actor' | 'payload'> {
  return {
    id: `evt:${stableId('opencode', sessionId, nativeId, sequence)}`,
    sessionId,
    sequence: sequence * 10,
    timestamp,
    durationMs: null,
    turnId: null,
    callId: null,
    parentId: null,
    tokensIn: null,
    tokensOut: null,
    cachedTokens: null,
    costUsd: null,
    command: null,
    path: null,
  };
}

function toolStatus(status: string | null): EventStatus {
  if (status === 'completed') return 'success';
  if (status === 'error') return 'error';
  if (status === 'pending' || status === 'running') return 'running';
  return 'neutral';
}

function durationFromState(state: JsonRecord): number | null {
  const time = object(state.time);
  const start = number(time.start);
  const end = number(time.end);
  return start && end ? Math.max(0, end - start) : null;
}

function modelName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const model = object(value);
  const provider = string(model.providerID) ?? string(model.provider);
  const id = string(model.modelID) ?? string(model.id);
  return [provider, id].filter(Boolean).join('/') || null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: unknown): string {
  const parsed = number(value);
  const date = new Date(parsed > 0 && parsed < 10_000_000_000 ? parsed * 1000 : parsed || Date.now());
  return date.toISOString();
}

function humanize(value: string): string {
  return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}
