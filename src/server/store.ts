import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTwoFilesPatch } from 'diff';
import type {
  CallAttempt,
  CallLineage,
  CaptureHealth,
  CodeEvolution,
  EventKind,
  FileSnapshot,
  Overview,
  PermissionFlow,
  PermissionTrace,
  RecorderEvent,
  RecordedSession,
  SessionComparison,
  SessionMetrics,
} from '../shared/types.js';
import type { EventInput, FileSnapshotInput, RetentionOptions, RetentionResult, SessionInput, SnapshotEvidence, SourceState } from './model.js';
import { callCorrelationKey, callSignature, permissionSignature } from './correlation.js';
import { loadEvidencePolicy, policySummary, sanitizeEvent, type EvidencePolicy } from './policy.js';
import { EvidenceVault } from './vault.js';

type SqlValue = string | number | bigint | Uint8Array | null;
type DbRow = Record<string, SqlValue>;
type CallObservation = { created: boolean; failureDelta: number };

const EMPTY_METRICS: SessionMetrics = {
  totalEvents: 0,
  toolCalls: 0,
  fileChanges: 0,
  terminalCommands: 0,
  testRuns: 0,
  errors: 0,
  retries: 0,
  captureGaps: 0,
  tokensIn: 0,
  tokensOut: 0,
  cachedTokens: 0,
  costUsd: 0,
};

export class RecorderStore {
  readonly path: string;
  readonly policy: EvidencePolicy;
  private readonly db: DatabaseSync;
  private readonly vault: EvidenceVault;

  constructor(path: string, policy: EvidencePolicy = loadEvidencePolicy()) {
    this.path = path;
    this.policy = policy;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.hardenStoragePermissions();
    this.vault = new EvidenceVault(path);
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.hardenStoragePermissions();
    this.migrate();
  }

  close(): void {
    this.hardenStoragePermissions();
    this.db.close();
    this.hardenStoragePermissions();
  }

  private hardenStoragePermissions(): void {
    if (process.platform === 'win32') return;
    chmodSync(dirname(this.path), 0o700);
    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`, `${this.path}.key`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL,
        cwd TEXT,
        project_name TEXT NOT NULL,
        agent_version TEXT,
        model TEXT,
        source_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        event_count INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        file_changes INTEGER NOT NULL DEFAULT 0,
        terminal_commands INTEGER NOT NULL DEFAULT 0,
        test_runs INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        capture_gaps INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        UNIQUE(provider, native_session_id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        duration_ms INTEGER,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'neutral',
        actor TEXT,
        turn_id TEXT,
        call_id TEXT,
        parent_id TEXT,
        tokens_in INTEGER,
        tokens_out INTEGER,
        cached_tokens INTEGER,
        cost_usd REAL,
        command TEXT,
        path TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        raw_json TEXT,
        phase TEXT,
        gap_code TEXT,
        derived_by TEXT,
        provider_event TEXT,
        UNIQUE(session_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS events_session_sequence ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS events_kind ON events(kind);
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS sources (
        source_path TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        session_id TEXT,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        adapter_version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS recorder_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_sequences (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        next_sequence INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS content_blobs (
        hash TEXT PRIMARY KEY,
        byte_size INTEGER NOT NULL,
        mime TEXT NOT NULL,
        encoding TEXT NOT NULL,
        content BLOB NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_snapshots (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        path TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        assurance TEXT NOT NULL,
        reason TEXT,
        blob_hash TEXT REFERENCES content_blobs(hash),
        byte_size INTEGER,
        mime TEXT,
        file_mtime_ms REAL,
        created_at TEXT NOT NULL,
        UNIQUE(event_id, path, phase)
      );

      CREATE INDEX IF NOT EXISTS snapshots_session_path ON file_snapshots(session_id, path, sequence);
      CREATE INDEX IF NOT EXISTS snapshots_event ON file_snapshots(event_id);
      CREATE INDEX IF NOT EXISTS snapshots_session_event_path ON file_snapshots(session_id, event_id, path);

      CREATE TABLE IF NOT EXISTS call_attempts (
        event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        call_id TEXT,
        signature TEXT NOT NULL,
        correlation_key TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        previous_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
        result_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
        outcome TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        start_observed INTEGER NOT NULL DEFAULT 1,
        UNIQUE(session_id, signature, attempt)
      );

      CREATE INDEX IF NOT EXISTS call_attempts_signature ON call_attempts(session_id, signature, attempt);
      CREATE INDEX IF NOT EXISTS call_attempts_call_id ON call_attempts(session_id, call_id);
      CREATE INDEX IF NOT EXISTS call_attempts_outcome_started ON call_attempts(outcome, started_at);
      CREATE INDEX IF NOT EXISTS call_attempts_previous_event ON call_attempts(previous_event_id);
      CREATE INDEX IF NOT EXISTS call_attempts_result_event ON call_attempts(result_event_id);
      CREATE TABLE IF NOT EXISTS call_event_links (
        event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        attempt_event_id TEXT NOT NULL REFERENCES call_attempts(event_id) ON DELETE CASCADE,
        role TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS call_event_links_attempt ON call_event_links(attempt_event_id);

      CREATE TABLE IF NOT EXISTS permission_flows (
        request_event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        signature TEXT,
        call_id TEXT,
        tool TEXT,
        outcome TEXT NOT NULL,
        assurance TEXT NOT NULL,
        decision_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        provider_event TEXT,
        reason TEXT
      );

      CREATE INDEX IF NOT EXISTS permission_flows_signature ON permission_flows(session_id, signature, requested_at);
      CREATE INDEX IF NOT EXISTS permission_flows_call_id ON permission_flows(session_id, call_id);
      CREATE INDEX IF NOT EXISTS permission_flows_decision ON permission_flows(decision_event_id);

      CREATE TABLE IF NOT EXISTS retention_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        executed_at TEXT NOT NULL,
        raw_before TEXT,
        snapshots_before TEXT,
        raw_events_pruned INTEGER NOT NULL,
        snapshots_pruned INTEGER NOT NULL,
        blobs_pruned INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recorder_heartbeats (
        component TEXT PRIMARY KEY,
        process_id INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        detail TEXT
      );
    `);
    this.ensureColumn('sessions', 'capture_gaps', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('sources', 'adapter_version', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('events', 'phase', 'TEXT');
    this.ensureColumn('events', 'gap_code', 'TEXT');
    this.ensureColumn('events', 'derived_by', 'TEXT');
    this.ensureColumn('events', 'provider_event', 'TEXT');
    this.ensureColumn('call_attempts', 'correlation_key', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('call_attempts', 'start_observed', 'INTEGER NOT NULL DEFAULT 1');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS events_session_call_phase ON events(session_id, call_id, phase);
      CREATE INDEX IF NOT EXISTS events_gap_parent_code ON events(kind, parent_id, gap_code);
      CREATE INDEX IF NOT EXISTS events_session_kind_path ON events(session_id, kind, path);
      CREATE INDEX IF NOT EXISTS call_attempts_correlation ON call_attempts(session_id, correlation_key, started_at);
    `);
    const previousSchema = Number((this.db.prepare("SELECT value FROM recorder_meta WHERE key = 'schema_version'").get() as DbRow | undefined)?.value ?? 0);
    if (previousSchema < 6) this.backfillEventIndexColumns();
    if (previousSchema < 3) this.backfillLegacyCaptureGaps();
    if (previousSchema < 7) this.backfillCallCorrelations();
    if (previousSchema < 5) this.backfillPermissionFlows();
    if (previousSchema < 6) this.encryptSensitiveEvidence();
    else this.verifyEncryptionCanary();
    this.db
      .prepare(`
      INSERT INTO recorder_meta (key, value) VALUES ('schema_version', '7')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
      .run();
  }

  private backfillEventIndexColumns(): void {
    const rows = this.db.prepare('SELECT id, payload_json FROM events').all() as DbRow[];
    const update = this.db.prepare('UPDATE events SET phase = ?, gap_code = ?, derived_by = ?, provider_event = ? WHERE id = ?');
    for (const row of rows) {
      const payload = record(safeJson(this.vault.openText(String(row.payload_json), `event:${String(row.id)}:payload`)));
      update.run(textValue(payload.phase), textValue(payload.code), textValue(payload.derivedBy), textValue(payload.providerEvent), row.id);
    }
  }

  private encryptSensitiveEvidence(): void {
    this.transaction(() => {
      const events = this.db.prepare('SELECT id, payload_json, raw_json FROM events').all() as DbRow[];
      const updateEvent = this.db.prepare('UPDATE events SET payload_json = ?, raw_json = ? WHERE id = ?');
      for (const row of events) {
        const id = String(row.id);
        const payload = String(row.payload_json);
        const raw = row.raw_json === null ? null : String(row.raw_json);
        updateEvent.run(
          this.vault.isSealed(payload) ? payload : this.vault.sealText(payload, `event:${id}:payload`),
          raw === null || this.vault.isSealed(raw) ? raw : this.vault.sealText(raw, `event:${id}:raw`),
          id,
        );
      }
      const blobs = this.db.prepare('SELECT hash, content FROM content_blobs').all() as DbRow[];
      const updateBlob = this.db.prepare('UPDATE content_blobs SET content = ? WHERE hash = ?');
      for (const row of blobs) {
        const content = row.content as Uint8Array;
        updateBlob.run(
          this.vault.isSealed(content) ? content : Buffer.from(this.vault.sealText(Buffer.from(content).toString('base64'), `blob:${String(row.hash)}`)),
          row.hash,
        );
      }
      const canary = this.vault.sealText('agent-flight-recorder', 'store-canary');
      this.db
        .prepare(`
        INSERT INTO recorder_meta (key, value) VALUES ('encryption_canary', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
        .run(canary);
    });
  }

  private verifyEncryptionCanary(): void {
    const row = this.db.prepare("SELECT value FROM recorder_meta WHERE key = 'encryption_canary'").get() as DbRow | undefined;
    if (!row || this.vault.openText(String(row.value), 'store-canary') !== 'agent-flight-recorder') {
      throw new Error('Recorder encryption canary is missing or invalid.');
    }
  }

  private backfillLegacyCaptureGaps(): void {
    const rows = this.db
      .prepare(`
      SELECT e.* FROM events e
      WHERE e.kind = 'file'
        AND (e.phase = 'call' OR e.call_id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM file_snapshots fs
          LEFT JOIN events snapshot_event ON snapshot_event.id = fs.event_id
          WHERE fs.session_id = e.session_id AND fs.path IS e.path
            AND (fs.event_id = e.id OR (e.call_id IS NOT NULL AND snapshot_event.call_id = e.call_id))
        )
        AND NOT EXISTS (
          SELECT 1 FROM events gap
          WHERE gap.kind = 'gap' AND gap.session_id = e.session_id
            AND (gap.parent_id = e.id OR (e.call_id IS NOT NULL AND gap.call_id = e.call_id AND gap.path IS e.path))
        )
      ORDER BY e.session_id, e.sequence
    `)
      .all() as DbRow[];
    for (const row of rows) {
      const event = rowToEvent(row, false, this.vault) as EventInput;
      this.insertCaptureGap(
        event,
        'legacy_snapshot_unavailable',
        'This file action predates snapshot capture; exact before/after contents are unavailable.',
        event.path,
      );
    }
  }

  private backfillCallCorrelations(): void {
    const sessions = this.db.prepare('SELECT id FROM sessions ORDER BY id').all() as DbRow[];
    for (const session of sessions) this.rebuildCallCorrelations(String(session.id));
  }

  private backfillPermissionFlows(): void {
    const sessions = this.db.prepare('SELECT id FROM sessions ORDER BY id').all() as DbRow[];
    for (const session of sessions) this.rebuildPermissionFlows(String(session.id));
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as DbRow[];
    if (!columns.some((row) => String(row.name) === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  upsertSession(session: SessionInput): void {
    this.db
      .prepare(`
      INSERT INTO sessions (
        id, provider, native_session_id, title, started_at, ended_at, updated_at, cwd,
        project_name, agent_version, model, source_path, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
        updated_at = excluded.updated_at,
        cwd = COALESCE(excluded.cwd, sessions.cwd),
        project_name = excluded.project_name,
        agent_version = COALESCE(excluded.agent_version, sessions.agent_version),
        model = COALESCE(excluded.model, sessions.model),
        source_path = excluded.source_path,
        status = excluded.status
    `)
      .run(
        session.id,
        session.provider,
        session.nativeSessionId,
        session.title,
        session.startedAt,
        session.endedAt ?? null,
        session.updatedAt,
        session.cwd ?? null,
        session.projectName,
        session.agentVersion ?? null,
        session.model ?? null,
        session.sourcePath,
        session.status,
      );
  }

  insertEvent(event: EventInput): boolean {
    const persisted = sanitizeEvent(event, this.policy);
    const result = this.db
      .prepare(`
      INSERT OR IGNORE INTO events (
        id, session_id, sequence, timestamp, duration_ms, kind, title, summary, status,
        actor, turn_id, call_id, parent_id, tokens_in, tokens_out, cached_tokens,
        cost_usd, command, path, payload_json, raw_json, phase, gap_code, derived_by, provider_event
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        persisted.id,
        persisted.sessionId,
        persisted.sequence,
        persisted.timestamp,
        persisted.durationMs,
        persisted.kind,
        persisted.title,
        persisted.summary,
        persisted.status,
        persisted.actor,
        persisted.turnId,
        persisted.callId,
        persisted.parentId,
        persisted.tokensIn,
        persisted.tokensOut,
        persisted.cachedTokens,
        persisted.costUsd,
        persisted.command,
        persisted.path,
        this.vault.sealText(JSON.stringify(persisted.payload ?? {}), `event:${persisted.id}:payload`),
        persisted.raw === undefined ? null : this.vault.sealText(JSON.stringify(persisted.raw), `event:${persisted.id}:raw`),
        textValue(record(persisted.payload).phase),
        textValue(record(persisted.payload).code),
        textValue(record(persisted.payload).derivedBy),
        textValue(record(persisted.payload).providerEvent),
      );
    return Number(result.changes) > 0;
  }

  incrementSessionMetrics(event: EventInput, observation?: CallObservation | null): void {
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? (event.payload as Record<string, unknown>) : {};
    const isCall = payload.phase === 'call';
    const isToolCall = (observation?.created ?? isCall) && ['tool', 'terminal', 'file', 'test'].includes(event.kind);
    const failureDelta = observation ? observation.failureDelta : event.status === 'error' ? 1 : 0;
    this.db
      .prepare(`
      UPDATE sessions SET
        event_count = event_count + 1,
        tool_calls = tool_calls + ?,
        file_changes = file_changes + ?,
        terminal_commands = terminal_commands + ?,
        test_runs = test_runs + ?,
        errors = errors + ?,
        retries = retries + ?,
        capture_gaps = capture_gaps + ?,
        tokens_in = MAX(tokens_in, COALESCE(?, tokens_in)),
        tokens_out = MAX(tokens_out, COALESCE(?, tokens_out)),
        cached_tokens = MAX(cached_tokens, COALESCE(?, cached_tokens)),
        cost_usd = cost_usd + COALESCE(?, 0),
        updated_at = MAX(updated_at, ?)
      WHERE id = ?
    `)
      .run(
        isToolCall ? 1 : 0,
        isToolCall && event.kind === 'file' ? 1 : 0,
        isToolCall && event.kind === 'terminal' ? 1 : 0,
        isToolCall && event.kind === 'test' ? 1 : 0,
        failureDelta,
        event.kind === 'retry' ? 1 : 0,
        event.kind === 'gap' ? 1 : 0,
        event.tokensIn,
        event.tokensOut,
        event.cachedTokens,
        event.costUsd,
        event.timestamp,
        event.sessionId,
      );
  }

  insertEventWithMetrics(event: EventInput): boolean {
    return this.transaction(() => {
      const inserted = this.insertEvent(event);
      if (inserted) {
        const observation = this.observeCallEvent(event);
        this.incrementSessionMetrics(event, observation);
        this.observePermissionEvent(event);
      }
      return inserted;
    });
  }

  rebuildCallCorrelations(sessionId: string): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM events WHERE session_id = ? AND kind = 'retry' AND derived_by = 'call-correlation-v1'`).run(sessionId);
      this.db.prepare(`DELETE FROM call_event_links WHERE event_id IN (SELECT id FROM events WHERE session_id = ?)`).run(sessionId);
      this.db.prepare('DELETE FROM call_attempts WHERE session_id = ?').run(sessionId);
      const rows = this.db
        .prepare(`
        SELECT * FROM events
        WHERE session_id = ? AND phase IN ('call', 'result')
        ORDER BY sequence ASC
      `)
        .all(sessionId) as DbRow[];
      for (const row of rows) this.observeCallEvent(rowToEvent(row, false, this.vault) as EventInput);
      this.refreshSessionMetrics(sessionId);
    });
  }

  private observeCallEvent(event: EventInput): CallObservation | null {
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? (event.payload as Record<string, unknown>) : {};
    const phase = payload.phase;
    if (phase === 'call' && ['tool', 'terminal', 'file', 'test'].includes(event.kind)) {
      const signature = callSignature(event);
      const correlationKey = callCorrelationKey(event);
      const existing = this.findFacetAttempt(event, correlationKey);
      if (existing) {
        if (event.callId && existing.call_id === null)
          this.db.prepare('UPDATE call_attempts SET call_id = ? WHERE event_id = ?').run(event.callId, existing.event_id);
        if (String(existing.outcome) === 'unknown' && payload.resultExpected !== false) {
          this.db.prepare("UPDATE call_attempts SET outcome = 'running', completed_at = NULL WHERE event_id = ?").run(existing.event_id);
        }
        this.linkCallEvent(event.id, String(existing.event_id), 'call-facet');
        return { created: false, failureDelta: 0 };
      }
      const previous = this.db
        .prepare(`
        SELECT ca.*, e.turn_id previous_turn_id, e.timestamp previous_timestamp
        FROM call_attempts ca JOIN events e ON e.id = ca.event_id
        WHERE ca.session_id = ? AND ca.signature = ? ORDER BY ca.attempt DESC LIMIT 1
      `)
        .get(event.sessionId, signature) as DbRow | undefined;
      const attempt = previous ? Number(previous.attempt) + 1 : 1;
      const terminalOutcome = payload.resultExpected === false ? 'unknown' : ['success', 'error', 'blocked'].includes(event.status) ? event.status : 'running';
      this.db
        .prepare(`
        INSERT OR IGNORE INTO call_attempts (
          event_id, session_id, call_id, signature, correlation_key, attempt, previous_event_id,
          result_event_id, outcome, started_at, completed_at, start_observed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1)
      `)
        .run(
          event.id,
          event.sessionId,
          event.callId,
          signature,
          correlationKey,
          attempt,
          previous?.event_id ?? null,
          terminalOutcome,
          event.timestamp,
          terminalOutcome === 'running' ? null : event.timestamp,
        );
      this.linkCallEvent(event.id, event.id, 'call');
      if (previous && ['error', 'blocked'].includes(String(previous.outcome)) && shouldInferRetry(previous, event))
        this.insertDerivedRetry(event, String(previous.event_id), signature, attempt);
      return { created: true, failureDelta: isFailedCallOutcome(terminalOutcome) ? 1 : 0 };
    }
    if (phase === 'result' && ['tool', 'terminal', 'file', 'test'].includes(event.kind)) {
      const outcome = ['success', 'error', 'blocked'].includes(event.status) ? event.status : 'unknown';
      const signature = callSignature(event);
      const correlationKey = callCorrelationKey(event);
      const attempt = this.findResultAttempt(event, correlationKey);
      if (attempt) {
        const mergedOutcome = mergeCallOutcome(String(attempt.outcome), outcome);
        const replaceResult = callOutcomeRank(outcome) >= callOutcomeRank(String(attempt.outcome));
        this.db
          .prepare(`
          UPDATE call_attempts SET call_id = COALESCE(call_id, ?),
            result_event_id = CASE WHEN ? THEN ? ELSE COALESCE(result_event_id, ?) END,
            outcome = ?, completed_at = MAX(COALESCE(completed_at, ?), ?)
          WHERE event_id = ?
        `)
          .run(event.callId, replaceResult ? 1 : 0, event.id, event.id, mergedOutcome, event.timestamp, event.timestamp, attempt.event_id);
        this.linkCallEvent(event.id, String(attempt.event_id), 'result');
        return { created: false, failureDelta: isFailedCallOutcome(mergedOutcome) && !isFailedCallOutcome(String(attempt.outcome)) ? 1 : 0 };
      }
      const previous = this.db
        .prepare(`
        SELECT * FROM call_attempts WHERE session_id = ? AND signature = ? ORDER BY attempt DESC LIMIT 1
      `)
        .get(event.sessionId, signature) as DbRow | undefined;
      const ordinal = previous ? Number(previous.attempt) + 1 : 1;
      this.db
        .prepare(`
        INSERT OR IGNORE INTO call_attempts (
          event_id, session_id, call_id, signature, correlation_key, attempt, previous_event_id,
          result_event_id, outcome, started_at, completed_at, start_observed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `)
        .run(
          event.id,
          event.sessionId,
          event.callId,
          signature,
          correlationKey,
          ordinal,
          previous?.event_id ?? null,
          event.id,
          outcome,
          event.timestamp,
          event.timestamp,
        );
      this.linkCallEvent(event.id, event.id, 'orphan-result');
      return { created: true, failureDelta: isFailedCallOutcome(outcome) ? 1 : 0 };
    }
    return null;
  }

  private findFacetAttempt(event: EventInput, correlationKey: string): DbRow | undefined {
    if (event.callId) {
      const byId = this.db
        .prepare(`
        SELECT ca.*, e.provider_event attempt_provider_event, e.turn_id attempt_turn_id, e.timestamp attempt_timestamp
        FROM call_attempts ca JOIN events e ON e.id = ca.event_id
        WHERE ca.session_id = ? AND ca.call_id = ? ORDER BY ca.attempt DESC LIMIT 1
      `)
        .get(event.sessionId, event.callId) as DbRow | undefined;
      if (byId) return byId;
    }
    const candidate = this.db
      .prepare(`
      SELECT ca.*, e.provider_event attempt_provider_event, e.turn_id attempt_turn_id, e.timestamp attempt_timestamp
      FROM call_attempts ca JOIN events e ON e.id = ca.event_id
      WHERE ca.session_id = ? AND ca.correlation_key = ? AND ca.outcome IN ('running', 'unknown')
      ORDER BY ca.started_at DESC LIMIT 1
    `)
      .get(event.sessionId, correlationKey) as DbRow | undefined;
    if (!candidate) return undefined;
    const withinWindow = Math.abs(Date.parse(event.timestamp) - Date.parse(String(candidate.attempt_timestamp))) <= 30_000;
    const sameTurn = event.turnId === null || candidate.attempt_turn_id === null || event.turnId === String(candidate.attempt_turn_id);
    return withinWindow && sameTurn && areProviderFacets(textValue(candidate.attempt_provider_event), textValue(record(event.payload).providerEvent))
      ? candidate
      : undefined;
  }

  private findResultAttempt(event: EventInput, correlationKey: string): DbRow | undefined {
    if (event.callId) {
      const byId = this.db
        .prepare(`
        SELECT * FROM call_attempts WHERE session_id = ? AND call_id = ? ORDER BY attempt DESC LIMIT 1
      `)
        .get(event.sessionId, event.callId) as DbRow | undefined;
      if (byId) return byId;
    }
    const candidate = this.db
      .prepare(`
      SELECT ca.*, e.turn_id attempt_turn_id
      FROM call_attempts ca JOIN events e ON e.id = ca.event_id
      WHERE ca.session_id = ? AND ca.correlation_key = ? AND ca.started_at <= ?
      ORDER BY CASE WHEN ca.outcome = 'running' THEN 0 ELSE 1 END, ca.started_at DESC LIMIT 1
    `)
      .get(event.sessionId, correlationKey, event.timestamp) as DbRow | undefined;
    if (!candidate) return undefined;
    const elapsedMs = Math.max(0, Date.parse(event.timestamp) - Date.parse(String(candidate.started_at)));
    const sameTurn = event.turnId !== null && candidate.attempt_turn_id !== null && event.turnId === String(candidate.attempt_turn_id);
    const durationAllowance = Math.max(30_000, (event.durationMs ?? 0) + 30_000);
    if (String(candidate.outcome) === 'running') return sameTurn || elapsedMs <= durationAllowance ? candidate : undefined;
    return elapsedMs <= 30_000 ? candidate : undefined;
  }

  private linkCallEvent(eventId: string, attemptEventId: string, role: string): void {
    this.db
      .prepare(`
      INSERT OR IGNORE INTO call_event_links (event_id, attempt_event_id, role) VALUES (?, ?, ?)
    `)
      .run(eventId, attemptEventId, role);
  }

  private insertDerivedRetry(event: EventInput, previousEventId: string, signature: string, attempt: number): void {
    const id = `retry:${createHash('sha256').update(`${event.id}\u001f${previousEventId}`).digest('hex').slice(0, 24)}`;
    for (let offset = 1; offset <= 999; offset += 1) {
      const retry: EventInput = {
        id,
        sessionId: event.sessionId,
        sequence: event.sequence - offset / 1000,
        timestamp: event.timestamp,
        durationMs: null,
        kind: 'retry',
        title: `Retry attempt ${attempt}`,
        summary: 'The same invocation is running again after an observed failed or blocked attempt.',
        status: 'running',
        actor: 'recorder',
        turnId: event.turnId,
        callId: event.callId,
        parentId: event.id,
        tokensIn: null,
        tokensOut: null,
        cachedTokens: null,
        costUsd: null,
        command: event.command,
        path: event.path,
        payload: { phase: 'retry', derivedBy: 'call-correlation-v1', signature, attempt, previousEventId, currentEventId: event.id },
      };
      if (this.insertEvent(retry)) {
        this.incrementSessionMetrics(retry);
        return;
      }
      if (this.getEvent(id)) return;
    }
  }

  getCallLineage(eventId: string): CallLineage | null {
    const event = this.getEvent(eventId);
    if (!event) return null;
    let current = this.db
      .prepare(`
      SELECT ca.*, (SELECT COUNT(*) FROM call_event_links links WHERE links.attempt_event_id = ca.event_id) facets
      FROM call_attempts ca LEFT JOIN call_event_links link ON link.attempt_event_id = ca.event_id
      WHERE ca.event_id = ? OR ca.result_event_id = ? OR link.event_id = ? LIMIT 1
    `)
      .get(eventId, eventId, eventId) as DbRow | undefined;
    if (!current && event.kind === 'retry' && event.parentId)
      current = this.db
        .prepare(`
      SELECT ca.*, (SELECT COUNT(*) FROM call_event_links links WHERE links.attempt_event_id = ca.event_id) facets
      FROM call_attempts ca LEFT JOIN call_event_links link ON link.attempt_event_id = ca.event_id
      WHERE ca.event_id = ? OR link.event_id = ? LIMIT 1
    `)
        .get(event.parentId, event.parentId) as DbRow | undefined;
    if (!current) return { eventId, current: null, attempts: [] };
    const attempts = this.db
      .prepare(`
      SELECT ca.*, (SELECT COUNT(*) FROM call_event_links links WHERE links.attempt_event_id = ca.event_id) facets
      FROM call_attempts ca WHERE session_id = ? AND signature = ? ORDER BY attempt ASC
    `)
      .all(current.session_id, current.signature) as DbRow[];
    return { eventId, current: rowToCallAttempt(current), attempts: attempts.map(rowToCallAttempt) };
  }

  rebuildPermissionFlows(sessionId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM permission_flows WHERE session_id = ?').run(sessionId);
      const rows = this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY sequence ASC').all(sessionId) as DbRow[];
      for (const row of rows) this.observePermissionEvent(rowToEvent(row, true, this.vault) as EventInput);
    });
  }

  private observePermissionEvent(event: EventInput): void {
    const payload = record(event.payload);
    const raw = record(event.raw);
    const phase = typeof payload.phase === 'string' ? payload.phase : null;
    const providerEvent = textValue(payload.providerEvent) ?? textValue(raw.hook_event_name) ?? textValue(raw.event) ?? textValue(raw.type);
    const tool = textValue(payload.tool) ?? textValue(raw.tool_name) ?? textValue(raw.toolName);
    const signature = permissionSignature(event);
    const reason = textValue(raw.reason) ?? textValue(raw.error_message) ?? textValue(raw.error) ?? decisionReason(payload.decision);
    const permissionFailure = textValue(raw.failure_type) === 'permission_denied' || textValue(payload.failureType) === 'permission_denied';

    if (event.kind === 'permission') {
      if (phase === 'request') {
        this.insertPermissionFlow({
          requestEventId: event.id,
          sessionId: event.sessionId,
          signature,
          callId: event.callId,
          tool,
          outcome: 'pending',
          assurance: 'unresolved',
          decisionEventId: null,
          requestedAt: event.timestamp,
          decidedAt: null,
          providerEvent,
          reason,
        });
        return;
      }
      if (phase === 'result') {
        const outcome: PermissionFlow['outcome'] = event.status === 'blocked' ? 'denied' : event.status === 'success' ? 'allowed' : 'unknown';
        const updated = this.resolvePermissionFlow(event, signature, outcome, 'explicit', reason);
        if (!updated)
          this.insertPermissionFlow({
            requestEventId: event.id,
            sessionId: event.sessionId,
            signature,
            callId: event.callId,
            tool,
            outcome,
            assurance: 'explicit',
            decisionEventId: event.id,
            requestedAt: event.timestamp,
            decidedAt: event.timestamp,
            providerEvent,
            reason,
          });
        return;
      }
      this.insertPermissionFlow({
        requestEventId: event.id,
        sessionId: event.sessionId,
        signature: null,
        callId: event.callId,
        tool,
        outcome: 'policy',
        assurance: 'policy',
        decisionEventId: event.id,
        requestedAt: event.timestamp,
        decidedAt: event.timestamp,
        providerEvent,
        reason,
      });
      return;
    }

    if (permissionFailure) {
      const updated = this.resolvePermissionFlow(event, signature, 'denied', 'explicit', reason ?? 'Provider reported permission_denied.');
      if (!updated)
        this.insertPermissionFlow({
          requestEventId: event.id,
          sessionId: event.sessionId,
          signature,
          callId: event.callId,
          tool,
          outcome: 'denied',
          assurance: 'explicit',
          decisionEventId: event.id,
          requestedAt: event.timestamp,
          decidedAt: event.timestamp,
          providerEvent,
          reason: reason ?? 'Provider reported permission_denied.',
        });
      return;
    }

    if (phase === 'result' && ['tool', 'terminal', 'file', 'test'].includes(event.kind)) {
      this.resolvePermissionFlow(
        event,
        signature,
        'executed',
        'inferred',
        'A correlated tool result was observed; the provider did not expose the manual permission response.',
      );
    }
  }

  private insertPermissionFlow(flow: PermissionFlow): void {
    this.db
      .prepare(`
      INSERT OR IGNORE INTO permission_flows (
        request_event_id, session_id, signature, call_id, tool, outcome, assurance,
        decision_event_id, requested_at, decided_at, provider_event, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        flow.requestEventId,
        flow.sessionId,
        flow.signature,
        flow.callId,
        flow.tool,
        flow.outcome,
        flow.assurance,
        flow.decisionEventId,
        flow.requestedAt,
        flow.decidedAt,
        flow.providerEvent,
        flow.reason,
      );
  }

  private resolvePermissionFlow(
    event: EventInput,
    signature: string,
    outcome: PermissionFlow['outcome'],
    assurance: PermissionFlow['assurance'],
    reason: string | null,
  ): boolean {
    const pending = this.db
      .prepare(`
      SELECT request_event_id FROM permission_flows
      WHERE session_id = ? AND outcome IN ('pending', 'unknown')
        AND ((? IS NOT NULL AND call_id = ?) OR signature = ?)
        AND requested_at <= ?
      ORDER BY CASE WHEN ? IS NOT NULL AND call_id = ? THEN 0 ELSE 1 END, requested_at DESC LIMIT 1
    `)
      .get(event.sessionId, event.callId, event.callId, signature, event.timestamp, event.callId, event.callId) as DbRow | undefined;
    if (!pending) return false;
    const result = this.db
      .prepare(`
      UPDATE permission_flows SET call_id = COALESCE(?, call_id), outcome = ?, assurance = ?,
        decision_event_id = ?, decided_at = ?, reason = ?
      WHERE request_event_id = ?
    `)
      .run(event.callId, outcome, assurance, event.id, event.timestamp, reason, pending.request_event_id);
    return Number(result.changes) > 0;
  }

  getPermissionTrace(eventId: string): PermissionTrace | null {
    const event = this.getEvent(eventId);
    if (!event) return null;
    let current = this.db
      .prepare(`
      SELECT * FROM permission_flows
      WHERE request_event_id = ? OR decision_event_id = ?
      ORDER BY requested_at DESC LIMIT 1
    `)
      .get(eventId, eventId) as DbRow | undefined;
    if (!current && event.callId)
      current = this.db
        .prepare(`
      SELECT * FROM permission_flows WHERE session_id = ? AND call_id = ?
      ORDER BY requested_at DESC LIMIT 1
    `)
        .get(event.sessionId, event.callId) as DbRow | undefined;
    if (!current && (event.kind === 'permission' || ['tool', 'terminal', 'file', 'test'].includes(event.kind))) {
      current = this.db
        .prepare(`
        SELECT * FROM permission_flows WHERE session_id = ? AND signature = ?
        ORDER BY requested_at DESC LIMIT 1
      `)
        .get(event.sessionId, permissionSignature(event)) as DbRow | undefined;
    }
    if (!current) return { eventId, current: null, flows: [] };
    const flows =
      current.signature === null
        ? [current]
        : (this.db
            .prepare(`
          SELECT * FROM permission_flows WHERE session_id = ? AND signature = ? ORDER BY requested_at ASC
        `)
            .all(current.session_id, current.signature) as DbRow[]);
    return { eventId, current: rowToPermissionFlow(current), flows: flows.map(rowToPermissionFlow) };
  }

  refreshSessionMetrics(sessionId: string): void {
    this.db
      .prepare(`
      UPDATE sessions SET
        event_count = (SELECT COUNT(*) FROM events WHERE session_id = ?),
        tool_calls = (SELECT COUNT(*) FROM call_attempts WHERE session_id = ?),
        file_changes = (SELECT COUNT(*) FROM call_attempts attempt JOIN events event ON event.id = attempt.event_id WHERE attempt.session_id = ? AND event.kind = 'file'),
        terminal_commands = (SELECT COUNT(*) FROM call_attempts attempt JOIN events event ON event.id = attempt.event_id WHERE attempt.session_id = ? AND event.kind = 'terminal'),
        test_runs = (SELECT COUNT(*) FROM call_attempts attempt JOIN events event ON event.id = attempt.event_id WHERE attempt.session_id = ? AND event.kind = 'test'),
        errors = (
          (SELECT COUNT(*) FROM call_attempts WHERE session_id = ? AND outcome IN ('error', 'blocked'))
          + (SELECT COUNT(*) FROM events WHERE session_id = ? AND status = 'error'
              AND NOT (phase IN ('call', 'result') AND kind IN ('tool', 'terminal', 'file', 'test')))
        ),
        retries = (SELECT COUNT(*) FROM events WHERE session_id = ? AND kind = 'retry'),
        capture_gaps = (SELECT COUNT(*) FROM events WHERE session_id = ? AND kind = 'gap'),
        tokens_in = COALESCE((SELECT MAX(tokens_in) FROM events WHERE session_id = ? AND kind = 'token'), 0),
        tokens_out = COALESCE((SELECT MAX(tokens_out) FROM events WHERE session_id = ? AND kind = 'token'), 0),
        cached_tokens = COALESCE((SELECT MAX(cached_tokens) FROM events WHERE session_id = ? AND kind = 'token'), 0),
        cost_usd = COALESCE((SELECT SUM(cost_usd) FROM events WHERE session_id = ?), 0),
        updated_at = COALESCE((SELECT MAX(timestamp) FROM events WHERE session_id = ?), updated_at)
      WHERE id = ?
    `)
      .run(...Array(15).fill(sessionId));
  }

  getSource(path: string): SourceState | null {
    const row = this.db.prepare('SELECT * FROM sources WHERE source_path = ?').get(path) as DbRow | undefined;
    if (!row) return null;
    return {
      sourcePath: String(row.source_path),
      provider: String(row.provider) as SourceState['provider'],
      sessionId: row.session_id === null ? null : String(row.session_id),
      byteOffset: Number(row.byte_offset),
      size: Number(row.size),
      mtimeMs: Number(row.mtime_ms),
      updatedAt: String(row.updated_at),
      adapterVersion: Number(row.adapter_version ?? 1),
    };
  }

  setSource(source: SourceState): void {
    this.db
      .prepare(`
      INSERT INTO sources (source_path, provider, session_id, byte_offset, size, mtime_ms, updated_at, adapter_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
        provider = excluded.provider,
        session_id = excluded.session_id,
        byte_offset = excluded.byte_offset,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        updated_at = excluded.updated_at,
        adapter_version = excluded.adapter_version
    `)
      .run(source.sourcePath, source.provider, source.sessionId, source.byteOffset, source.size, source.mtimeMs, source.updatedAt, source.adapterVersion);
  }

  clearSource(path: string): void {
    const ids = this.db.prepare('SELECT id FROM sessions WHERE source_path = ?').all(path) as DbRow[];
    for (const row of ids) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    this.db.prepare('DELETE FROM sources WHERE source_path = ?').run(path);
  }

  setLastIngestedAt(timestamp: string): void {
    this.db
      .prepare(`
      INSERT INTO recorder_meta (key, value) VALUES ('last_ingested_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
      .run(timestamp);
  }

  reconcileSessionStatuses(now = Date.now()): void {
    this.db
      .prepare(`
      UPDATE sessions SET status = CASE
        WHEN COALESCE((SELECT mtime_ms FROM sources WHERE sources.source_path = sessions.source_path), 0) >= ? THEN 'live'
        ELSE 'unknown'
      END
      WHERE provider = 'codex'
    `)
      .run(now - 15_000);
    this.db
      .prepare(`
      UPDATE sessions SET status = 'unknown'
      WHERE source_path LIKE 'hook:%' AND status = 'live' AND updated_at < ?
    `)
      .run(new Date(now - 5 * 60_000).toISOString());
  }

  recordStaleCallGaps(now = Date.now(), staleAfterMs = 5 * 60_000): number {
    const rows = this.db
      .prepare(`
      SELECT call.* FROM call_attempts attempt
      JOIN events call ON call.id = attempt.event_id
      WHERE attempt.outcome = 'running' AND attempt.started_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM events gap
          WHERE gap.kind = 'gap' AND gap.parent_id = call.id
            AND gap.gap_code = 'tool_result_unavailable'
        )
      ORDER BY call.timestamp
    `)
      .all(new Date(now - staleAfterMs).toISOString()) as DbRow[];
    let inserted = 0;
    for (const row of rows) {
      const event = rowToEvent(row, false, this.vault) as EventInput;
      if (this.insertCaptureGap(event, 'tool_result_unavailable', 'No correlated tool result reached the recorder within five minutes.', event.path))
        inserted += 1;
    }
    return inserted;
  }

  recordUncoveredFileGaps(): number {
    const rows = this.db
      .prepare(`
      WITH file_events AS (
        SELECT id FROM events WHERE kind = 'file'
      ), evidence_events AS (
        SELECT event_id FROM file_snapshots
        UNION
        SELECT parent_id FROM events WHERE kind = 'gap' AND parent_id IS NOT NULL
      ), covered_ids AS (
        SELECT fe.id
        FROM file_events fe JOIN evidence_events evidence ON evidence.event_id = fe.id
        UNION
        SELECT fe.id
        FROM file_events fe
        JOIN call_event_links file_link ON file_link.event_id = fe.id
        JOIN call_event_links evidence_link ON evidence_link.attempt_event_id = file_link.attempt_event_id
        JOIN evidence_events evidence ON evidence.event_id = evidence_link.event_id
      )
      SELECT e.* FROM events e
      LEFT JOIN covered_ids covered ON covered.id = e.id
      WHERE e.kind = 'file' AND covered.id IS NULL
      ORDER BY e.session_id, e.sequence
    `)
      .all() as DbRow[];
    let inserted = 0;
    for (const row of rows) {
      const event = rowToEvent(row, false, this.vault) as EventInput;
      const message = event.path
        ? 'The provider reported a file action, but no snapshot or historical boundary evidence reached the recorder.'
        : 'The provider classified a file action without exposing an affected path, so code-evolution evidence is unavailable.';
      if (this.insertCaptureGap(event, event.path ? 'file_evidence_unavailable' : 'file_path_unavailable', message, event.path)) inserted += 1;
    }
    return inserted;
  }

  recordStalePermissionUnknowns(now = Date.now(), staleAfterMs = 5 * 60_000): number {
    const result = this.db
      .prepare(`
      UPDATE permission_flows SET outcome = 'unknown', assurance = 'unresolved',
        reason = COALESCE(reason, 'No explicit decision or correlated execution evidence reached the recorder within five minutes.')
      WHERE outcome = 'pending' AND requested_at < ?
    `)
      .run(new Date(now - staleAfterMs).toISOString());
    return Number(result.changes);
  }

  recordHeartbeat(component: string, detail: string | null = null, timestamp = new Date().toISOString()): void {
    this.db
      .prepare(`
      INSERT INTO recorder_heartbeats (component, process_id, started_at, last_seen_at, detail)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(component) DO UPDATE SET
        process_id = excluded.process_id,
        last_seen_at = excluded.last_seen_at,
        detail = excluded.detail
    `)
      .run(component, process.pid, timestamp, timestamp, detail);
  }

  dataVersion(): number {
    const row = this.db.prepare('PRAGMA data_version').get() as DbRow;
    return Number(row.data_version ?? 0);
  }

  putContentBlob(hash: string, content: Buffer, mime: string, encoding = 'utf8', createdAt = new Date().toISOString()): void {
    this.db
      .prepare(`
      INSERT OR IGNORE INTO content_blobs (hash, byte_size, mime, encoding, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(hash, content.byteLength, mime, encoding, Buffer.from(this.vault.sealText(content.toString('base64'), `blob:${hash}`)), createdAt);
  }

  insertFileSnapshot(snapshot: FileSnapshotInput): boolean {
    const result = this.db
      .prepare(`
      INSERT OR IGNORE INTO file_snapshots (
        id, event_id, session_id, sequence, path, phase, status, assurance, reason,
        blob_hash, byte_size, mime, file_mtime_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        snapshot.id,
        snapshot.eventId,
        snapshot.sessionId,
        snapshot.sequence,
        snapshot.path,
        snapshot.phase,
        snapshot.status,
        snapshot.assurance,
        snapshot.reason ?? null,
        snapshot.hash ?? null,
        snapshot.byteSize ?? null,
        snapshot.mime ?? null,
        snapshot.fileMtimeMs ?? null,
        snapshot.createdAt,
      );
    return Number(result.changes) > 0;
  }

  hasBeforeBoundary(event: EventInput, path: string): boolean {
    const row = this.db
      .prepare(`
      SELECT 1 present
      FROM file_snapshots fs
      LEFT JOIN events e ON e.id = fs.event_id
      WHERE fs.session_id = ? AND fs.path = ? AND fs.status IN ('captured', 'missing')
        AND (
          (fs.phase = 'before' AND (
            fs.event_id IN (
              SELECT sibling.event_id
              FROM call_event_links target
              JOIN call_event_links sibling ON sibling.attempt_event_id = target.attempt_event_id
              WHERE target.event_id = ?
            )
            OR (? IS NOT NULL AND e.call_id = ?)
          ))
          OR (fs.sequence < ? AND fs.phase IN ('after', 'observed'))
        )
      LIMIT 1
    `)
      .get(event.sessionId, path, event.id, event.callId, event.callId, event.sequence) as DbRow | undefined;
    return Boolean(row);
  }

  insertCaptureGap(source: EventInput, code: string, message: string, path = source.path): string | null {
    for (let offset = 1; offset <= 999; offset += 1) {
      const id = `gap:${createHash('sha256')
        .update(`${source.id}\u001f${code}\u001f${path ?? ''}`)
        .digest('hex')
        .slice(0, 24)}`;
      const gap: EventInput = {
        id,
        sessionId: source.sessionId,
        sequence: source.sequence + offset / 1000,
        timestamp: source.timestamp,
        durationMs: null,
        kind: 'gap',
        title: 'Capture gap',
        summary: message,
        status: 'blocked',
        actor: 'recorder',
        turnId: source.turnId,
        callId: source.callId,
        parentId: source.id,
        tokensIn: null,
        tokensOut: null,
        cachedTokens: null,
        costUsd: null,
        command: null,
        path,
        payload: { phase: 'gap', code, sourceEventId: source.id, message, path },
      };
      if (this.insertEventWithMetrics(gap)) return id;
      if (this.getEvent(id)) return id;
    }
    return null;
  }

  getCodeEvolution(eventId: string, requestedPath?: string | null): CodeEvolution | null {
    const eventRow = this.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as DbRow | undefined;
    if (!eventRow) return null;
    const event = rowToEvent(eventRow, false, this.vault);
    const payloadPaths =
      event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && Array.isArray((event.payload as Record<string, unknown>).paths)
        ? ((event.payload as Record<string, unknown>).paths as unknown[]).filter((value): value is string => typeof value === 'string' && value.length > 0)
        : [];
    const snapshotPathRows = this.db
      .prepare(`
      SELECT DISTINCT path FROM file_snapshots
      WHERE event_id = ? OR event_id IN (
        SELECT sibling.event_id
        FROM call_event_links target
        JOIN call_event_links sibling ON sibling.attempt_event_id = target.attempt_event_id
        WHERE target.event_id = ?
      )
      ORDER BY path
    `)
      .all(eventId, eventId) as DbRow[];
    const availablePaths = [
      ...new Set([event.path, ...payloadPaths, ...snapshotPathRows.map((row) => String(row.path))].filter((value): value is string => Boolean(value))),
    ];
    const path = requestedPath && availablePaths.includes(requestedPath) ? requestedPath : (availablePaths[0] ?? null);
    if (!path) return { eventId, path: null, availablePaths, before: null, after: null, unifiedDiff: null, diffTruncated: false, changed: null, gaps: [] };
    const rows = this.db
      .prepare(`
      SELECT fs.*
      FROM file_snapshots fs
      LEFT JOIN events e ON e.id = fs.event_id
      WHERE fs.session_id = ? AND fs.path = ?
        AND (
          fs.event_id = ?
          OR fs.event_id IN (
            SELECT sibling.event_id
            FROM call_event_links target
            JOIN call_event_links sibling ON sibling.attempt_event_id = target.attempt_event_id
            WHERE target.event_id = ?
          )
          OR (? IS NOT NULL AND e.call_id = ?)
        )
      ORDER BY fs.sequence ASC, fs.created_at ASC
    `)
      .all(event.sessionId, path, event.id, event.id, event.callId, event.callId) as DbRow[];
    let beforeRow = [...rows].reverse().find((row) => String(row.phase) === 'before');
    const afterRow = [...rows].reverse().find((row) => ['after', 'observed'].includes(String(row.phase)));
    if (!beforeRow) {
      beforeRow = this.db
        .prepare(`
        SELECT * FROM file_snapshots
        WHERE session_id = ? AND path = ? AND sequence < ?
          AND phase IN ('after', 'observed') AND status IN ('captured', 'missing')
        ORDER BY sequence DESC LIMIT 1
      `)
        .get(event.sessionId, path, event.sequence) as DbRow | undefined;
    }
    const before = beforeRow ? rowToSnapshot(beforeRow) : null;
    const after = afterRow ? rowToSnapshot(afterRow) : null;
    const beforeContent = beforeRow ? this.snapshotContent(beforeRow) : null;
    const afterContent = afterRow ? this.snapshotContent(afterRow) : null;
    let unifiedDiff: string | null = null;
    let diffTruncated = false;
    let changed: boolean | null = null;
    if (beforeContent !== null && afterContent !== null) {
      changed = beforeContent !== afterContent;
      const generated = createTwoFilesPatch(`${path} · before`, `${path} · after`, beforeContent, afterContent, '', '', { context: 5 });
      const maxDiffBytes = 2 * 1024 * 1024;
      diffTruncated = Buffer.byteLength(generated) > maxDiffBytes;
      unifiedDiff = diffTruncated ? `${generated.slice(0, maxDiffBytes)}\n… DIFF TRUNCATED BY RECORDER …\n` : generated;
    }
    const gapRows = this.db
      .prepare(`
      SELECT id, payload_json FROM events
      WHERE session_id = ? AND kind = 'gap' AND path = ?
        AND (
          parent_id = ?
          OR parent_id IN (
            SELECT sibling.event_id
            FROM call_event_links target
            JOIN call_event_links sibling ON sibling.attempt_event_id = target.attempt_event_id
            WHERE target.event_id = ?
          )
          OR (? IS NOT NULL AND call_id = ?)
        )
      ORDER BY sequence ASC
    `)
      .all(event.sessionId, path, event.id, event.id, event.callId, event.callId) as DbRow[];
    const gaps = gapRows.map((row) => {
      const payload = safeJson(this.vault.openText(String(row.payload_json), `event:${String(row.id)}:payload`)) as Record<string, unknown>;
      return { code: String(payload.code ?? 'unknown'), message: String(payload.message ?? 'Capture evidence unavailable'), eventId: String(row.id) };
    });
    return { eventId, path, availablePaths, before, after, unifiedDiff, diffTruncated, changed, gaps };
  }

  applyRetention(options: RetentionOptions): RetentionResult {
    const rawEvents = options.rawBefore
      ? Number((this.db.prepare('SELECT COUNT(*) count FROM events WHERE timestamp < ? AND raw_json IS NOT NULL').get(options.rawBefore) as DbRow).count)
      : 0;
    const snapshots = options.snapshotsBefore
      ? Number(
          (this.db.prepare("SELECT COUNT(*) count FROM file_snapshots WHERE created_at < ? AND status = 'captured'").get(options.snapshotsBefore) as DbRow)
            .count,
        )
      : 0;
    if (!options.apply) return { rawEvents, snapshots, blobs: 0, applied: false };
    return this.transaction(() => {
      let prunedRaw = 0;
      let prunedSnapshots = 0;
      if (options.rawBefore) {
        const result = this.db
          .prepare(`
          UPDATE events SET raw_json = NULL
          WHERE timestamp < ? AND raw_json IS NOT NULL
        `)
          .run(options.rawBefore);
        prunedRaw = Number(result.changes);
      }
      if (options.snapshotsBefore) {
        const result = this.db
          .prepare(`
          UPDATE file_snapshots
          SET status = 'pruned', reason = 'snapshot_retention', blob_hash = NULL
          WHERE created_at < ? AND status = 'captured'
        `)
          .run(options.snapshotsBefore);
        prunedSnapshots = Number(result.changes);
      }
      const blobResult = this.db
        .prepare('DELETE FROM content_blobs WHERE hash NOT IN (SELECT blob_hash FROM file_snapshots WHERE blob_hash IS NOT NULL)')
        .run();
      const blobs = Number(blobResult.changes);
      if (prunedRaw + prunedSnapshots + blobs > 0) {
        this.db
          .prepare(`
          INSERT INTO retention_runs (executed_at, raw_before, snapshots_before, raw_events_pruned, snapshots_pruned, blobs_pruned)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
          .run(new Date().toISOString(), options.rawBefore ?? null, options.snapshotsBefore ?? null, prunedRaw, prunedSnapshots, blobs);
      }
      return { rawEvents: prunedRaw, snapshots: prunedSnapshots, blobs, applied: true };
    });
  }

  private snapshotContent(row: DbRow): string | null {
    const status = String(row.status);
    if (status === 'missing') return '';
    if (status !== 'captured' || row.blob_hash === null) return null;
    const blob = this.db.prepare('SELECT content, encoding FROM content_blobs WHERE hash = ?').get(row.blob_hash) as DbRow | undefined;
    if (!blob?.content) return null;
    const encoded = this.vault.openText(blob.content as Uint8Array, `blob:${String(row.blob_hash)}`);
    return Buffer.from(encoded, 'base64').toString(String(blob.encoding) === 'utf8' ? 'utf8' : 'utf8');
  }

  getOverview(): Overview {
    const totals = this.db.prepare('SELECT COUNT(*) sessions, COALESCE(SUM(event_count), 0) events FROM sessions').get() as DbRow;
    const providers = this.db.prepare('SELECT provider, COUNT(*) count FROM sessions GROUP BY provider').all() as DbRow[];
    const last = this.db.prepare("SELECT value FROM recorder_meta WHERE key = 'last_ingested_at'").get() as DbRow | undefined;
    const schema = this.db.prepare("SELECT value FROM recorder_meta WHERE key = 'schema_version'").get() as DbRow | undefined;
    const evidence = this.db
      .prepare(`
      SELECT
        (SELECT COUNT(*) FROM file_snapshots) snapshots,
        (SELECT COUNT(*) FROM events WHERE kind = 'gap') capture_gaps
    `)
      .get() as DbRow;
    return {
      schemaVersion: Number(schema?.value ?? 1),
      sessions: Number(totals.sessions),
      events: Number(totals.events),
      providers: Object.fromEntries(providers.map((row) => [String(row.provider), Number(row.count)])),
      lastIngestedAt: last ? String(last.value) : null,
      dataPath: this.path,
      networkMode: 'loopback-only',
      snapshots: Number(evidence.snapshots),
      captureGaps: Number(evidence.capture_gaps),
      evidencePolicy: policySummary(this.policy),
      storageSecurity: {
        directoryMode: fileMode(dirname(this.path)),
        databaseMode: fileMode(this.path),
        databaseEncryption: 'aes-256-gcm-sensitive-columns',
        keyProvider: this.vault.keyProvider,
        keyFingerprint: this.vault.keyFingerprint,
        plaintextMetadata: true,
        boundary: 'local-user-filesystem',
      },
    };
  }

  getCaptureHealth(): CaptureHealth {
    const snapshotRows = this.db.prepare('SELECT status, COUNT(*) count FROM file_snapshots GROUP BY status').all() as DbRow[];
    const snapshots = { captured: 0, missing: 0, skipped: 0, error: 0, pruned: 0, total: 0 };
    for (const row of snapshotRows) {
      const status = String(row.status) as keyof Omit<typeof snapshots, 'total'>;
      if (status in snapshots) snapshots[status] = Number(row.count);
      snapshots.total += Number(row.count);
    }
    const gapRows = this.db
      .prepare(`
      SELECT COALESCE(gap_code, 'unknown') code, COUNT(*) count
      FROM events WHERE kind = 'gap' GROUP BY code ORDER BY count DESC
    `)
      .all() as DbRow[];
    const fileCoverage = this.db
      .prepare(`
      WITH file_events AS (
        SELECT id FROM events WHERE kind = 'file'
      ), evidence_events AS (
        SELECT event_id FROM file_snapshots
        UNION
        SELECT parent_id FROM events WHERE kind = 'gap' AND parent_id IS NOT NULL
      ), covered_ids AS (
        SELECT fe.id
        FROM file_events fe JOIN evidence_events evidence ON evidence.event_id = fe.id
        UNION
        SELECT fe.id
        FROM file_events fe
        JOIN call_event_links file_link ON file_link.event_id = fe.id
        JOIN call_event_links evidence_link ON evidence_link.attempt_event_id = file_link.attempt_event_id
        JOIN evidence_events evidence ON evidence.event_id = evidence_link.event_id
      )
      SELECT
        (SELECT COUNT(*) FROM file_events) file_events,
        (SELECT COUNT(*) FROM covered_ids) covered
    `)
      .get() as DbRow;
    const fileEvents = Number(fileCoverage.file_events);
    const coveredFileEvents = Number(fileCoverage.covered ?? 0);
    const uncoveredFileEvents = Math.max(0, fileEvents - coveredFileEvents);
    const calls = this.db
      .prepare(`
      SELECT
        COUNT(*) pending,
        SUM(CASE WHEN started_at < ? THEN 1 ELSE 0 END) stale
      FROM call_attempts WHERE outcome = 'running'
    `)
      .get(new Date(Date.now() - 5 * 60_000).toISOString()) as DbRow;
    const pendingCalls = Number(calls.pending ?? 0);
    const staleCalls = Number(calls.stale ?? 0);
    const permissionRows = this.db
      .prepare(`
      SELECT
        SUM(CASE WHEN outcome = 'pending' THEN 1 ELSE 0 END) pending,
        SUM(CASE WHEN outcome = 'unknown' THEN 1 ELSE 0 END) unknown,
        SUM(CASE WHEN outcome = 'denied' AND assurance = 'explicit' THEN 1 ELSE 0 END) explicit_denials,
        SUM(CASE WHEN outcome = 'executed' AND assurance = 'inferred' THEN 1 ELSE 0 END) inferred_executions
      FROM permission_flows
    `)
      .get() as DbRow;
    const now = Date.now();
    const heartbeatRows = this.db.prepare('SELECT * FROM recorder_heartbeats ORDER BY component').all() as DbRow[];
    return {
      status:
        fileEvents === 0 && pendingCalls === 0
          ? 'idle'
          : uncoveredFileEvents > 0 || staleCalls > 0 || Number(permissionRows.unknown ?? 0) > 0
            ? 'degraded'
            : 'healthy',
      fileEvents,
      coveredFileEvents,
      uncoveredFileEvents,
      snapshots,
      gaps: {
        total: gapRows.reduce((sum, row) => sum + Number(row.count), 0),
        byCode: Object.fromEntries(gapRows.map((row) => [String(row.code), Number(row.count)])),
      },
      calls: { pending: pendingCalls, stale: staleCalls },
      permissions: {
        pending: Number(permissionRows.pending ?? 0),
        unknown: Number(permissionRows.unknown ?? 0),
        explicitDenials: Number(permissionRows.explicit_denials ?? 0),
        inferredExecutions: Number(permissionRows.inferred_executions ?? 0),
      },
      delivery: {
        components: heartbeatRows.map((row) => {
          const lastSeenAt = String(row.last_seen_at);
          const ageMs = Math.max(0, now - Date.parse(lastSeenAt));
          return { component: String(row.component), lastSeenAt, ageMs, state: ageMs <= 30_000 ? ('active' as const) : ('idle' as const) };
        }),
        limitation:
          'A recorder can audit configured coverage and received heartbeats, but no hook can prove an event for which the provider never launched that hook.',
      },
    };
  }

  getSessions(options: { provider?: string; query?: string; limit?: number } = {}): RecordedSession[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (options.provider && options.provider !== 'all') {
      clauses.push('provider = ?');
      params.push(options.provider);
    }
    if (options.query) {
      clauses.push('(title LIKE ? OR project_name LIKE ? OR cwd LIKE ?)');
      const needle = `%${options.query}%`;
      params.push(needle, needle, needle);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params) as DbRow[];
    return rows.map(rowToSession);
  }

  getSession(id: string): RecordedSession | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as DbRow | undefined;
    return row ? rowToSession(row) : null;
  }

  compareSessions(leftId: string, rightId: string): SessionComparison | null {
    const left = this.getSession(leftId);
    const right = this.getSession(rightId);
    if (!left || !right) return null;
    const kinds = (sessionId: string): Record<string, number> =>
      Object.fromEntries(
        (this.db.prepare('SELECT kind, COUNT(*) count FROM events WHERE session_id = ? GROUP BY kind').all(sessionId) as DbRow[]).map((row) => [
          String(row.kind),
          Number(row.count),
        ]),
      );
    const leftKinds = kinds(leftId);
    const rightKinds = kinds(rightId);
    const kindNames = [...new Set([...Object.keys(leftKinds), ...Object.keys(rightKinds)])] as EventKind[];
    const paths = (sessionId: string): string[] =>
      (
        this.db
          .prepare(`
      SELECT path FROM (
        SELECT path FROM events WHERE session_id = ? AND kind = 'file' AND path IS NOT NULL
        UNION SELECT path FROM file_snapshots WHERE session_id = ?
      ) ORDER BY path
    `)
          .all(sessionId, sessionId) as DbRow[]
      ).map((row) => String(row.path));
    const leftFiles = paths(leftId);
    const rightFiles = paths(rightId);
    const leftSet = new Set(leftFiles);
    const rightSet = new Set(rightFiles);
    const metricKeys = Object.keys(EMPTY_METRICS) as Array<keyof SessionMetrics>;
    const metricDelta = Object.fromEntries(metricKeys.map((key) => [key, right.metrics[key] - left.metrics[key]])) as unknown as SessionMetrics;
    return {
      left: sessionIdentity(left),
      right: sessionIdentity(right),
      durationDeltaMs: sessionDuration(right) - sessionDuration(left),
      metricDelta,
      kindDelta: Object.fromEntries(kindNames.map((kind) => [kind, (rightKinds[kind] ?? 0) - (leftKinds[kind] ?? 0)])),
      files: {
        shared: leftFiles.filter((path) => rightSet.has(path)),
        leftOnly: leftFiles.filter((path) => !rightSet.has(path)),
        rightOnly: rightFiles.filter((path) => !leftSet.has(path)),
      },
    };
  }

  getEvents(sessionId: string, options: { kinds?: EventKind[]; query?: string; limit?: number } = {}): RecorderEvent[] {
    const clauses = ['session_id = ?'];
    const params: SqlValue[] = [sessionId];
    if (options.kinds?.length) {
      clauses.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`);
      params.push(...options.kinds);
    }
    if (options.query) {
      clauses.push('(title LIKE ? OR summary LIKE ? OR command LIKE ? OR path LIKE ?)');
      const needle = `%${options.query}%`;
      params.push(needle, needle, needle, needle);
    }
    params.push(Math.min(Math.max(options.limit ?? 100_000, 1), 100_000));
    const rows = this.db
      .prepare(`
      SELECT
        id, session_id, sequence, timestamp, duration_ms, kind, title, summary, status,
        actor, turn_id, call_id, parent_id, tokens_in, tokens_out, cached_tokens, cost_usd,
        command, path, '{}' payload_json, NULL raw_json
      FROM events WHERE ${clauses.join(' AND ')} ORDER BY sequence ASC LIMIT ?
    `)
      .all(...params) as DbRow[];
    return rows.map((row) => rowToEvent(row, false, this.vault));
  }

  getEvent(id: string): RecorderEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as DbRow | undefined;
    return row ? rowToEvent(row, true, this.vault) : null;
  }

  getSessionEventsDetailed(sessionId: string): RecorderEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY sequence ASC').all(sessionId) as DbRow[];
    return rows.map((row) => rowToEvent(row, true, this.vault));
  }

  getSessionSnapshotEvidence(sessionId: string): SnapshotEvidence[] {
    const rows = this.db
      .prepare(`
      SELECT fs.*, cb.content
      FROM file_snapshots fs LEFT JOIN content_blobs cb ON cb.hash = fs.blob_hash
      WHERE fs.session_id = ? ORDER BY fs.sequence ASC, fs.path ASC, fs.phase ASC
    `)
      .all(sessionId) as DbRow[];
    return rows.map((row) => ({
      snapshot: rowToSnapshot(row),
      contentBase64: row.content === null ? null : this.vault.openText(row.content as Uint8Array, `blob:${String(row.blob_hash)}`),
    }));
  }

  getCallInvocation(sessionId: string, callId: string): RecorderEvent | null {
    const row = this.db
      .prepare(`
      SELECT * FROM events
      WHERE session_id = ? AND call_id = ? AND phase = 'call'
      ORDER BY sequence DESC LIMIT 1
    `)
      .get(sessionId, callId) as DbRow | undefined;
    return row ? rowToEvent(row, false, this.vault) : null;
  }

  nextSequence(sessionId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), -10) + 10 next_sequence FROM events WHERE session_id = ?').get(sessionId) as DbRow;
    return Number(row.next_sequence);
  }

  allocateSequences(sessionId: string, count = 1): number {
    return this.transaction(() => {
      this.db
        .prepare(`
        INSERT OR IGNORE INTO event_sequences (session_id, next_sequence)
        SELECT ?, COALESCE(MAX(sequence), -10) + 10 FROM events WHERE session_id = ?
      `)
        .run(sessionId, sessionId);
      const row = this.db.prepare('SELECT next_sequence FROM event_sequences WHERE session_id = ?').get(sessionId) as DbRow;
      const first = Number(row.next_sequence);
      this.db.prepare('UPDATE event_sequences SET next_sequence = next_sequence + ? WHERE session_id = ?').run(Math.max(1, count) * 10, sessionId);
      return first;
    });
  }
}

function rowToSession(row: DbRow): RecordedSession {
  const metrics = { ...EMPTY_METRICS };
  metrics.totalEvents = Number(row.event_count);
  metrics.toolCalls = Number(row.tool_calls);
  metrics.fileChanges = Number(row.file_changes);
  metrics.terminalCommands = Number(row.terminal_commands);
  metrics.testRuns = Number(row.test_runs);
  metrics.errors = Number(row.errors);
  metrics.retries = Number(row.retries);
  metrics.captureGaps = Number(row.capture_gaps);
  metrics.tokensIn = Number(row.tokens_in);
  metrics.tokensOut = Number(row.tokens_out);
  metrics.cachedTokens = Number(row.cached_tokens);
  metrics.costUsd = Number(row.cost_usd);
  return {
    id: String(row.id),
    provider: String(row.provider) as RecordedSession['provider'],
    nativeSessionId: String(row.native_session_id),
    title: String(row.title),
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    updatedAt: String(row.updated_at),
    cwd: row.cwd === null ? null : String(row.cwd),
    projectName: String(row.project_name),
    agentVersion: row.agent_version === null ? null : String(row.agent_version),
    model: row.model === null ? null : String(row.model),
    sourcePath: String(row.source_path),
    status: String(row.status) as RecordedSession['status'],
    metrics,
  };
}

function sessionIdentity(session: RecordedSession): SessionComparison['left'] {
  return { id: session.id, title: session.title, provider: session.provider, startedAt: session.startedAt, updatedAt: session.updatedAt };
}

function sessionDuration(session: RecordedSession): number {
  return Math.max(0, new Date(session.endedAt ?? session.updatedAt).getTime() - new Date(session.startedAt).getTime());
}

function rowToSnapshot(row: DbRow): FileSnapshot {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    sessionId: String(row.session_id),
    sequence: Number(row.sequence),
    path: String(row.path),
    phase: String(row.phase) as FileSnapshot['phase'],
    status: String(row.status) as FileSnapshot['status'],
    assurance: String(row.assurance) as FileSnapshot['assurance'],
    reason: row.reason === null ? null : String(row.reason),
    hash: row.blob_hash === null ? null : String(row.blob_hash),
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    mime: row.mime === null ? null : String(row.mime),
    createdAt: String(row.created_at),
  };
}

function rowToCallAttempt(row: DbRow): CallAttempt {
  return {
    eventId: String(row.event_id),
    sessionId: String(row.session_id),
    callId: row.call_id === null ? null : String(row.call_id),
    signature: String(row.signature),
    correlationKey: String(row.correlation_key),
    attempt: Number(row.attempt),
    previousEventId: row.previous_event_id === null ? null : String(row.previous_event_id),
    resultEventId: row.result_event_id === null ? null : String(row.result_event_id),
    outcome: String(row.outcome) as CallAttempt['outcome'],
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    startObserved: Number(row.start_observed) === 1,
    facets: Number(row.facets ?? 1),
  };
}

function rowToPermissionFlow(row: DbRow): PermissionFlow {
  return {
    requestEventId: String(row.request_event_id),
    sessionId: String(row.session_id),
    signature: row.signature === null ? null : String(row.signature),
    callId: row.call_id === null ? null : String(row.call_id),
    tool: row.tool === null ? null : String(row.tool),
    outcome: String(row.outcome) as PermissionFlow['outcome'],
    assurance: String(row.assurance) as PermissionFlow['assurance'],
    decisionEventId: row.decision_event_id === null ? null : String(row.decision_event_id),
    requestedAt: String(row.requested_at),
    decidedAt: row.decided_at === null ? null : String(row.decided_at),
    providerEvent: row.provider_event === null ? null : String(row.provider_event),
    reason: row.reason === null ? null : String(row.reason),
  };
}

function rowToEvent(row: DbRow, includeRaw: boolean, vault: EvidenceVault): RecorderEvent {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sequence: Number(row.sequence),
    timestamp: String(row.timestamp),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    kind: String(row.kind) as RecorderEvent['kind'],
    title: String(row.title),
    summary: String(row.summary),
    status: String(row.status) as RecorderEvent['status'],
    actor: row.actor === null ? null : String(row.actor),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    callId: row.call_id === null ? null : String(row.call_id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    tokensIn: row.tokens_in === null ? null : Number(row.tokens_in),
    tokensOut: row.tokens_out === null ? null : Number(row.tokens_out),
    cachedTokens: row.cached_tokens === null ? null : Number(row.cached_tokens),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    command: row.command === null ? null : String(row.command),
    path: row.path === null ? null : String(row.path),
    payload: safeJson(vault.openText(String(row.payload_json), `event:${String(row.id)}:payload`)),
    raw: includeRaw && row.raw_json !== null ? safeJson(vault.openText(String(row.raw_json), `event:${String(row.id)}:raw`)) : undefined,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function decisionReason(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const decision = record(value);
  return textValue(decision.reason) ?? textValue(decision.message) ?? textValue(decision.behavior);
}

function callOutcomeRank(outcome: string): number {
  if (outcome === 'blocked') return 5;
  if (outcome === 'error') return 4;
  if (outcome === 'success') return 3;
  if (outcome === 'unknown') return 2;
  return 1;
}

function mergeCallOutcome(current: string, next: string): CallAttempt['outcome'] {
  return (callOutcomeRank(next) >= callOutcomeRank(current) ? next : current) as CallAttempt['outcome'];
}

function isFailedCallOutcome(outcome: string): boolean {
  return outcome === 'error' || outcome === 'blocked';
}

function shouldInferRetry(previous: DbRow, event: EventInput): boolean {
  const sameTurn = event.turnId !== null && previous.previous_turn_id !== null && event.turnId === String(previous.previous_turn_id);
  const elapsedMs = Math.max(0, Date.parse(event.timestamp) - Date.parse(String(previous.previous_timestamp)));
  return sameTurn || elapsedMs <= 5 * 60_000;
}

function areProviderFacets(left: string | null, right: string | null): boolean {
  if (!left || !right || left.toLowerCase() === right.toLowerCase()) return false;
  const family = (value: string): string => {
    const normalized = value.toLowerCase().replace(/[_\s.-]+/g, '');
    if (normalized === 'pretooluse') return 'generic';
    if (normalized.includes('shell')) return 'shell';
    if (normalized.includes('mcp')) return 'mcp';
    if (normalized.includes('readfile')) return 'read';
    if (normalized.includes('fileedit') || normalized.includes('filewrite')) return 'file';
    return normalized;
  };
  const leftFamily = family(left);
  const rightFamily = family(right);
  return leftFamily === 'generic' || rightFamily === 'generic';
}

function fileMode(path: string): string | null {
  try {
    return `0${(statSync(path).mode & 0o777).toString(8).padStart(3, '0')}`;
  } catch {
    return null;
  }
}
