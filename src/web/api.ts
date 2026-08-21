import type {
  CallLineage,
  CaptureHealth,
  CodeEvolution,
  EventKind,
  EvidencePolicySummary,
  Overview,
  PermissionTrace,
  RecorderEvent,
  RecordedSession,
  SessionComparison,
  SourceHealth,
} from '../shared/types';

export interface Health {
  ok: boolean;
  mode: 'loopback-only';
  evidenceScope: 'sandbox' | 'private';
  nativeIngestEnabled: boolean;
  sources: SourceHealth[];
  capture: CaptureHealth & { evidencePolicy: EvidencePolicySummary };
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text();
      let message = `${response.status} ${response.statusText}`;
      try {
        const payload = JSON.parse(body) as { error?: unknown; requestId?: unknown };
        if (typeof payload.error === 'string') message = payload.error;
        if (typeof payload.requestId === 'string') message += ` (request ${payload.requestId.slice(0, 8)})`;
      } catch {
        if (body.trim()) message = body.trim().slice(0, 300);
      }
      throw new Error(message);
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw new Error(`The local recorder did not respond within ${Math.round(timeoutMs / 1_000)} seconds.`);
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export const api = {
  health: () => request<Health>('/api/health'),
  overview: () => request<Overview>('/api/overview'),
  sessions: () => request<RecordedSession[]>('/api/sessions?limit=200'),
  events: (sessionId: string) => request<RecorderEvent[]>(`/api/sessions/${encodeURIComponent(sessionId)}/events?limit=100000`),
  event: (eventId: string) => request<RecorderEvent>(`/api/events/${encodeURIComponent(eventId)}`),
  evolution: (eventId: string, path?: string) =>
    request<CodeEvolution>(`/api/events/${encodeURIComponent(eventId)}/evolution${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  lineage: (eventId: string) => request<CallLineage>(`/api/events/${encodeURIComponent(eventId)}/lineage`),
  permissions: (eventId: string) => request<PermissionTrace>(`/api/events/${encodeURIComponent(eventId)}/permissions`),
  compare: (leftId: string, rightId: string) =>
    request<SessionComparison>(`/api/compare?left=${encodeURIComponent(leftId)}&right=${encodeURIComponent(rightId)}`),
  scan: () => request('/api/scan', { method: 'POST' }, 5 * 60_000),
};

export const FILTERS: Array<{ id: 'all' | EventKind; label: string }> = [
  { id: 'all', label: 'All signals' },
  { id: 'prompt', label: 'Prompts' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'response', label: 'Responses' },
  { id: 'tool', label: 'Tools' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'file', label: 'Files' },
  { id: 'test', label: 'Tests' },
  { id: 'permission', label: 'Permissions' },
  { id: 'token', label: 'Tokens' },
  { id: 'retry', label: 'Retries' },
  { id: 'gap', label: 'Gaps' },
  { id: 'context', label: 'Context' },
  { id: 'lifecycle', label: 'Lifecycle' },
  { id: 'artifact', label: 'Artifacts' },
  { id: 'error', label: 'Failures' },
];
