# Validation evidence

Last repository validation: 2026-09-01 (Europe/Paris)

This page records bounded evidence for the current `main` branch. It is not a parity or completeness claim: providers can keep data private, change unstable local formats, or fail to emit a configured callback.

## Current automated gate

The canonical local gate is:

```bash
npm ci
npm run verify
npm run test:e2e
npm audit --audit-level=moderate
```

On the date above it produced:

- Biome formatting and lint: passed;
- strict client and server TypeScript: passed;
- Vitest: 48 tests in 11 files passed;
- publishable-file privacy scan: passed with no blocked evidence or absolute home path found;
- production server/CLI and Vite console build: passed;
- Playwright Chromium: 3 journeys passed, covering the sandbox boundary, diff/retry/comparison evidence, keyboard navigation, mobile Flights/Timeline/Evidence navigation, failed requests, console errors, and horizontal overflow;
- production dependency audit: zero known vulnerabilities at moderate severity or above.

The deterministic screenshot run generated `docs/assets/replay-console.png`, `docs/assets/code-evolution.png`, and `docs/assets/mobile-replay.png` from the scan-locked synthetic demo. The same files are synchronized into `site/assets/` by the capture script.

## Contract coverage

| Surface | Repository evidence | Boundary |
| --- | --- | --- |
| Codex hooks | Fixtures ingest and retain all 11 currently documented lifecycle envelopes; installer generation and dry-run behavior are tested. | No opted-in real Codex hook delivery was exercised in this gate. Direct transcript parsing is a version-tested backfill because Codex does not promise a stable transcript format. |
| Claude Code hooks | Fixtures ingest and retain all 33 currently documented hook envelopes, including model switches; installer merge, deduplication, uninstall, backup, and rollback are tested. | A fixture proves the adapter contract, not that a local Claude installation launched every callback. |
| Cursor hooks | Fixtures ingest and retain all 21 documented local IDE/CLI envelopes; specialized and generic facets are correlated without dropping native callbacks. | Cloud agents expose a smaller hook subset; no opted-in real Cursor delivery was exercised in this gate. |
| OpenCode backfill | The active database path is requested through `opencode db path`; discovery fallback and WAL-only writes are tested. The installed local CLI and database path were resolved successfully. | SQLite tables remain an internal, version-tested schema rather than a stable OpenCode API. |
| Compatible agents | `afr.event.v1` validation, stdin capture, HTTP sandbox rejection, and unknown-field retention are tested. | Other agents must emit the documented envelope; the recorder cannot reconstruct signals they omit. |

## Security and evidence checks

- The server rejects non-loopback binds and untrusted Host/Origin values in automated tests.
- Demo mode ignores ambient private-store configuration, exposes only a relative synthetic store label, and rejects native scan and live-hook ingestion.
- Evidence-bearing payload, raw-envelope, and snapshot columns use authenticated AES-256-GCM encryption; indexed metadata remains plaintext by design and is reported as such.
- Permission decisions distinguish explicit provider reports, inferred execution, and unresolved requests.
- File evidence distinguishes exact, best-effort, missing, skipped, error, and pruned boundaries instead of inventing a diff.
- Export/import tests cover encrypted bundle round trips, integrity failures, restored code evolution, call lineage, permission flows, and metrics.

## External validation still required

- exercise Codex, Claude Code, and Cursor hooks on opted-in installations and retain sanitized delivery receipts;
- re-run provider-contract research whenever official lifecycle documentation changes;
- test more browsers and assistive technologies beyond the three scripted Chromium journeys;
- validate future signed desktop packages on each target operating system;
- treat any historical large-store benchmark as a past observation, not a current performance guarantee.
