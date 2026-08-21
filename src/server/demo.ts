import { createHash } from 'node:crypto';
import type { EventInput, SessionInput } from './model.js';
import type { RecorderStore } from './store.js';

const REPAIRED_SESSION = 'demo:checkout-repaired';
const REGRESSION_SESSION = 'demo:checkout-regression';
const WORKSPACE = '/workspace/checkout-service';
const FILE_PATH = `${WORKSPACE}/src/checkout/waitForCheckout.ts`;

export interface DemoSeedReceipt {
  created: boolean;
  sessions: string[];
  events: number;
}

export function seedDemo(store: RecorderStore, now = Date.now()): DemoSeedReceipt {
  const sessions = [REPAIRED_SESSION, REGRESSION_SESSION];
  if (sessions.every((id) => store.getSession(id))) {
    return { created: false, sessions, events: sessions.reduce((total, id) => total + store.getEvents(id).length, 0) };
  }

  const repairedStart = now - 6 * 60_000;
  const regressionStart = now - 24 * 60_000;
  const repaired = repairedFlight(repairedStart);
  const regression = regressionFlight(regressionStart);

  for (const flight of [regression, repaired]) {
    if (store.getSession(flight.session.id)) continue;
    store.upsertSession(flight.session);
    for (const entry of flight.events) store.insertEventWithMetrics(entry);
    store.refreshSessionMetrics(flight.session.id);
  }

  addSnapshot(store, 'demo:repair:file-result', REPAIRED_SESSION, 80, 'before', BEFORE_SOURCE, stamp(repairedStart, 82));
  addSnapshot(store, 'demo:repair:file-result', REPAIRED_SESSION, 80, 'after', AFTER_SOURCE, stamp(repairedStart, 83));
  store.setLastIngestedAt(stamp(repairedStart, 174));
  store.recordHeartbeat('demo', 'deterministic checkout-repair scenario loaded');

  return { created: true, sessions, events: sessions.reduce((total, id) => total + store.getEvents(id).length, 0) };
}

function repairedFlight(start: number): { session: SessionInput; events: EventInput[] } {
  const events: EventInput[] = [
    event('demo:repair:start', REPAIRED_SESSION, 10, start, 0, 'lifecycle', 'Flight recorder armed', 'Local capture started with masking enabled.', 'success', {
      providerEvent: 'session.start',
    }),
    event(
      'demo:repair:prompt',
      REPAIRED_SESSION,
      20,
      start,
      6,
      'prompt',
      'Stabilize the checkout state machine',
      'Fix the intermittent checkout timeout without weakening test coverage.',
      'neutral',
      {
        providerEvent: 'prompt.submit',
        text: 'Fix the intermittent checkout timeout without weakening test coverage. Preserve cancellation and retry behavior.',
      },
    ),
    event(
      'demo:repair:reasoning',
      REPAIRED_SESSION,
      30,
      start,
      18,
      'reasoning',
      'Trace the failure boundary',
      'The success callback can arrive between the final poll and timeout rejection.',
      'neutral',
      {
        providerEvent: 'reasoning.complete',
        stage: 'root-cause-analysis',
      },
    ),
    action(
      'demo:repair:test-call-1',
      REPAIRED_SESSION,
      40,
      start,
      31,
      'test',
      'Run checkout regression tests',
      'npm test -- checkout',
      'call',
      'running',
      'demo-test-1',
    ),
    action(
      'demo:repair:test-result-1',
      REPAIRED_SESSION,
      50,
      start,
      41,
      'test',
      'Checkout regression reproduced',
      'npm test -- checkout',
      'result',
      'error',
      'demo-test-1',
      8_124,
      {
        exitCode: 1,
        failed: 'resolves when confirmation arrives at timeout boundary',
      },
    ),
    event(
      'demo:repair:permission',
      REPAIRED_SESSION,
      60,
      start,
      57,
      'permission',
      'Permission requested for source edit',
      'The agent requested approval before changing the checkout state machine.',
      'running',
      {
        phase: 'request',
        providerEvent: 'permission.request',
        tool: 'apply_patch',
        input: { path: FILE_PATH },
      },
      { callId: 'demo-edit-1', path: FILE_PATH },
    ),
    action(
      'demo:repair:file-call',
      REPAIRED_SESSION,
      70,
      start,
      70,
      'file',
      'Patch timeout settlement',
      null,
      'call',
      'running',
      'demo-edit-1',
      null,
      {
        tool: 'apply_patch',
        input: { path: FILE_PATH },
      },
      FILE_PATH,
    ),
    action(
      'demo:repair:file-result',
      REPAIRED_SESSION,
      80,
      start,
      82,
      'file',
      'Timeout settlement patched',
      null,
      'result',
      'success',
      'demo-edit-1',
      1_340,
      {
        tool: 'apply_patch',
        input: { path: FILE_PATH },
        changedLines: 12,
      },
      FILE_PATH,
    ),
    action(
      'demo:repair:test-call-2',
      REPAIRED_SESSION,
      90,
      start,
      103,
      'test',
      'Run checkout regression tests',
      'npm test -- checkout',
      'call',
      'running',
      'demo-test-2',
    ),
    action(
      'demo:repair:test-result-2',
      REPAIRED_SESSION,
      100,
      start,
      118,
      'test',
      'Checkout regression suite passed',
      'npm test -- checkout',
      'result',
      'success',
      'demo-test-2',
      6_482,
      {
        exitCode: 0,
        tests: 18,
      },
    ),
    action(
      'demo:repair:lint-call',
      REPAIRED_SESSION,
      110,
      start,
      132,
      'terminal',
      'Validate the changed module',
      'npm run check',
      'call',
      'running',
      'demo-check-1',
    ),
    action(
      'demo:repair:lint-result',
      REPAIRED_SESSION,
      120,
      start,
      143,
      'terminal',
      'Static validation passed',
      'npm run check',
      'result',
      'success',
      'demo-check-1',
      4_019,
      { exitCode: 0 },
    ),
    event(
      'demo:repair:tokens',
      REPAIRED_SESSION,
      130,
      start,
      156,
      'token',
      'Usage checkpoint',
      'Provider-reported usage for this completed turn.',
      'success',
      {
        providerEvent: 'usage.complete',
      },
      { tokensIn: 18_420, tokensOut: 2_184, cachedTokens: 11_090, costUsd: 0.086 },
    ),
    event(
      'demo:repair:response',
      REPAIRED_SESSION,
      140,
      start,
      168,
      'response',
      'Repair verified',
      'The race is fixed, cancellation stays intact, and all 18 checkout tests pass.',
      'success',
      {
        providerEvent: 'response.complete',
      },
    ),
    event(
      'demo:repair:artifact',
      REPAIRED_SESSION,
      150,
      start,
      172,
      'artifact',
      'Verification report recorded',
      'Diff, retry lineage, permission evidence, and test outcomes are attached to this flight.',
      'success',
      {
        providerEvent: 'artifact.created',
        artifact: 'checkout-verification',
      },
    ),
    event(
      'demo:repair:end',
      REPAIRED_SESSION,
      160,
      start,
      174,
      'lifecycle',
      'Flight complete',
      'The agent completed the requested repair successfully.',
      'success',
      {
        providerEvent: 'session.end',
      },
    ),
  ];

  return {
    session: {
      id: REPAIRED_SESSION,
      provider: 'compatible',
      nativeSessionId: 'checkout-repaired-01',
      title: 'Checkout race repaired and verified',
      startedAt: stamp(start, 0),
      endedAt: stamp(start, 174),
      updatedAt: stamp(start, 174),
      cwd: WORKSPACE,
      projectName: 'checkout-service',
      agentVersion: 'afr-demo/1',
      model: 'deterministic demo',
      sourcePath: 'demo://checkout-repaired',
      status: 'complete',
    },
    events,
  };
}

function regressionFlight(start: number): { session: SessionInput; events: EventInput[] } {
  const events: EventInput[] = [
    event(
      'demo:regression:start',
      REGRESSION_SESSION,
      10,
      start,
      0,
      'lifecycle',
      'Flight recorder armed',
      'A previous attempt is available as a comparison target.',
      'success',
      {
        providerEvent: 'session.start',
      },
    ),
    event(
      'demo:regression:prompt',
      REGRESSION_SESSION,
      20,
      start,
      7,
      'prompt',
      'Investigate intermittent checkout timeout',
      'Find why checkout confirmation occasionally loses the timeout race.',
      'neutral',
      {
        providerEvent: 'prompt.submit',
      },
    ),
    action(
      'demo:regression:test-call',
      REGRESSION_SESSION,
      30,
      start,
      25,
      'test',
      'Run checkout regression tests',
      'npm test -- checkout',
      'call',
      'running',
      'demo-regression-test',
    ),
    action(
      'demo:regression:test-result',
      REGRESSION_SESSION,
      40,
      start,
      39,
      'test',
      'Checkout regression failed',
      'npm test -- checkout',
      'result',
      'error',
      'demo-regression-test',
      8_304,
      {
        exitCode: 1,
        failed: 'resolves when confirmation arrives at timeout boundary',
      },
    ),
    event(
      'demo:regression:gap',
      REGRESSION_SESSION,
      50,
      start,
      52,
      'gap',
      'Historical file boundary unavailable',
      'The earlier attempt named the file but did not expose trustworthy before/after contents.',
      'neutral',
      {
        code: 'historical_snapshot_unavailable',
        providerEvent: 'file.changed',
      },
      { parentId: 'demo:regression:test-result', path: FILE_PATH },
    ),
    event(
      'demo:regression:response',
      REGRESSION_SESSION,
      60,
      start,
      65,
      'response',
      'Attempt stopped before repair',
      'The failure was reproduced, but no verified source change was recorded.',
      'error',
      {
        providerEvent: 'response.complete',
      },
    ),
    event(
      'demo:regression:end',
      REGRESSION_SESSION,
      70,
      start,
      68,
      'lifecycle',
      'Flight ended with failure',
      'Use the repaired flight to inspect the successful retry and code evolution.',
      'error',
      {
        providerEvent: 'session.end',
      },
    ),
  ];

  return {
    session: {
      id: REGRESSION_SESSION,
      provider: 'compatible',
      nativeSessionId: 'checkout-regression-00',
      title: 'Checkout timeout reproduced',
      startedAt: stamp(start, 0),
      endedAt: stamp(start, 68),
      updatedAt: stamp(start, 68),
      cwd: WORKSPACE,
      projectName: 'checkout-service',
      agentVersion: 'afr-demo/1',
      model: 'deterministic demo',
      sourcePath: 'demo://checkout-regression',
      status: 'complete',
    },
    events,
  };
}

function event(
  id: string,
  sessionId: string,
  sequence: number,
  start: number,
  offsetSeconds: number,
  kind: EventInput['kind'],
  title: string,
  summary: string,
  status: EventInput['status'],
  payload: Record<string, unknown>,
  overrides: Partial<EventInput> = {},
): EventInput {
  return {
    id,
    sessionId,
    sequence,
    timestamp: stamp(start, offsetSeconds),
    durationMs: null,
    kind,
    title,
    summary,
    status,
    actor: 'demo-agent',
    turnId: `${sessionId}:turn-1`,
    callId: null,
    parentId: null,
    tokensIn: null,
    tokensOut: null,
    cachedTokens: null,
    costUsd: null,
    command: null,
    path: null,
    payload,
    raw: { schema: 'afr.event.v1', event: payload.providerEvent ?? kind, demo: true },
    ...overrides,
  };
}

function action(
  id: string,
  sessionId: string,
  sequence: number,
  start: number,
  offsetSeconds: number,
  kind: Extract<EventInput['kind'], 'file' | 'terminal' | 'test' | 'tool'>,
  title: string,
  command: string | null,
  phase: 'call' | 'result',
  status: EventInput['status'],
  callId: string,
  durationMs: number | null = null,
  detail: Record<string, unknown> = {},
  path: string | null = null,
): EventInput {
  return event(
    id,
    sessionId,
    sequence,
    start,
    offsetSeconds,
    kind,
    title,
    phase === 'call' ? 'Invocation captured before execution.' : 'Provider result captured after execution.',
    status,
    {
      phase,
      providerEvent: phase === 'call' ? 'tool.before' : status === 'error' ? 'tool.failure' : 'tool.after',
      tool: kind === 'file' ? 'apply_patch' : 'shell',
      ...detail,
    },
    { callId, command, path, durationMs },
  );
}

function addSnapshot(
  store: RecorderStore,
  eventId: string,
  sessionId: string,
  sequence: number,
  phase: 'before' | 'after',
  source: string,
  createdAt: string,
): void {
  const content = Buffer.from(source, 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');
  store.putContentBlob(hash, content, 'text/typescript', 'utf8', createdAt);
  store.insertFileSnapshot({
    id: `snapshot:${eventId}:${phase}`,
    eventId,
    sessionId,
    sequence,
    path: FILE_PATH,
    phase,
    status: 'captured',
    assurance: 'exact',
    reason: null,
    hash,
    byteSize: content.byteLength,
    mime: 'text/typescript',
    fileMtimeMs: null,
    createdAt,
  });
}

function stamp(start: number, offsetSeconds: number): string {
  return new Date(start + offsetSeconds * 1_000).toISOString();
}

const BEFORE_SOURCE = `export async function waitForCheckout(
  readState: () => Promise<'pending' | 'confirmed'>,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await readState() === 'confirmed') return;
    await delay(50);
  }
  throw new Error('Checkout confirmation timed out');
}
`;

const AFTER_SOURCE = `export async function waitForCheckout(
  readState: () => Promise<'pending' | 'confirmed'>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await readState() === 'confirmed') return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(50, remainingMs));
  }
  if (await readState() === 'confirmed') return;
  throw new Error('Checkout confirmation timed out');
}
`;
