# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/) once releases are tagged.

## [Unreleased]

## [0.2.0] - 2026-08-21

### Added

- Deterministic, isolated checkout-repair demo with replay, retry lineage, permission evidence, exact code evolution, resource usage, and a comparison flight.
- Browser end-to-end coverage, real product screenshot generation, Biome formatting/linting, and pinned GitHub Actions CI.
- GitHub community files, compatibility declarations, configuration example, and troubleshooting/release documentation.
- A publishable-file privacy gate that rejects recorder artifacts and absolute user-home paths.

### Changed

- New evidence defaults to credential masking while explicit `off` and `strict` modes remain available.
- CLI help, version reporting, numeric validation, startup output, and error handling are production-oriented.
- Replay UI loading, failure, selection, focus, responsive, and legibility states are more explicit.
- HTTP errors carry request IDs; unexpected internal errors no longer expose implementation details to clients.
- Development now opens a synthetic sandbox by default; native local data requires the explicit `dev:private` command.
- Demo mode ignores ambient production-store configuration, masks evidence, hides native source paths, and rejects scan and hook ingestion.

## [0.1.0] - 2026-08-21

### Added

- Initial local-first recorder with Codex and OpenCode native ingestion, Claude/Cursor hook bridges, normalized SQLite storage, replay console, code evolution, retry and permission correlation, encrypted bundles, retention, and evidence-health reporting.
