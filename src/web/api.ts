import type { CallLineage, CaptureHealth, CodeEvolution, EventKind, EvidencePolicySummary, Overview, PermissionTrace, RecorderEvent, RecordedSession, SessionComparison, SourceHealth } from '../shared/types';

export interface Health {
  ok: boolean;
  mode: 'loopback-only';
  sources: SourceHealth[];
  capture: CaptureHealth & { evidencePolicy: EvidencePolicySummary };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<Health>('/api/health'),
  overview: () => request<Overview>('/api/overview'),
  sessions: () => request<RecordedSession[]>('/api/sessions?limit=200'),
  events: (sessionId: string) => request<RecorderEvent[]>(`/api/sessions/${encodeURIComponent(sessionId)}/events?limit=100000`),
  event: (eventId: string) => request<RecorderEvent>(`/api/events/${encodeURIComponent(eventId)}`),
  evolution: (eventId: string, path?: string) => request<CodeEvolution>(`/api/events/${encodeURIComponent(eventId)}/evolution${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  lineage: (eventId: string) => request<CallLineage>(`/api/events/${encodeURIComponent(eventId)}/lineage`),
  permissions: (eventId: string) => request<PermissionTrace>(`/api/events/${encodeURIComponent(eventId)}/permissions`),
  compare: (leftId: string, rightId: string) => request<SessionComparison>(`/api/compare?left=${encodeURIComponent(leftId)}&right=${encodeURIComponent(rightId)}`),
  scan: () => request('/api/scan', { method: 'POST' }),
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
