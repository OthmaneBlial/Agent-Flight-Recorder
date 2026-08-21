import { createHash } from 'node:crypto';
import type { RecorderEvent } from '../shared/types.js';

type JsonRecord = Record<string, unknown>;

export function callSignature(event: RecorderEvent): string {
  const payload = object(event.payload);
  const state = object(payload.state);
  const command = normalizeText(event.command);
  const tool = normalizeTool(payload.tool ?? payload.tools ?? state.tool);
  const input = command ? null : payload.input ?? state.input ?? null;
  return hash({ kind: event.kind, tool: command ? null : tool, command, path: event.path, input });
}

export function callCorrelationKey(event: RecorderEvent): string {
  const payload = object(event.payload);
  const state = object(payload.state);
  const command = normalizeText(event.command);
  const tool = normalizeTool(payload.tool ?? payload.tools ?? state.tool);
  const input = command || event.path ? null : payload.input ?? state.input ?? null;
  return hash({ kind: event.kind, tool: command || event.path ? null : tool, command, path: event.path, input });
}

export function permissionSignature(event: RecorderEvent): string {
  return hashInvocation(event, false);
}

function hashInvocation(event: RecorderEvent, includeKind: boolean): string {
  const payload = object(event.payload);
  const state = object(payload.state);
  const tool = payload.tool ?? payload.tools ?? state.tool ?? null;
  const input = payload.input ?? state.input ?? null;
  return hash({
    kind: includeKind ? event.kind : null,
    tool: normalizeTool(tool),
    command: normalizeText(event.command),
    path: event.path,
    input,
  });
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value, 0));
}

function sortValue(value: unknown, depth: number): unknown {
  if (depth > 40) return '[max-depth]';
  if (Array.isArray(value)) return value.map((entry) => sortValue(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortValue(entry, depth + 1)]));
}

function normalizeText(value: string | null): string | null {
  return value?.replace(/\r\n/g, '\n').trim() || null;
}

function normalizeTool(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTool);
  if (typeof value !== 'string') return value ?? null;
  return value.trim().toLowerCase().replace(/^(?:mcp:|mcp__)/, 'mcp:') || null;
}

function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
