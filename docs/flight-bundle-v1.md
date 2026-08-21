# Flight bundle v1

Agent Flight Recorder bundles are single-session, local forensic archives. The logical payload schema is `afr.bundle.v1` and contains:

- export timestamp and canonical session metadata;
- ordered canonical events, including normalized and optional raw provider evidence;
- file-snapshot provenance;
- referenced snapshot blobs encoded as base64.

An `afr.bundle.archive.v1` wrapper carries a SHA-256 digest of the canonical JSON payload. Unencrypted exports serialize that wrapper directly.

Encrypted exports serialize `afr.bundle.encrypted.v1`:

```json
{
  "schema": "afr.bundle.encrypted.v1",
  "compression": "gzip",
  "kdf": {
    "name": "scrypt",
    "salt": "base64",
    "cost": 32768,
    "blockSize": 8,
    "parallelization": 1
  },
  "cipher": {
    "name": "aes-256-gcm",
    "iv": "base64",
    "tag": "base64"
  },
  "ciphertext": "base64"
}
```

The recorder derives a 256-bit key from `AFR_BUNDLE_PASSPHRASE`, authenticates the format identifier as additional data, compresses the archive before encryption, and never stores the passphrase or derived key. Import rejects unsupported cryptographic parameters, a failed GCM tag, a mismatched archive digest, duplicate IDs, cross-session records, missing event references, and snapshot hash mismatches.

Import is additive by default. An existing session ID is rejected unless `--merge` is supplied. The imported session is detached from its native source and marked `bundle:<filename>` so a later native scan cannot treat the bundle path as provider storage. Destination redaction and sensitive-path policies are reapplied before persistence.
