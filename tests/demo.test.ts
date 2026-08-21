import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/server/demo.js';
import { loadEvidencePolicy } from '../src/server/policy.js';
import { RecorderStore } from '../src/server/store.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('deterministic demo', () => {
  it('seeds a complete replay, retry, permission trace, comparison target, and exact diff', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-demo-'));
    directories.push(directory);
    const store = new RecorderStore(join(directory, 'recorder.db'), loadEvidencePolicy({}, {}));

    const receipt = seedDemo(store, Date.parse('2026-08-21T09:00:00.000Z'));
    expect(receipt.created).toBe(true);
    expect(store.getSessions()).toHaveLength(2);

    const repaired = store.getSession('demo:checkout-repaired');
    expect(repaired?.metrics).toMatchObject({ testRuns: 2, fileChanges: 1, terminalCommands: 1, retries: 1 });

    const evolution = store.getCodeEvolution('demo:repair:file-result');
    expect(evolution?.changed).toBe(true);
    expect(evolution?.before?.assurance).toBe('exact');
    expect(evolution?.unifiedDiff).toContain('+  const deadline = Date.now() + timeoutMs;');

    const lineage = store.getCallLineage('demo:repair:test-result-2');
    expect(lineage?.attempts.map((attempt) => attempt.outcome)).toEqual(['error', 'success']);

    const permission = store.getPermissionTrace('demo:repair:file-result');
    expect(permission?.current).toMatchObject({ outcome: 'executed', assurance: 'inferred' });

    const comparison = store.compareSessions('demo:checkout-regression', 'demo:checkout-repaired');
    expect(comparison?.metricDelta.testRuns).toBe(1);
    expect(comparison?.metricDelta.retries).toBe(1);
    expect(store.getCaptureHealth().uncoveredFileEvents).toBe(0);

    expect(seedDemo(store, Date.parse('2026-08-21T10:00:00.000Z')).created).toBe(false);
    expect(store.getSessions()).toHaveLength(2);
    store.close();
  });

  it('uses masking by default and rejects invalid environment values', () => {
    expect(loadEvidencePolicy({}, {}).redactionMode).toBe('mask');
    expect(() => loadEvidencePolicy({}, { AFR_REDACTION_MODE: 'sometimes' })).toThrow(/AFR_REDACTION_MODE/);
    expect(() => loadEvidencePolicy({}, { AFR_RAW_RETENTION_DAYS: '0' })).toThrow(/positive integer/);
  });
});
