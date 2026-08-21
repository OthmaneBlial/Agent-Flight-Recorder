# Troubleshooting

## Port 4174 is already in use

Only one recorder can bind a port. Reuse the running console or choose another loopback port:

```bash
npm start -- --port=4180
```

`--help` and `--version` never start the server.

## The console shows reconnecting

Open `http://127.0.0.1:4174/api/health`. If it is unavailable, start the recorder with `npm start`. In development, keep both processes from `npm run dev` running: Vite uses port 4173 and proxies the API to 4174.

## No flights are listed

Run `npm run doctor` to see which native sources exist. Then run `npm run scan -- --all`. Claude Code and Cursor require explicit hook installation; preview the generated merge before applying it. To evaluate the console without native history, use `npm run demo -- --reset`.

## Storage key errors

On macOS, unlock the login Keychain and retry. On other systems, verify the private `recorder.db.key` file is readable only by the current user. `AFR_STORE_KEY` must be exactly 32 bytes encoded as 64 hexadecimal characters or base64. Never rotate or delete a key while retaining a database that depends on it.

## A scan reports `database is locked`

Stop duplicate recorder processes that use the same data directory and retry. The normal scanner, hook bridge, and server coordinate through SQLite WAL; an unrelated process holding a long write transaction can still block progress.

## Browser tests cannot launch Chromium

Install the repository-owned browser once, then rerun the test:

```bash
npx playwright install chromium
npm run test:e2e
```

Linux CI uses `npx playwright install --with-deps chromium` to install required system libraries.

## Resetting the demo

The demo uses `.flight-recorder-demo`, never the production `.flight-recorder` directory. Reset only its database with:

```bash
npm run demo -- --reset
```

Native scanning is disabled in demo mode.

For hot-reload development, use `npm run dev`. It starts this same scan-locked sandbox and automatically moves to a free port pair if the defaults are occupied. The terminal prints the selected console URL. Use `npm run dev -- --web-port=5273 --api-port=5274` when fixed ports are useful. Only `npm run dev:private` opens the native local-evidence mode.
