## What changed

Describe the user-visible and architectural behavior.

## Evidence boundary

- [ ] The change does not add telemetry or a non-loopback network surface.
- [ ] Unsupported provider evidence remains explicit rather than inferred.
- [ ] No recorder database, bundle, secret, personal path, or private trace is included.

## Validation

- [ ] `npm run verify`
- [ ] `npm run test:e2e`
- [ ] `npm audit --audit-level=moderate`
- [ ] Relevant manual or provider-specific validation is described below.

## Migration and rollback

Describe schema, configuration, hook, or compatibility impact. Write “none” when not applicable.
