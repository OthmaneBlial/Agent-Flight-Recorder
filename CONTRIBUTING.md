# Contributing

Agent Flight Recorder accepts focused fixes and extensions that preserve its local-first evidence boundary. Before proposing a change, read [the architecture](docs/ARCHITECTURE.md) and [the security model](SECURITY.md).

## Development setup

Requirements: Node.js 24.18.1 or newer and npm 11.

```bash
npm ci
npm run demo -- --reset
```

The demo opens at `http://127.0.0.1:4174` and never scans native agent history. Use `npm run dev` only when you intentionally want the recorder to discover local Codex/OpenCode sources.

## Before opening a pull request

```bash
npm run verify
npm run test:e2e
npm audit --audit-level=moderate
```

Run `npm run format` before `npm run verify` if Biome reports formatting differences. Browser tests require Chromium once per machine:

```bash
npx playwright install chromium
```

## Change expectations

- Keep the server loopback-only and do not add telemetry.
- Never commit recorder databases, `.afr` bundles, secrets, provider logs, or screenshots containing personal workspaces.
- Preserve raw provider evidence while keeping unsupported signals explicitly null, unknown, or represented as capture gaps.
- Add regression tests for adapters, normalization, persistence, security boundaries, and primary UI behavior.
- Keep hook installation and destructive retention operations dry-run-first.
- Document provider-contract changes with a primary source and update the fixture matrix.

Small, reviewable commits are preferred. Explain behavior changes, data migration impact, and the exact validation you ran.
