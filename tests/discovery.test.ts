import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverOpenCodeSource } from '../src/server/discovery.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('provider source discovery', () => {
  it('prefers the database path reported by the supported OpenCode CLI', () => {
    const homeRoot = temporaryDirectory();
    const reportedPath = join(homeRoot, 'custom', 'current-opencode.db');
    mkdirSync(join(homeRoot, 'custom'));
    writeFileSync(reportedPath, 'sqlite');

    expect(discoverOpenCodeSource({ homeRoot, resolveCliPath: () => reportedPath })?.path).toBe(reportedPath);
  });

  it('falls back to the version-tested default when the CLI path is unavailable', () => {
    const homeRoot = temporaryDirectory();
    const fallbackPath = join(homeRoot, '.local', 'share', 'opencode', 'opencode.db');
    mkdirSync(join(homeRoot, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(fallbackPath, 'sqlite');

    expect(discoverOpenCodeSource({ homeRoot, resolveCliPath: () => join(homeRoot, 'missing.db') })?.path).toBe(fallbackPath);
  });

  it('reports no source when neither supported discovery nor fallback resolves a file', () => {
    const homeRoot = temporaryDirectory();
    expect(discoverOpenCodeSource({ homeRoot, resolveCliPath: () => null })).toBeNull();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'afr-discovery-'));
  tempDirectories.push(directory);
  return directory;
}
