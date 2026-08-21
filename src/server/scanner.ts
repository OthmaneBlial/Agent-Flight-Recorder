import type { ScanResult } from '../shared/types.js';
import { importCodexFile } from './adapters/codex.js';
import { importOpenCodeDatabase } from './adapters/opencode.js';
import { discoverCodexSources, discoverOpenCodeSource } from './discovery.js';
import type { RecorderStore } from './store.js';

export interface ScanOptions {
  all?: boolean;
  codexLimit?: number;
}

export async function scanSources(store: RecorderStore, options: ScanOptions = {}): Promise<ScanResult> {
  store.recordHeartbeat('scanner', 'source scan started');
  const result: ScanResult = {
    sourcesVisited: 0,
    sourcesChanged: 0,
    sessionsImported: 0,
    eventsImported: 0,
    errors: [],
  };
  const hasExplicitLimit = options.codexLimit !== undefined && Number.isFinite(options.codexLimit);
  const codex = discoverCodexSources(
    hasExplicitLimit ? Math.max(0, options.codexLimit ?? 0) : Number.MAX_SAFE_INTEGER,
    options.all === true || !hasExplicitLimit,
  );
  const openCode = discoverOpenCodeSource();

  for (const source of codex) {
    result.sourcesVisited += 1;
    try {
      const imported = await importCodexFile(source.path, store);
      if (imported.changed) {
        result.sourcesChanged += 1;
        result.sessionsImported += 1;
        result.eventsImported += imported.events;
      }
    } catch (error) {
      result.errors.push({ path: source.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (openCode) {
    result.sourcesVisited += 1;
    try {
      const imported = importOpenCodeDatabase(openCode.path, store);
      if (imported.changed) {
        result.sourcesChanged += 1;
        result.sessionsImported += store.getSessions({ provider: 'opencode', limit: 500 }).length;
        result.eventsImported += imported.events;
      }
    } catch (error) {
      result.errors.push({ path: openCode.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  store.reconcileSessionStatuses();
  const staleCallGaps = store.recordStaleCallGaps();
  const uncoveredFileGaps = store.recordUncoveredFileGaps();
  store.recordStalePermissionUnknowns();
  result.eventsImported += staleCallGaps + uncoveredFileGaps;
  if (store.policy.rawRetentionDays || store.policy.snapshotRetentionDays) {
    result.retention = store.applyRetention({
      rawBefore: cutoff(store.policy.rawRetentionDays),
      snapshotsBefore: cutoff(store.policy.snapshotRetentionDays),
      apply: true,
    });
  }
  if (result.sourcesChanged > 0 || staleCallGaps > 0 || uncoveredFileGaps > 0) store.setLastIngestedAt(new Date().toISOString());
  store.recordHeartbeat('scanner', `visited ${result.sourcesVisited} sources; imported ${result.eventsImported} events`);
  return result;
}

function cutoff(days: number | null): string | null {
  return days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
}
