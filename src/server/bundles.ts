import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { FileSnapshot, RecorderEvent, RecordedSession } from '../shared/types.js';
import type { EventInput, FileSnapshotInput, SessionInput } from './model.js';
import { redactString } from './policy.js';
import { RecorderStore } from './store.js';

const BUNDLE_SCHEMA = 'afr.bundle.v1';
const ARCHIVE_SCHEMA = 'afr.bundle.archive.v1';
const ENCRYPTED_SCHEMA = 'afr.bundle.encrypted.v1';

interface FlightBundle {
  schema: typeof BUNDLE_SCHEMA;
  exportedAt: string;
  session: RecordedSession;
  events: RecorderEvent[];
  snapshots: Array<{ snapshot: FileSnapshot; contentBase64: string | null }>;
}

interface BundleArchive {
  schema: typeof ARCHIVE_SCHEMA;
  digest: string;
  bundle: FlightBundle;
}

interface EncryptedArchive {
  schema: typeof ENCRYPTED_SCHEMA;
  compression: 'gzip';
  kdf: { name: 'scrypt'; salt: string; cost: number; blockSize: number; parallelization: number };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string };
  ciphertext: string;
}

export interface BundleExportOptions {
  passphrase?: string;
  unencrypted?: boolean;
  force?: boolean;
}

export interface BundleImportOptions {
  passphrase?: string;
  merge?: boolean;
}

export interface BundleReceipt {
  sessionId: string;
  events: number;
  snapshots: number;
  encrypted: boolean;
  path: string;
}

export function exportSessionBundle(store: RecorderStore, sessionId: string, outputPath: string, options: BundleExportOptions = {}): BundleReceipt {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const events = store.getSessionEventsDetailed(sessionId);
  const snapshots = store.getSessionSnapshotEvidence(sessionId);
  const bundle: FlightBundle = { schema: BUNDLE_SCHEMA, exportedAt: new Date().toISOString(), session, events, snapshots };
  const archive: BundleArchive = { schema: ARCHIVE_SCHEMA, digest: digest(bundle), bundle };
  const encrypted = !options.unencrypted;
  const serialized = encrypted ? JSON.stringify(encryptArchive(archive, requirePassphrase(options.passphrase))) : JSON.stringify(archive, null, 2);
  const path = safeWrite(outputPath, serialized, options.force ?? false);
  return { sessionId, events: events.length, snapshots: snapshots.length, encrypted, path };
}

export function importSessionBundle(store: RecorderStore, inputPath: string, options: BundleImportOptions = {}): BundleReceipt {
  const path = resolve(inputPath);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const record = object(parsed);
  const encrypted = record.schema === ENCRYPTED_SCHEMA;
  const archive = encrypted ? decryptArchive(parsed as EncryptedArchive, requirePassphrase(options.passphrase)) : parsed as BundleArchive;
  validateArchive(archive);
  const { bundle } = archive;
  if (store.getSession(bundle.session.id) && !options.merge) throw new Error(`Session already exists: ${bundle.session.id}. Pass --merge to add missing evidence.`);

  store.transaction(() => {
    const session: SessionInput = {
      ...bundle.session,
      sourcePath: `bundle:${basename(path)}`,
      status: 'complete',
    };
    store.upsertSession(session);
    for (const event of bundle.events) store.insertEvent(event as EventInput);
    for (const entry of bundle.snapshots) {
      const snapshot = entry.snapshot;
      let persistedSnapshot = snapshot;
      if (entry.contentBase64 !== null) {
        if (!snapshot.hash) throw new Error(`Captured snapshot ${snapshot.id} has no content hash`);
        const content = Buffer.from(entry.contentBase64, 'base64');
        const actual = createHash('sha256').update(content).digest('hex');
        if (actual !== snapshot.hash) throw new Error(`Snapshot integrity check failed: ${snapshot.id}`);
        if (store.policy.sensitivePathPatterns.some((pattern) => pattern.test(snapshot.path))) {
          persistedSnapshot = { ...snapshot, status: 'skipped', reason: 'sensitive_path', hash: null, byteSize: null };
        } else {
          const sanitized = store.policy.redactionMode === 'off' ? content : Buffer.from(redactString(content.toString('utf8')), 'utf8');
          const hash = createHash('sha256').update(sanitized).digest('hex');
          persistedSnapshot = { ...snapshot, hash, byteSize: sanitized.byteLength, reason: hash === snapshot.hash ? snapshot.reason : 'content_redacted' };
          store.putContentBlob(hash, sanitized, snapshot.mime ?? 'text/plain', 'utf8', snapshot.createdAt);
        }
      }
      const input: FileSnapshotInput = {
        id: persistedSnapshot.id,
        eventId: persistedSnapshot.eventId,
        sessionId: persistedSnapshot.sessionId,
        sequence: persistedSnapshot.sequence,
        path: persistedSnapshot.path,
        phase: persistedSnapshot.phase,
        status: persistedSnapshot.status,
        assurance: persistedSnapshot.assurance,
        reason: persistedSnapshot.reason,
        hash: persistedSnapshot.hash,
        byteSize: persistedSnapshot.byteSize,
        mime: persistedSnapshot.mime,
        createdAt: persistedSnapshot.createdAt,
      };
      store.insertFileSnapshot(input);
    }
  });
  store.rebuildCallCorrelations(bundle.session.id);
  store.rebuildPermissionFlows(bundle.session.id);
  return { sessionId: bundle.session.id, events: bundle.events.length, snapshots: bundle.snapshots.length, encrypted, path };
}

function encryptArchive(archive: BundleArchive, passphrase: string): EncryptedArchive {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cost = 32_768;
  const blockSize = 8;
  const parallelization = 1;
  const key = scryptSync(passphrase, salt, 32, { N: cost, r: blockSize, p: parallelization, maxmem: 128 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(ENCRYPTED_SCHEMA));
  const compressed = gzipSync(Buffer.from(JSON.stringify(archive)), { level: 9 });
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return {
    schema: ENCRYPTED_SCHEMA,
    compression: 'gzip',
    kdf: { name: 'scrypt', salt: salt.toString('base64'), cost, blockSize, parallelization },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptArchive(value: EncryptedArchive, passphrase: string): BundleArchive {
  if (value.schema !== ENCRYPTED_SCHEMA || value.compression !== 'gzip' || value.kdf?.name !== 'scrypt' || value.cipher?.name !== 'aes-256-gcm') throw new Error('Unsupported encrypted bundle format');
  const salt = Buffer.from(value.kdf.salt, 'base64');
  const iv = Buffer.from(value.cipher.iv, 'base64');
  const tag = Buffer.from(value.cipher.tag, 'base64');
  if (value.kdf.cost !== 32_768 || value.kdf.blockSize !== 8 || value.kdf.parallelization !== 1 || salt.byteLength !== 16 || iv.byteLength !== 12 || tag.byteLength !== 16) throw new Error('Encrypted bundle uses unsafe or unsupported cryptographic parameters');
  const key = scryptSync(passphrase, salt, 32, { N: value.kdf.cost, r: value.kdf.blockSize, p: value.kdf.parallelization, maxmem: 128 * 1024 * 1024 });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(ENCRYPTED_SCHEMA));
  decipher.setAuthTag(tag);
  try {
    const compressed = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]);
    return JSON.parse(gunzipSync(compressed, { maxOutputLength: 1024 * 1024 * 1024 }).toString('utf8')) as BundleArchive;
  } catch {
    throw new Error('Bundle decryption failed: passphrase or ciphertext is invalid');
  }
}

function validateArchive(archive: BundleArchive): void {
  if (archive?.schema !== ARCHIVE_SCHEMA || archive.bundle?.schema !== BUNDLE_SCHEMA) throw new Error('Unsupported flight bundle schema');
  if (digest(archive.bundle) !== archive.digest) throw new Error('Bundle integrity check failed');
  if (!archive.bundle.session?.id || !Array.isArray(archive.bundle.events) || !Array.isArray(archive.bundle.snapshots)) throw new Error('Flight bundle is incomplete');
  if (archive.bundle.events.some((event) => event.sessionId !== archive.bundle.session.id)) throw new Error('Bundle contains an event from another session');
  if (archive.bundle.snapshots.some((entry) => entry.snapshot.sessionId !== archive.bundle.session.id)) throw new Error('Bundle contains a snapshot from another session');
  const eventIds = new Set(archive.bundle.events.map((event) => event.id));
  if (eventIds.size !== archive.bundle.events.length) throw new Error('Bundle contains duplicate event IDs');
  const snapshotIds = new Set(archive.bundle.snapshots.map((entry) => entry.snapshot.id));
  if (snapshotIds.size !== archive.bundle.snapshots.length) throw new Error('Bundle contains duplicate snapshot IDs');
  if (archive.bundle.snapshots.some((entry) => !eventIds.has(entry.snapshot.eventId))) throw new Error('Bundle snapshot references an absent event');
  if (archive.bundle.snapshots.some((entry) => entry.snapshot.status === 'captured' && entry.contentBase64 === null)) throw new Error('Bundle omits captured snapshot content');
}

function digest(bundle: FlightBundle): string {
  return createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
}

function requirePassphrase(value: string | undefined): string {
  if (!value || value.length < 12) throw new Error('Encrypted bundles require AFR_BUNDLE_PASSPHRASE with at least 12 characters');
  return value;
}

function safeWrite(outputPath: string, content: string, force: boolean): string {
  const path = resolve(outputPath);
  if (existsSync(path) && !force) throw new Error(`Refusing to overwrite existing bundle: ${path}. Pass --force explicitly.`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
