# Agent Flight Recorder

A local black box for AI coding agents. It turns native execution traces into an operational timeline of prompts, reasoning stages, tool calls, file edits, terminal commands, tests, retries, token usage, permission signals, failures, and code evolution—without shipping the evidence to a cloud service.

## What works now

- Incremental Codex JSONL capture, validated against real local sessions.
- Read-only OpenCode SQLite capture, validated against a real local store.
- A fail-open stdin hook bridge for all currently documented Claude Code and Cursor hook events.
- A versioned compatible-agent JSON envelope and loopback ingestion endpoint.
- A normalized append-only SQLite event store with authenticated encryption for normalized payloads, native raw evidence, and snapshot blobs.
- Durable provider-independent call attempts, retry lineage, permission outcomes with assurance labels, and component delivery heartbeats.
- Content-addressed, deduplicated text snapshots with exact hook-time before/after diffs and explicit assurance labels.
- First-class capture-gap events and coverage health instead of silently inventing missing evidence.
- Ingestion-time secret masking, sensitive-file exclusion, size limits, and dry-run-first raw/snapshot retention.
- A live local API and SSE update channel, hard-bound to loopback.
- An industrial replay console with session/provider search, signal filters, time scrubber, keyboard stepping, autoplay, event inspector, raw evidence, resource meters, snapshot provenance, and unified code diffs.
- Virtualized event rendering and lightweight list projections for very large flights.

## Start the recorder

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run build
npm run scan
npm start
```

Open `http://127.0.0.1:4174`.

Pass `--no-scan` to `serve` for a hook-only recorder that does not automatically discover native Codex/OpenCode stores. Manual `POST /api/scan` and the console's **SCAN NOW** control remain available.

The default scan imports every discovered Codex session plus the local OpenCode database. To bound a one-off manual scan, pass an explicit limit:

```bash
npm run scan -- --limit=12
```

Useful commands:

```bash
npm run doctor
npm run verify
npm run dev
```

Set `AFR_DATA_DIR` or pass `--data-dir=/absolute/path` to place the SQLite database elsewhere.

On macOS, the recorder creates a path-scoped 256-bit storage key in the login Keychain. `AFR_STORE_KEY` can supply an exact 32-byte base64/hex key instead; non-Keychain platforms fall back to a private `recorder.db.key` file. The data directory is forced to mode `0700` and database/WAL/key files to `0600` on Unix. Schema 7 encrypts evidence-bearing payload, raw, and snapshot-blob columns with AES-256-GCM; query/index metadata such as timestamps, kinds, summaries, commands, and paths remains plaintext and is reported as such by `/api/overview`.

## Evidence policy

The default policy preserves provider evidence locally and skips known sensitive file paths such as `.env`, private keys, credentials, and certificate stores. Configure future ingestion with environment variables or matching CLI flags:

```bash
AFR_REDACTION_MODE=mask \
AFR_RAW_RETENTION_DAYS=30 \
AFR_SNAPSHOT_RETENTION_DAYS=90 \
AFR_SNAPSHOT_MAX_BYTES=2097152 \
npm start
```

`mask` redacts common credential fields and inline secret formats from normalized and raw records. `strict` also omits the native raw record. These settings affect newly ingested evidence; they do not rewrite an existing database.

Preview retention before applying it:

```bash
node build/server/cli.js prune --raw-older-than=30 --snapshots-older-than=90
node build/server/cli.js prune --raw-older-than=30 --snapshots-older-than=90 --apply
```

Raw retention removes native provider payloads while preserving normalized timeline/correlation data. Snapshot retention removes old content blobs while retaining provenance rows marked `pruned`.

## Claude Code hooks

Build first, then generate a complete settings fragment:

```bash
node build/server/cli.js config --provider=claude --data-dir="$PWD/.flight-recorder"
```

Merge the printed `hooks` object into `~/.claude/settings.json` for user-wide local capture or `.claude/settings.local.json` for one project. Do not overwrite existing hooks. The generator uses exec-form command hooks, a five-second timeout, and a fast synchronous recorder command.

Or use the managed installer. It structurally merges existing JSON, is a dry run unless `--apply` is present, deduplicates recorder handlers, and creates a timestamped backup before every change:

```bash
node build/server/cli.js install-hooks --provider=claude --scope=user --data-dir="$PWD/.flight-recorder"
node build/server/cli.js install-hooks --provider=claude --scope=user --data-dir="$PWD/.flight-recorder" --apply
```

The bridge covers all 31 current official events, including session lifecycle, prompt submission/expansion, message display, tool calls/results/failures/batches, permission asks and auto-mode denials, subagents/tasks, configuration and filesystem changes, compaction, worktrees, elicitation, and stop failures. Claude’s official hook contract does not expose hidden reasoning or complete general token/cost usage, so the recorder does not fabricate them. See the official [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

## Cursor hooks

Generate a native Cursor `hooks.json` fragment:

```bash
node build/server/cli.js config --provider=cursor --data-dir="$PWD/.flight-recorder"
```

Merge it into `~/.cursor/hooks.json` for user-wide local capture or `<project>/.cursor/hooks.json` for a project. The generated configuration registers all 21 documented native events and sets `failClosed: false`, so recorder failure does not block the agent.

The same dry-run-first managed flow is available for Cursor:

```bash
node build/server/cli.js install-hooks --provider=cursor --scope=user --data-dir="$PWD/.flight-recorder"
node build/server/cli.js install-hooks --provider=cursor --scope=user --data-dir="$PWD/.flight-recorder" --apply
```

Use `--scope=project --project-root=/absolute/project` for local project configuration. Removal targets only handlers carrying the recorder installation marker:

```bash
node build/server/cli.js uninstall-hooks --provider=cursor --scope=user
node build/server/cli.js uninstall-hooks --provider=cursor --scope=user --apply
node build/server/cli.js rollback-hooks --provider=cursor --scope=user --backup=/path/from/install-receipt --apply
```

Cursor supplies completed thought blocks and detailed shell/file events, but its hook API has no dedicated token/cost event or universal manual permission-result event. Those gaps stay explicit. See the official [Cursor hooks reference](https://cursor.com/docs/hooks).

## Snapshot assurance

- Synchronous Claude Code, Cursor, and compatible-agent pre/post file hooks can capture exact boundaries when a path resolves to a regular text file inside the reported workspace.
- Incremental Codex log observation is labeled `best-effort`; append-only notification can arrive after a mutation has already completed.
- Historical Codex and OpenCode imports emit `gap` events for file actions whose past contents cannot be reconstructed honestly.
- Missing files are valid boundaries, enabling creation/deletion diffs. Binary, oversized, sensitive, unreadable, and out-of-workspace files produce explicit gap reasons.

Run `npm run doctor` or inspect `GET /api/health` for covered/uncovered file-event counts, snapshot states, and gap codes.

The same health response exposes stale call boundaries, unresolved permission requests, recorder-component heartbeats, and user-hook configuration coverage. Standalone hook commits are detected through SQLite `data_version` and pushed into the live SSE console without waiting for a native-source scan.

## Compare and carry flights

Select **COMPARE TARGET** in the replay console to compare any two normalized sessions—even from different providers. The comparison reports metric/event-kind deltas, duration, failures, gaps, and shared/unique affected files. The same data is available from `GET /api/compare?left=SESSION_ID&right=SESSION_ID`.

Portable bundles include one session, its detailed events/raw evidence, snapshot provenance, and referenced content blobs. Encryption is the default: AES-256-GCM authentication over a gzip archive, with a per-bundle salt and scrypt-derived key. The passphrase is never stored in the bundle.

```bash
export AFR_BUNDLE_PASSPHRASE='use-a-long-local-passphrase'
node build/server/cli.js export --session='codex:SESSION_ID' --out=./flight.afr
node build/server/cli.js import --in=./flight.afr --data-dir=./restored-recorder
```

Export refuses to overwrite unless `--force` is explicit; import refuses an existing session unless `--merge` is explicit. Bundle files are created with mode `0600`. `--unencrypted` is available only as an explicit export choice. Imported events and snapshots are checked for integrity and reprocessed through the destination recorder's redaction policy. See [the bundle format](docs/flight-bundle-v1.md).

## Compatible agents

Post the [`afr.event.v1`](docs/compatible-event-v1.schema.json) envelope to the loopback server:

```bash
curl --fail --silent \
  -H 'content-type: application/json' \
  --data '{
    "schema":"afr.event.v1",
    "sessionId":"demo-01",
    "event":"tool.before",
    "timestamp":"2026-08-20T21:00:00.000Z",
    "cwd":"/workspace/app",
    "toolName":"shell",
    "command":"npm test",
    "callId":"call-7"
  }' \
  http://127.0.0.1:4174/api/hooks/compatible/tool.before
```

Or pipe the same JSON over stdin when the server is not running:

```bash
printf '%s' "$EVENT_JSON" | node build/server/cli.js hook \
  --provider=compatible \
  --data-dir="$PWD/.flight-recorder"
```

Unknown fields are preserved. Event names use semantic patterns such as `prompt.submit`, `tool.before`, `tool.after`, `tool.failure`, `permission.request`, `reasoning.complete`, `response.complete`, `file.changed`, `session.start`, and `session.end`.

## Evidence and checks

```bash
npm run check     # strict web and server TypeScript
npm test          # adapters, evidence, bundles, hooks, installer, and store behavior
npm run build     # production server + console
npm audit         # dependency advisories
```

The architecture, provider limits, API, and external observability boundaries are documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Security assumptions and current privacy gaps are explicit in [SECURITY.md](SECURITY.md). The requirement-level implementation and live verification record is in [docs/COMPLETION_AUDIT.md](docs/COMPLETION_AUDIT.md).
