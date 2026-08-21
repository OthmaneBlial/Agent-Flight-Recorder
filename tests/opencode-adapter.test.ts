import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { importOpenCodeDatabase } from '../src/server/adapters/opencode.js';
import { RecorderStore } from '../src/server/store.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('OpenCode adapter', () => {
  it('normalizes messages, reasoning, tools, files, and token steps', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-opencode-'));
    tempDirectories.push(directory);
    const source = join(directory, 'opencode.db');
    createNativeDatabase(source);
    const store = new RecorderStore(join(directory, 'recorder.db'));

    const imported = importOpenCodeDatabase(source, store);
    expect(imported.changed).toBe(true);
    expect(store.getSessions({ provider: 'opencode' })).toHaveLength(1);
    const events = store.getEvents('opencode:session-1');
    expect(events.map((event) => event.kind)).toEqual(['prompt', 'reasoning', 'test', 'token', 'artifact']);
    expect(store.getSessions()[0].metrics.testRuns).toBe(1);
    expect(store.getSessions()[0].metrics.tokensIn).toBe(120);
    expect(store.getSessions()[0].metrics.tokensOut).toBe(30);
    store.close();
  });

  it('marks historical file mutations when exact snapshots are unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-opencode-file-'));
    tempDirectories.push(directory);
    const source = join(directory, 'opencode.db');
    createNativeDatabase(source, true, directory);
    const store = new RecorderStore(join(directory, 'recorder.db'));

    importOpenCodeDatabase(source, store);

    const events = store.getEvents('opencode:session-1');
    expect(events.map((event) => event.kind)).toContain('file');
    expect(events.map((event) => event.kind)).toContain('gap');
    expect(store.getSession('opencode:session-1')?.metrics.captureGaps).toBe(1);
    store.close();
  });

  it('detects and imports writes that exist only in the SQLite WAL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afr-opencode-wal-'));
    tempDirectories.push(directory);
    const source = join(directory, 'opencode.db');
    createNativeDatabase(source);
    const store = new RecorderStore(join(directory, 'recorder.db'));
    expect(importOpenCodeDatabase(source, store).changed).toBe(true);
    expect(importOpenCodeDatabase(source, store).changed).toBe(false);

    const writer = new DatabaseSync(source);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer
      .prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
      .run('part-wal', 'message-1', 'session-1', 1_755_684_000_700, JSON.stringify({ type: 'text', text: 'This row is still in the WAL' }));

    const imported = importOpenCodeDatabase(source, store);
    expect(imported.changed).toBe(true);
    expect(store.getEvents('opencode:session-1').map((event) => event.summary)).toContain('This row is still in the WAL');
    expect(importOpenCodeDatabase(source, store).changed).toBe(false);
    writer.close();
    store.close();
  });
});

function createNativeDatabase(path: string, includeEdit = false, worktree = '/work/alpha'): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, slug TEXT, version TEXT,
      model TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  db.prepare('INSERT INTO project VALUES (?, ?, ?)').run('project-1', 'Alpha', worktree);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'session-1',
    'project-1',
    worktree,
    'Repair tests',
    'repair-tests',
    '1.0.0',
    JSON.stringify({ providerID: 'openai', modelID: 'gpt-5' }),
    null,
    1_755_684_000_000,
    1_755_684_004_000,
    null,
  );
  db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('message-1', 'session-1', JSON.stringify({ role: 'user' }));
  const insert = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
  insert.run('part-1', 'message-1', 'session-1', 1_755_684_000_100, JSON.stringify({ type: 'text', text: 'Run the parser tests' }));
  insert.run('part-2', 'message-1', 'session-1', 1_755_684_000_200, JSON.stringify({ type: 'reasoning', text: 'I should inspect the suite.' }));
  insert.run(
    'part-3',
    'message-1',
    'session-1',
    1_755_684_000_300,
    JSON.stringify({
      type: 'tool',
      tool: 'bash',
      callID: 'call-1',
      state: { status: 'completed', input: { command: 'npm test' }, output: 'passed', time: { start: 100, end: 240 } },
    }),
  );
  insert.run(
    'part-4',
    'message-1',
    'session-1',
    1_755_684_000_400,
    JSON.stringify({ type: 'step-finish', reason: 'stop', cost: 0.004, tokens: { input: 120, output: 25, reasoning: 5, cache: { read: 40 } } }),
  );
  insert.run('part-5', 'message-1', 'session-1', 1_755_684_000_500, JSON.stringify({ type: 'file', filename: 'report.txt', mime: 'text/plain' }));
  if (includeEdit)
    insert.run(
      'part-6',
      'message-1',
      'session-1',
      1_755_684_000_600,
      JSON.stringify({
        type: 'tool',
        tool: 'edit',
        callID: 'call-2',
        state: { status: 'completed', input: { file_path: join(worktree, 'changed.ts'), old_string: 'a', new_string: 'b' } },
      }),
    );
  db.close();
}
