import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RecorderEvent, RecordedSession } from '../shared/types.js';
import type { EventInput, FileSnapshotInput, SessionInput } from './model.js';
import { redactString } from './policy.js';
import { RecorderStore } from './store.js';

type SnapshotPhase = FileSnapshotInput['phase'];
type SnapshotAssurance = FileSnapshotInput['assurance'];

export interface SnapshotReceipt {
  snapshotId: string | null;
  status: FileSnapshotInput['status'];
  gapEventId: string | null;
  reason: string | null;
}

export function captureFileBoundary(
  store: RecorderStore,
  event: EventInput | RecorderEvent,
  session: SessionInput | RecordedSession,
  phase: SnapshotPhase,
  assurance: SnapshotAssurance,
  pathOverride: string | null = event.path,
): SnapshotReceipt {
  if (!pathOverride) return { snapshotId: null, status: 'skipped', gapEventId: null, reason: 'path_unavailable' };
  const cwd = session.cwd;
  if (!cwd) return failure(store, event, pathOverride, phase, assurance, 'workspace_unknown', 'File content was not captured because the workspace root is unknown.');
  const workspace = resolve(cwd);
  const path = resolvePath(pathOverride, workspace);
  if (!isWithin(workspace, path)) return failure(store, event, path, phase, assurance, 'outside_workspace', 'File content was not captured because the path is outside the recorded workspace.');
  if (store.policy.sensitivePathPatterns.some((pattern) => pattern.test(path))) {
    return failure(store, event, path, phase, assurance, 'sensitive_path', 'File content was intentionally skipped by the sensitive-file policy.');
  }
  if (!existsSync(path)) {
    const snapshot = createSnapshot(event, path, phase, assurance, 'missing', 'file_not_found');
    store.insertFileSnapshot(snapshot);
    return { snapshotId: snapshot.id, status: 'missing', gapEventId: null, reason: 'file_not_found' };
  }
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink()) {
      const realWorkspace = existsSync(workspace) ? realpathSync(workspace) : workspace;
      const realTarget = realpathSync(path);
      if (!isWithin(realWorkspace, realTarget)) return failure(store, event, path, phase, assurance, 'symlink_escape', 'File content was skipped because its symlink target escapes the workspace.');
    }
    const initial = statSync(path);
    if (!initial.isFile()) return failure(store, event, path, phase, assurance, 'not_a_file', 'Snapshot capture supports regular files only.');
    if (initial.size > store.policy.snapshotMaxBytes) {
      return failure(store, event, path, phase, assurance, 'file_too_large', `File exceeds the ${store.policy.snapshotMaxBytes}-byte snapshot limit.`);
    }
    let content = readFileSync(path);
    let final = statSync(path);
    if (initial.mtimeMs !== final.mtimeMs || initial.size !== final.size) {
      content = readFileSync(path);
      final = statSync(path);
    }
    if (content.subarray(0, Math.min(content.length, 8192)).includes(0)) {
      return failure(store, event, path, phase, assurance, 'binary_file', 'Binary file content was not stored; the file action remains in the timeline.');
    }
    const originalText = content.toString('utf8');
    const redactedText = store.policy.redactionMode === 'off' ? originalText : redactString(originalText);
    const contentWasRedacted = redactedText !== originalText;
    const redacted = Buffer.from(redactedText, 'utf8');
    const hash = createHash('sha256').update(redacted).digest('hex');
    const createdAt = new Date().toISOString();
    const mime = textMime(path);
    store.putContentBlob(hash, redacted, mime, 'utf8', createdAt);
    const snapshot = createSnapshot(event, path, phase, assurance, 'captured', contentWasRedacted ? 'content_redacted' : null, hash, redacted.byteLength, mime, final.mtimeMs, createdAt);
    store.insertFileSnapshot(snapshot);
    let gapEventId: string | null = null;
    if ((phase === 'after' || phase === 'observed') && !store.hasBeforeBoundary(event as EventInput, path)) {
      gapEventId = store.insertCaptureGap(event as EventInput, 'before_snapshot_unavailable', 'The resulting file was captured, but no trustworthy before-state was available for this mutation.', path);
    }
    return { snapshotId: snapshot.id, status: 'captured', gapEventId, reason: null };
  } catch (error) {
    return failure(store, event, path, phase, assurance, 'read_error', `Snapshot capture failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function recordHistoricalSnapshotGap(store: RecorderStore, event: EventInput): string | null {
  return store.insertCaptureGap(event, 'historical_snapshot_unavailable', 'This file action was imported after execution; exact before/after file contents were not reconstructed from the current worktree.');
}

function failure(
  store: RecorderStore,
  event: EventInput | RecorderEvent,
  path: string,
  phase: SnapshotPhase,
  assurance: SnapshotAssurance,
  code: string,
  message: string,
): SnapshotReceipt {
  const status: FileSnapshotInput['status'] = code === 'read_error' ? 'error' : 'skipped';
  const snapshot = createSnapshot(event, path, phase, assurance, status, code);
  store.insertFileSnapshot(snapshot);
  const gapEventId = store.insertCaptureGap(event as EventInput, code, message, path);
  return { snapshotId: snapshot.id, status, gapEventId, reason: code };
}

function createSnapshot(
  event: EventInput | RecorderEvent,
  path: string,
  phase: SnapshotPhase,
  assurance: SnapshotAssurance,
  status: FileSnapshotInput['status'],
  reason: string | null,
  hash: string | null = null,
  byteSize: number | null = null,
  mime: string | null = null,
  fileMtimeMs: number | null = null,
  createdAt = new Date().toISOString(),
): FileSnapshotInput {
  return {
    id: `snap:${createHash('sha256').update(`${event.id}\u001f${path}\u001f${phase}`).digest('hex').slice(0, 24)}`,
    eventId: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    path,
    phase,
    status,
    assurance,
    reason,
    hash,
    byteSize,
    mime,
    fileMtimeMs,
    createdAt,
  };
}

function resolvePath(path: string, workspace: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(workspace, path);
}

function isWithin(workspace: string, target: string): boolean {
  const path = relative(workspace, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function textMime(path: string): string {
  const extension = extname(path).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'].includes(extension)) return 'text/javascript';
  if (['.html', '.htm'].includes(extension)) return 'text/html';
  if (['.css', '.scss', '.sass', '.less'].includes(extension)) return 'text/css';
  if (['.md', '.mdx'].includes(extension)) return 'text/markdown';
  if (['.yaml', '.yml'].includes(extension)) return 'text/yaml';
  if (['.xml', '.svg'].includes(extension)) return 'text/xml';
  return 'text/plain';
}
