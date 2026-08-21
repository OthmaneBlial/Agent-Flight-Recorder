import type { FileSnapshot, Provider, RecorderEvent, RecordedSession } from '../shared/types.js';

export interface SessionInput {
  id: string;
  provider: Provider;
  nativeSessionId: string;
  title: string;
  startedAt: string;
  endedAt?: string | null;
  updatedAt: string;
  cwd?: string | null;
  projectName: string;
  agentVersion?: string | null;
  model?: string | null;
  sourcePath: string;
  status: RecordedSession['status'];
}

export interface EventInput extends Omit<RecorderEvent, 'payload'> {
  payload: unknown;
  raw?: unknown;
}

export interface SourceState {
  sourcePath: string;
  provider: Provider;
  sessionId: string | null;
  byteOffset: number;
  size: number;
  mtimeMs: number;
  updatedAt: string;
  adapterVersion: number;
}

export interface FileSnapshotInput {
  id: string;
  eventId: string;
  sessionId: string;
  sequence: number;
  path: string;
  phase: 'before' | 'after' | 'observed';
  status: 'captured' | 'missing' | 'skipped' | 'error' | 'pruned';
  assurance: 'exact' | 'best-effort' | 'reconstructed';
  reason?: string | null;
  hash?: string | null;
  byteSize?: number | null;
  mime?: string | null;
  fileMtimeMs?: number | null;
  createdAt: string;
}

export interface RetentionOptions {
  rawBefore?: string | null;
  snapshotsBefore?: string | null;
  apply?: boolean;
}

export interface RetentionResult {
  rawEvents: number;
  snapshots: number;
  blobs: number;
  applied: boolean;
}

export interface SnapshotEvidence {
  snapshot: FileSnapshot;
  contentBase64: string | null;
}
