# Security and privacy

Agent Flight Recorder is designed to keep evidence on the local machine.

- The HTTP server binds only to `127.0.0.1`, `localhost`, or `::1`; other bind addresses are rejected. Requests also require a loopback `Host`, and mutating browser requests require a loopback `Origin`, limiting DNS-rebinding and cross-site request attacks against the local API.
- The application contains no telemetry, analytics, cloud database, remote exporter, or third-party font request.
- Provider hook configuration is generated but never installed automatically. Review and merge it into existing settings deliberately.
- Recorder hooks are observational. They emit an empty success object by default, including after local capture failure, and do not make allow/deny decisions. Provider timeout behavior differs, so a timeout must not be described as universally fail-open.
- Native records can contain prompts, source code, terminal output, paths, email addresses, credentials, and environment values. Protect the recorder directory like source code or a shell history.
- Normalized payloads, raw native envelopes, and snapshot content blobs are encrypted with AES-256-GCM before SQLite persistence. On macOS the 256-bit key is held in the login Keychain; `AFR_STORE_KEY` can provide it explicitly; other platforms use a mode-`0600` adjacent key file.
- Unix data directories are forced to `0700`; the database, WAL/SHM, and fallback key file are forced to `0600`.
- Recorder data directories matching `.flight-recorder*/`, portable `.afr` bundles, `.env` files, Playwright traces, and build outputs are ignored by Git. Do not move evidence into a synchronized or version-controlled directory unless that is intentional.
- Known sensitive file paths (`.env`, credential/secret files, private keys, and key stores) are never snapshotted. The skipped boundary and reason are still recorded as a capture gap.
- Snapshot capture is restricted to regular text files inside the provider-reported workspace, follows symlinks only when they remain inside that workspace, and defaults to a 2 MiB maximum.

Credential masking is the default for new evidence. Set `AFR_REDACTION_MODE=strict` to omit native raw records as well, or explicitly choose `off` when exact local evidence outweighs masking. Invalid configuration values fail at startup. Redaction applies at ingestion and does not rewrite evidence already present in a database.

Retention is also opt-in. `AFR_RAW_RETENTION_DAYS` and `AFR_SNAPSHOT_RETENTION_DAYS` apply during scans; the `prune` command previews counts unless `--apply` is supplied. Raw pruning preserves normalized timeline data. Snapshot pruning preserves provenance but deletes unreferenced content blobs.

## Public demo boundary

`npm run dev` and the `demo` command use the isolated `.flight-recorder-demo` store. Demo mode ignores ambient `AFR_DATA_DIR`, forces masking, disables native discovery, rejects manual scan and live-hook HTTP ingestion, and returns synthetic source metadata instead of probing or exposing user-home paths. Use `npm run dev:private` only when you intentionally want to inspect this machine's recorder evidence.

Recorder stores, WAL/SHM files, keys, and portable `.afr` bundles are ignored by Git. `npm run privacy:check` inspects the publishable file set for those artifacts and absolute user-home paths, and is part of `npm run verify`.

Current limitations:

- Redaction patterns reduce accidental secret retention but are not a proof that arbitrary secrets cannot be captured.
- Provider command hooks execute as the local user and therefore inherit that user's access. The recorder never installs hook configuration automatically.
- A local process running as the same user may read or alter the database. This is a single-user forensic tool, not a hardened multi-tenant service.
- The live store uses application-layer encryption for evidence-bearing columns, not SQLCipher/full-page encryption. Indexed metadata—including session labels, event summaries, commands, paths, timestamps, kinds, statuses, and correlation IDs—remains plaintext. Keep full-disk encryption enabled for full-volume protection.
- The protected-key-file fallback resides beside the database and primarily protects a database copied without its key. Prefer macOS Keychain or `AFR_STORE_KEY` backed by an OS secret manager where available.
- Losing the Keychain entry, fallback key file, or configured `AFR_STORE_KEY` makes encrypted evidence unrecoverable. Back up keys separately from exported encrypted `.afr` bundles.
- Bundle passphrases come from `AFR_BUNDLE_PASSPHRASE`, are not persisted by the recorder, and should not be placed directly in shared shell scripts or committed environment files.
- Unencrypted export requires `--unencrypted`; overwrite and merge operations require `--force` and `--merge` respectively. Treat those flags as deliberate data-boundary changes.

Do not treat a recorder database or bundle as safe to share merely because masking or encryption is enabled. Column and bundle encryption protects covered contents at rest and detects tampering; it does not hide live-store metadata or make captured source code appropriate to disclose.

## Supported versions

Security fixes target the current `main` branch and the latest tagged release. Older unmaintained snapshots may not receive backports.

## Reporting a vulnerability

Once this repository is public, use its **Security → Report a vulnerability** flow. Until then, contact the maintainer privately. Do not open a public issue or attach a recorder database, `.afr` bundle, native provider log, source snapshot, credential, or unsanitized `doctor` output. Include the affected commit, minimal sanitized reproduction, impact, and any suggested mitigation.
