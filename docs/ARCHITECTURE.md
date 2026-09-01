# Architecture

Agent Flight Recorder is a local evidence pipeline, not a chat exporter.

```text
native logs / provider hooks / compatible envelope
                         |
                         v
               provider adapters
                         |
                         v
             canonical append-only events
                         |
            +------------+-------------+
            |                          |
            v                          v
      capture-gap ledger     content-addressed snapshots
            |                          |
            +------------+-------------+
                         v
          encrypted evidence columns / SQLite WAL
                         |
                  loopback HTTP + SSE
                         |
                         v
        replay timeline / inspector / code evolution
```

## Capture surfaces

| Provider | Surface | Current implementation |
| --- | --- | --- |
| Codex | Official command hooks + version-tested transcript backfill | All 11 documented lifecycle hooks supported. Incremental JSONL ingestion provides backfill and best-effort snapshots, but the transcript schema is not a stable Codex interface. |
| OpenCode | Version-tested internal SQLite/WAL | Read-only import of sessions, messages, parts, tools, files, tokens, cost, and historical file gaps. The current path/schema are implementation details, not a stable API. |
| Claude Code | Official command hooks | All 33 documented events supported; synchronous file hooks capture exact boundaries when possible. |
| Cursor | Official native command hooks | All 21 documented local IDE/CLI events supported; synchronous file hooks capture exact boundaries when possible. Cloud-agent coverage is smaller. |
| Compatible agents | `afr.event.v1` JSON over stdin or loopback HTTP | Versioned permissive envelope; unknown fields retained. |

The adapters normalize provider records but always retain the original input on detailed events. Unknown native records become `context` or `lifecycle` events rather than disappearing.

## Canonical event model

Every event has a stable ID, session ID, monotonically increasing sequence, timestamp, kind, title, summary, status, actor, correlation IDs, optional resource usage, command/path fields, a normalized payload, and optional raw evidence.

Kinds are deliberately operational: `prompt`, `reasoning`, `response`, `tool`, `terminal`, `file`, `test`, `permission`, `token`, `retry`, `gap`, `context`, `lifecycle`, `error`, and `artifact`.

Test events are classified from command semantics because none of the supported providers emits a universal first-class test signal. The call-attempt ledger correlates calls/results by native call ID when available and by a bounded canonical action key when it is not. Schema v7 adds event-to-attempt links so generic and specialized provider callbacks remain replayable as separate native facets while metrics, outcomes, retries, stale boundaries, and code evidence describe one logical action. Retry events are rebuilt only when an identical invocation follows an observed failed or blocked attempt in the same turn or within five minutes; a repeated successful or distant call is a new attempt, not a retry.

Schema v5 adds permission flows. Provider-reported allow/deny results are `explicit`; a correlated completed tool after a request is `executed / inferred`; and an unmatched request becomes `unknown / unresolved` after five minutes. This deliberately avoids turning execution evidence into a fabricated manual approval.

## Storage and query path

- SQLite runs in WAL mode so the console, scanner, and short-lived hook processes can safely share one local database.
- Schema v7 seals normalized payloads, native raw envelopes, and snapshot blobs with per-record AES-256-GCM nonces and authenticated purpose strings. macOS uses a path-scoped login-Keychain key; an environment key and protected-file fallback are supported. Indexed metadata remains plaintext and the overview API says so explicitly.
- Version-tested Codex transcript sources track byte offsets, size, and modification time. Appended lines are ingested without replaying a multi-gigabyte source.
- Each Codex read is bounded to its opening `stat()` size so a growing JSONL can never advance the stored offset beyond the recorded source boundary. Automatic native scans run in a separate process, keeping loopback API/SSE latency independent from parsing and encryption work.
- OpenCode imports are source-versioned by the combined database/WAL size and latest modification time, so uncheckpointed native writes are detected.
- Session metrics are derived from logical call attempts plus non-action events, so overlapping generic/specialized callbacks do not double-count tools, tests, files, or failures.
- Timeline list queries omit raw and normalized payload bodies. Detail queries fetch them on demand.
- The web timeline virtualizes rows, so a 30,000-event flight remains navigable without mounting 30,000 DOM nodes.
- Schema version `7` is stored in `recorder_meta` and exposed through the overview API. Source rows carry adapter versions so a changed normalizer can safely reindex derived sessions. Forward migrations backfill pre-snapshot gaps, durable call/retry lineage, no-ID facet links, permission flows, query index columns, encryption canaries, and encrypted evidence.

## Code-evolution evidence

Text snapshots are hashed with SHA-256 and deduplicated in `content_blobs`. `file_snapshots` records the event/path boundary, phase (`before`, `after`, or `observed`), capture status, assurance, byte size, MIME type, and omission reason. File creation and deletion use a deliberate `missing` boundary rather than treating absence as failure.

The evolution query correlates boundaries by session, path, logical action links, and provider call ID when one exists. It can fall back to the most recent prior after-state as the next mutation's before-state, then generates a bounded unified diff. Multi-file mutations retain every discovered path and expose a per-file selector. Snapshot content is fetched only for the selected event and path.

Evidence is labeled:

- `exact`: captured synchronously around a provider hook.
- `best-effort`: observed from an append-only log where notification timing cannot prove a true pre-state.
- `reconstructed`: reserved for evidence rebuilt from an independently verifiable source.

A missing, skipped, unsafe, historical, or failed boundary produces a canonical `gap` event linked to its source event. `getCaptureHealth()` and `/api/health` report file-event coverage, snapshot states, gap counts grouped by reason, stale calls, permission assurance, and component heartbeats.

## Evidence policy and lifecycle

The store sanitizes each event before insertion. `mask` is the default and redacts common credential-bearing keys and inline credential formats; `strict` additionally omits raw native records; `off` is an explicit exact-evidence choice. Invalid environment or CLI policy values fail before storage opens. Snapshot text goes through the same inline masker, and known sensitive paths are always excluded. The policy and size/retention settings are surfaced in the overview API so a replay remains interpretable.

Raw retention nulls only `raw_json`, keeping canonical payloads, call phases, IDs, and metrics intact. Snapshot retention marks provenance as `pruned`, drops the blob reference, and deletes unreferenced content-addressed blobs. Automatic retention runs only when its environment policy is configured; manual pruning is dry-run-first.

## Runtime boundary

The server rejects non-loopback bind addresses and non-loopback `Host` headers. Mutating requests with an `Origin` header must also originate from loopback, and the static console is served with a self-only content security policy. API responses carry request IDs; unexpected server failures are logged locally in structured form while clients receive a bounded error rather than an internal implementation message. It exposes:

- `GET /api/health`, `/api/overview`, `/api/sessions`
- `GET /api/sessions/:id/events`, `/api/events/:id`
- `GET /api/events/:id/evolution`, `/api/events/:id/lineage`, `/api/events/:id/permissions`
- `GET /api/compare?left=:id&right=:id`
- `POST /api/scan`
- `POST /api/hooks/:provider/:event`
- `GET /api/stream` for server-sent live updates

The production server also serves the built console. Development uses Vite on `127.0.0.1:4173` and proxies the API to `127.0.0.1:4174`.

## Demonstration boundary

`demo` uses an isolated `.flight-recorder-demo` store, ignores ambient production `AFR_DATA_DIR` configuration, forces masking, disables native discovery, rejects HTTP scan and live-hook ingestion, and seeds two deterministic compatible-agent flights. Sandbox health responses contain only a synthetic `demo://` source and the overview replaces its absolute database path with a stable relative label. The scenario exercises failure, permission, exact before/after snapshots, retry correlation, resource usage, comparison, and successful completion without reading user evidence. `demo --reset` deletes only the demo database files named inside the selected demo data directory; it does not touch the production store or storage key.

The development launcher preserves this boundary: `npm run dev` starts the sandbox and chooses a free loopback web/API port pair, while the intentionally named `npm run dev:private` starts native local capture. Vite receives the selected API port through the child-process environment; it is never hard-wired to a separate private recorder.

## Provider-grounded limits

- Codex can preserve encrypted reasoning payloads and expose their size, but the recorder does not claim to decrypt hidden reasoning.
- The installed Claude Code command-hook adapter does not expose hidden reasoning or complete general token/cost usage. Claude's separate opt-in OpenTelemetry surface is not ingested yet.
- The installed Cursor local-hook adapter exposes completed thought blocks but no dedicated token/cost event or explicit native manual permission outcome. Cursor's enterprise OpenTelemetry surface is not ingested yet.
- Claude `FileChanged` reports path/change type rather than a diff, and Cursor `afterFileEdit` supplies edit hunks rather than a guaranteed full snapshot. Local command hooks can read the resulting workspace file, but that evidence is still bounded by path, timing, and local permissions.
- Recorder hook processes always return success by default, including after a local capture failure. The recorder audits configured event coverage, timestamps hook/scanner/server heartbeats, and uses SQLite external-commit detection to push standalone hook receipts into SSE. Provider timeout behavior differs, and a hook process that the provider never launches is fundamentally unobservable to that same hook, so `healthy` still does not mean every theoretical provider event was delivered.
- Health also reports tool calls with no correlated result and marks those older than five minutes as stale. Automatic scans materialize each stale unmatched call once as a linked `tool_result_unavailable` gap. User-level Codex/Claude/Cursor source health is based on configured event coverage, not provider-directory existence. Codex health separately reports whether its version-tested JSONL backfill is present. Project-level hook installations cannot be globally enumerated.
- Claude permission requests do not expose a normal tool-use correlation ID, and manual permission-response coverage is not universal. Cursor has no dedicated native manual permission outcome.
- Cursor `beforeReadFile` and `beforeTabFileRead` do not have paired after events. When no generic post-tool callback exists, the recorder closes that action with an `unknown` outcome instead of inventing a result or later marking it stale.
- Claude/Cursor hooks do not expose complete universal token/cost telemetry. Missing resource usage remains null rather than estimated.

## Remaining external boundaries

Real Claude Code and Cursor runtime validation remains environment-dependent when those products are not installed or their user hook files are intentionally absent. No in-process callback can prove that a provider failed to launch it; the product therefore exposes configuration coverage, last receipts, heartbeats, and correlated gaps as separate evidence instead of a false completeness percentage. Parallel identical provider actions that expose no call ID can be temporally ambiguous; the recorder retains every callback, uses the nearest compatible action within the same turn/window, and surfaces missing starts/results rather than claiming a stronger identity. Full-page SQLite encryption is also outside Node's built-in SQLite engine; schema 7 encrypts sensitive evidence columns while reporting the metadata that remains plaintext.
