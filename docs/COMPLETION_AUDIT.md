# Completion audit

Audit date: 2026-08-21 (Europe/Paris)

Agent Flight Recorder is complete for the local evidence surfaces that the supported providers currently expose. “Complete” does not mean that provider-private or non-emitted data is reconstructed; unavailable evidence is represented as null, an unknown assurance state, or a first-class capture gap.

## Requirement matrix

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Capture every locally exposed action | All discovered Codex rollouts are imported by default; OpenCode reads its native SQLite database and WAL; all 31 Claude Code and 21 native Cursor hook events are configured and normalized; compatible agents use `afr.event.v1`. Unknown native records are retained instead of dropped. | Live store has 114/114 Codex sources on adapter v5 and one WAL-aware OpenCode source. Contract fixtures ingest 31/31 Claude and 21/21 Cursor events. |
| Preserve native evidence | Detailed events retain the native envelope, while list queries use lightweight projections. Evidence-bearing payload, raw, and blob columns are sealed independently. | Live database has zero unsealed payloads, raw envelopes, or content blobs. AES-256-GCM uses the macOS Keychain in the audited deployment. |
| Correlate tools, results, retries, and provider facets | Schema v7 stores logical attempts and event-to-attempt links. Native IDs are preferred; bounded turn/time/action keys handle providers that omit IDs. Generic and specialized callbacks remain separate events but count once. Retries require a failed/blocked identical action in the same turn or within five minutes. | No phase-call/result action in the live store lacks a link; no attempt lacks its canonical link; no derived retry has an orphan parent; session metrics exactly match recomputed attempts/events. |
| Track permission evidence honestly | Explicit decisions, inferred execution, unresolved requests, and policy context are separate assurance states. Codex escalation requests remain permission facets of terminal/test actions and successful or failed results prove only `executed / inferred`. | Live store has zero unknown or pending permission flows; 56 Codex executions are labeled inferred, not explicit approval. |
| Replay prompts, responses, reasoning stages, tools, files, commands, tests, failures, tokens, costs, and lifecycle | The canonical event model and inspector cover every listed signal. Older Codex `event_msg` and runtime-item variants are normalized, including command, patch, image, search, MCP, compaction, abort, and collaboration records. | Largest live flight has 32,362 events; its 24.8 MB lightweight timeline response completes in about 0.35 seconds and renders through a virtualized list. |
| Reconstruct code evolution without fabrication | Synchronous hooks capture content-addressed before/after boundaries; multi-file paths remain selectable; historical and best-effort sources receive explicit gaps; unified diffs are bounded. | Live evidence health covers every file event with zero uncovered (>18,000 at the audit checkpoint). Pathless native file completions have explicit `file_path_unavailable` gaps. |
| Live local operation | SQLite WAL supports scanner/server/hook concurrency, external commits are detected with `data_version`, SSE refreshes the console, and native scans run in a child process. Child workers terminate when the parent disconnects. | Production API is live on `127.0.0.1:4174`; overview is about 5 ms, session listing about 3 ms, evidence health about 180 ms, and event detail about 2 ms on the 6.7 GB store. |
| Compare and carry flights | Cross-provider comparison uses canonical metrics/kinds/files. Authenticated encrypted bundles carry detailed events and snapshot blobs; imports rebuild attempts, retries, permission flows, and metrics. | Bundle tests verify encryption, integrity failure, exact diff restoration, and restored lineage/metrics. |
| Stay local and secure | The server rejects non-loopback binds and Host headers, rejects non-loopback Origins on mutations, serves a self-only CSP, has no outbound telemetry/exporter, protects files with private modes, excludes sensitive snapshot paths, supports redaction, and makes retention destructive only after explicit apply. | Live rebound Host and cross-site POST tests return 403; static CSP/frame/nosniff/referrer headers are present; database integrity and foreign-key checks pass; dependency audit reports zero vulnerabilities. |
| Operate at full local-history scale | Codex uses bounded incremental reads and all-history discovery. OpenCode change detection includes WAL state. Foreign-key and correlation indexes keep reindex and health operations bounded. | A complete 2.7 GB / 114-rollout Codex reindex finished without source errors. All 115 native sources were visited. |

## Automated gates

- `npm run check`: strict client and server TypeScript passed.
- `npm test`: 41 tests in 9 files passed.
- `npm run build`: production server and Vite console passed.
- `npm audit --audit-level=moderate`: zero vulnerabilities.
- SQLite `PRAGMA quick_check`: `ok`; `PRAGMA foreign_key_check`: no rows.

## Explicit external boundaries

- Claude Code does not expose hidden reasoning or complete universal token/cost data through hooks. Cursor exposes completed thought blocks but no universal token/cost event or manual permission-result event. The recorder does not synthesize those fields.
- Cursor read-only before hooks have no paired after event. A standalone read remains a completed unknown-outcome action; generic pre/post callbacks can upgrade the same logical action when present.
- Parallel identical actions without provider call IDs can remain temporally ambiguous. Every callback is retained, and the nearest compatible same-turn/window action is used without claiming stronger identity.
- User-level Claude and Cursor hook files were absent during the live audit (`0/31` and `0/21`). Installation is intentionally dry-run-first and never performed automatically; native Codex/OpenCode capture remains active.
- Full-page SQLCipher encryption is not provided by Node SQLite. Sensitive evidence columns are encrypted, while indexed metadata is intentionally plaintext and reported as such.
- A fresh final rendered-browser pass could not run because no in-app browser surface was attached to the audit session. The production HTML/API, responsive CSS, keyboard controls, focus styles, reduced-motion rule, virtualization, and security headers passed code/build/live checks; an earlier rendered pass in the same implementation effort covered desktop/mobile replay and inspector interactions.
