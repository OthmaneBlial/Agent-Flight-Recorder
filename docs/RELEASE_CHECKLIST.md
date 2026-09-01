# Release checklist

1. Confirm the changelog describes only implemented behavior and set the release date.
2. Run `npm ci`, `npm run verify`, `npm run test:e2e`, and `npm audit --audit-level=moderate` on a clean checkout.
3. Run `npm run demo -- --reset` and inspect replay, filters, code evolution, retry lineage, comparison, keyboard controls, and phone layout.
4. Run `npm run privacy:check`; do not publish if any recorder artifact or absolute user-home path is reported.
5. Run `npm run screenshots` only with the deterministic demo; verify every image contains no personal or native recorder evidence.
6. Run `npm run doctor` against an opted-in native store and record schema, source, correlation, snapshot, permission, and integrity results without publishing captured contents.
7. Dry-run Codex, Claude Code, and Cursor hook installation and confirm existing user hooks remain structurally intact.
8. Export and import an encrypted test bundle into a new data directory; never use private production evidence in release artifacts.
9. Confirm the README commands and internal links from a clean clone.
10. Run `npm pack --dry-run --json`, install the tarball into a temporary prefix, and verify `--version`, `--help`, and sandbox health from that installed package.
11. Confirm CI is green and pinned action SHAs are still associated with the documented upstream major releases.
12. Tag only after the release commit is reviewed. Attach only the tested package tarball and its SHA-256 checksum; do not publish recorder databases, key files, `.afr` bundles, Playwright traces, or source maps as release assets.
