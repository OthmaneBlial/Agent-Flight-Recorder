export type Provider = 'codex' | 'claude' | 'cursor' | 'opencode' | 'compatible';

export type EventKind =
  | 'prompt'
  | 'reasoning'
  | 'response'
  | 'tool'
  | 'terminal'
  | 'file'
  | 'test'
  | 'permission'
  | 'token'
  | 'retry'
  | 'gap'
  | 'context'
  | 'lifecycle'
  | 'error'
  | 'artifact';

export type EventStatus = 'neutral' | 'running' | 'success' | 'error' | 'blocked';

export interface RecorderEvent {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  durationMs: number | null;
  kind: EventKind;
  title: string;
  summary: string;
  status: EventStatus;
  actor: string | null;
  turnId: string | null;
  callId: string | null;
  parentId: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  command: string | null;
  path: string | null;
  payload: unknown;
  raw?: unknown;
}

export interface SessionMetrics {
  totalEvents: number;
  toolCalls: number;
  fileChanges: number;
  terminalCommands: number;
  testRuns: number;
  errors: number;
  retries: number;
  captureGaps: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costUsd: number;
}

export interface RecordedSession {
  id: string;
  provider: Provider;
  nativeSessionId: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  cwd: string | null;
  projectName: string;
  agentVersion: string | null;
  model: string | null;
  sourcePath: string;
  status: 'live' | 'complete' | 'unknown';
  metrics: SessionMetrics;
}

export interface Overview {
  schemaVersion: number;
  sessions: number;
  events: number;
  providers: Partial<Record<Provider, number>>;
  lastIngestedAt: string | null;
  dataPath: string;
  networkMode: 'loopback-only';
  snapshots: number;
  captureGaps: number;
  evidencePolicy: EvidencePolicySummary;
  storageSecurity: {
    directoryMode: string | null;
    databaseMode: string | null;
    databaseEncryption: 'aes-256-gcm-sensitive-columns';
    keyProvider: 'environment' | 'macos-keychain' | 'protected-key-file';
    keyFingerprint: string;
    plaintextMetadata: true;
    boundary: 'local-user-filesystem';
  };
}

export interface SessionComparison {
  left: Pick<RecordedSession, 'id' | 'title' | 'provider' | 'startedAt' | 'updatedAt'>;
  right: Pick<RecordedSession, 'id' | 'title' | 'provider' | 'startedAt' | 'updatedAt'>;
  durationDeltaMs: number;
  metricDelta: SessionMetrics;
  kindDelta: Partial<Record<EventKind, number>>;
  files: { shared: string[]; leftOnly: string[]; rightOnly: string[] };
}

export interface EvidencePolicySummary {
  redactionMode: 'off' | 'mask' | 'strict';
  rawRetentionDays: number | null;
  snapshotRetentionDays: number | null;
  snapshotMaxBytes: number;
  sensitiveFilePolicy: 'skip';
}

export interface FileSnapshot {
  id: string;
  eventId: string;
  sessionId: string;
  sequence: number;
  path: string;
  phase: 'before' | 'after' | 'observed';
  status: 'captured' | 'missing' | 'skipped' | 'error' | 'pruned';
  assurance: 'exact' | 'best-effort' | 'reconstructed';
  reason: string | null;
  hash: string | null;
  byteSize: number | null;
  mime: string | null;
  createdAt: string;
}

export interface CodeEvolution {
  eventId: string;
  path: string | null;
  availablePaths: string[];
  before: FileSnapshot | null;
  after: FileSnapshot | null;
  unifiedDiff: string | null;
  diffTruncated: boolean;
  changed: boolean | null;
  gaps: Array<{ code: string; message: string; eventId: string }>;
}

export interface SourceHealth {
  provider: Provider;
  available: boolean;
  path: string;
  detail: string;
}

export interface CaptureHealth {
  status: 'idle' | 'healthy' | 'degraded';
  fileEvents: number;
  coveredFileEvents: number;
  uncoveredFileEvents: number;
  snapshots: Record<'captured' | 'missing' | 'skipped' | 'error' | 'pruned', number> & { total: number };
  gaps: { total: number; byCode: Record<string, number> };
  calls: { pending: number; stale: number };
  permissions: { pending: number; unknown: number; explicitDenials: number; inferredExecutions: number };
  delivery: {
    components: Array<{ component: string; lastSeenAt: string; ageMs: number; state: 'active' | 'idle' }>;
    limitation: string;
  };
}

export interface CallAttempt {
  eventId: string;
  sessionId: string;
  callId: string | null;
  signature: string;
  correlationKey: string;
  attempt: number;
  previousEventId: string | null;
  resultEventId: string | null;
  outcome: 'running' | 'success' | 'error' | 'blocked' | 'unknown';
  startedAt: string;
  completedAt: string | null;
  startObserved: boolean;
  facets: number;
}

export interface CallLineage {
  eventId: string;
  current: CallAttempt | null;
  attempts: CallAttempt[];
}

export interface PermissionFlow {
  requestEventId: string;
  sessionId: string;
  signature: string | null;
  callId: string | null;
  tool: string | null;
  outcome: 'pending' | 'allowed' | 'denied' | 'executed' | 'unknown' | 'policy';
  assurance: 'explicit' | 'inferred' | 'unresolved' | 'policy';
  decisionEventId: string | null;
  requestedAt: string;
  decidedAt: string | null;
  providerEvent: string | null;
  reason: string | null;
}

export interface PermissionTrace {
  eventId: string;
  current: PermissionFlow | null;
  flows: PermissionFlow[];
}

export interface ScanResult {
  sourcesVisited: number;
  sourcesChanged: number;
  sessionsImported: number;
  eventsImported: number;
  errors: Array<{ path: string; message: string }>;
  retention?: { rawEvents: number; snapshots: number; blobs: number; applied: boolean };
}
