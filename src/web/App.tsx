import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
  Activity,
  AlertTriangle,
  Box,
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Code2,
  FileDiff,
  Gauge,
  HardDrive,
  KeyRound,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  TestTube2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  CallLineage,
  CodeEvolution,
  EventKind,
  FileSnapshot,
  Overview,
  PermissionTrace,
  RecorderEvent,
  RecordedSession,
  SessionComparison,
  SourceHealth,
} from '../shared/types';
import { api, FILTERS, type Health } from './api';

const KIND_META: Record<EventKind, { label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }>; tone: string }> = {
  prompt: { label: 'Prompt', icon: Sparkles, tone: 'cyan' },
  reasoning: { label: 'Reasoning', icon: BrainCircuit, tone: 'violet' },
  response: { label: 'Response', icon: Activity, tone: 'cyan' },
  tool: { label: 'Tool', icon: Wrench, tone: 'amber' },
  terminal: { label: 'Terminal', icon: SquareTerminal, tone: 'green' },
  file: { label: 'File', icon: FileDiff, tone: 'orange' },
  test: { label: 'Test', icon: TestTube2, tone: 'green' },
  permission: { label: 'Permission', icon: KeyRound, tone: 'amber' },
  token: { label: 'Tokens', icon: Gauge, tone: 'violet' },
  retry: { label: 'Retry', icon: RefreshCw, tone: 'orange' },
  gap: { label: 'Gap', icon: AlertTriangle, tone: 'red' },
  context: { label: 'Context', icon: Box, tone: 'muted' },
  lifecycle: { label: 'Lifecycle', icon: CircleDot, tone: 'muted' },
  error: { label: 'Error', icon: AlertTriangle, tone: 'red' },
  artifact: { label: 'Artifact', icon: Code2, tone: 'cyan' },
};

export function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [captureHealth, setCaptureHealth] = useState<Health['capture'] | null>(null);
  const [sessions, setSessions] = useState<RecordedSession[]>([]);
  const [events, setEvents] = useState<RecorderEvent[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventDetail, setEventDetail] = useState<RecorderEvent | null>(null);
  const [evolution, setEvolution] = useState<CodeEvolution | null>(null);
  const [lineage, setLineage] = useState<CallLineage | null>(null);
  const [permissionTrace, setPermissionTrace] = useState<PermissionTrace | null>(null);
  const [comparisonSessionId, setComparisonSessionId] = useState('');
  const [comparison, setComparison] = useState<SessionComparison | null>(null);
  const [sessionQuery, setSessionQuery] = useState('');
  const [eventQuery, setEventQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | EventKind>('all');
  const [provider, setProvider] = useState<'all' | RecordedSession['provider']>('all');
  const [connected, setConnected] = useState(false);
  const [evidenceScope, setEvidenceScope] = useState<Health['evidenceScope'] | null>(null);
  const [nativeIngestEnabled, setNativeIngestEnabled] = useState(false);
  const [loadingShell, setLoadingShell] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [mobilePane, setMobilePane] = useState<'flights' | 'timeline' | 'evidence'>('timeline');
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const loadShell = useCallback(async () => {
    try {
      const [nextOverview, nextSessions, health] = await Promise.all([api.overview(), api.sessions(), api.health()]);
      setOverview(nextOverview);
      setSessions(nextSessions);
      setSources(health.sources);
      setCaptureHealth(health.capture);
      setEvidenceScope(health.evidenceScope);
      setNativeIngestEnabled(health.nativeIngestEnabled);
      setSelectedSessionId((current) => current ?? nextSessions[0]?.id ?? null);
      setError(null);
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setLoadingShell(false);
    }
  }, []);

  useEffect(() => {
    void loadShell();
  }, [loadShell]);

  useEffect(() => {
    if (!selectedSessionId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    setLoadingEvents(true);
    api
      .events(selectedSessionId)
      .then((nextEvents) => {
        if (cancelled) return;
        setEvents(nextEvents);
        setSelectedEventId((current) => (nextEvents.some((event) => event.id === current) ? current : (nextEvents[0]?.id ?? null)));
      })
      .catch((nextError) => setError(formatError(nextError)))
      .finally(() => {
        if (!cancelled) setLoadingEvents(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

  useEffect(() => {
    selectedRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedEventId) {
      setEventDetail(null);
      setEvolution(null);
      setLineage(null);
      setPermissionTrace(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      api.event(selectedEventId),
      api.evolution(selectedEventId).catch(() => null),
      api.lineage(selectedEventId).catch(() => null),
      api.permissions(selectedEventId).catch(() => null),
    ])
      .then(([event, nextEvolution, nextLineage, nextPermissionTrace]) => {
        if (cancelled) return;
        setEventDetail(event);
        setEvolution(nextEvolution);
        setLineage(nextLineage);
        setPermissionTrace(nextPermissionTrace);
      })
      .catch((nextError) => setError(formatError(nextError)));
    return () => {
      cancelled = true;
    };
  }, [selectedEventId]);

  const selectEvolutionPath = useCallback(
    (path: string) => {
      if (!selectedEventId) return;
      api
        .evolution(selectedEventId, path)
        .then(setEvolution)
        .catch((nextError) => setError(formatError(nextError)));
    },
    [selectedEventId],
  );

  useEffect(() => {
    if (!selectedSessionId || !comparisonSessionId || selectedSessionId === comparisonSessionId) {
      setComparison(null);
      return;
    }
    let cancelled = false;
    api
      .compare(selectedSessionId, comparisonSessionId)
      .then((nextComparison) => {
        if (!cancelled) setComparison(nextComparison);
      })
      .catch((nextError) => setError(formatError(nextError)));
    return () => {
      cancelled = true;
    };
  }, [comparisonSessionId, selectedSessionId]);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.addEventListener('ready', () => setConnected(true));
    source.addEventListener('ingest', () => {
      void loadShell();
      if (selectedRef.current)
        api
          .events(selectedRef.current)
          .then(setEvents)
          .catch(() => undefined);
    });
    source.addEventListener('recorder-error', (event) => {
      const payload = event instanceof MessageEvent ? safeJson(event.data) : null;
      setError(typeof payload?.message === 'string' ? payload.message : 'A background source scan failed.');
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [loadShell]);

  const visibleSessions = useMemo(() => {
    const needle = sessionQuery.toLowerCase().trim();
    return sessions.filter((session) => {
      if (provider !== 'all' && session.provider !== provider) return false;
      return (
        !needle || [flightTitle(session.title, session.projectName), session.projectName, session.cwd].some((value) => value?.toLowerCase().includes(needle))
      );
    });
  }, [provider, sessionQuery, sessions]);

  const visibleEvents = useMemo(() => {
    const needle = eventQuery.toLowerCase().trim();
    return events.filter((event) => {
      const filterMatches = activeFilter === 'all' || (activeFilter === 'error' ? event.status === 'error' : event.kind === activeFilter);
      const queryMatches = !needle || [event.title, event.summary, event.command, event.path].some((value) => value?.toLowerCase().includes(needle));
      return filterMatches && queryMatches;
    });
  }, [activeFilter, eventQuery, events]);

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const cursor = Math.max(
    0,
    visibleEvents.findIndex((event) => event.id === selectedEventId),
  );
  const eventVirtualizer = useVirtualizer({
    count: visibleEvents.length,
    getScrollElement: () => timelineRef.current,
    estimateSize: () => 70,
    overscan: 14,
  });

  const moveCursor = useCallback(
    (delta: number) => {
      if (!visibleEvents.length) return;
      const current = visibleEvents.findIndex((event) => event.id === selectedEventId);
      const next = Math.min(Math.max((current < 0 ? 0 : current) + delta, 0), visibleEvents.length - 1);
      setSelectedEventId(visibleEvents[next].id);
      eventVirtualizer.scrollToIndex(next, { align: 'auto', behavior: 'smooth' });
    },
    [eventVirtualizer, selectedEventId, visibleEvents],
  );

  useEffect(() => {
    if (!playing || !visibleEvents.length) return;
    const timer = window.setInterval(() => {
      const current = visibleEvents.findIndex((event) => event.id === selectedRefEvent());
      if (current >= visibleEvents.length - 1) {
        setPlaying(false);
      } else {
        setSelectedEventId(visibleEvents[Math.max(0, current + 1)].id);
      }
    }, 850);
    return () => window.clearInterval(timer);

    function selectedRefEvent() {
      return selectedEventId;
    }
  }, [playing, selectedEventId, visibleEvents]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches('input, textarea, select')) return;
      if (event.key.toLowerCase() === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        moveCursor(1);
      }
      if (event.key.toLowerCase() === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveCursor(-1);
      }
      if (event.key === ' ') {
        event.preventDefault();
        setPlaying((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moveCursor]);

  const scanNow = async () => {
    if (!nativeIngestEnabled) return;
    setScanning(true);
    try {
      await api.scan();
      await loadShell();
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="recorder-shell" data-app-ready={!loadingShell && overview !== null ? 'true' : 'false'}>
      <header className="masthead">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span>AF</span>
            <span>R</span>
          </div>
          <div>
            <p className="eyebrow">
              {evidenceScope === 'sandbox'
                ? 'ISOLATED SANDBOX / SYNTHETIC DATA'
                : evidenceScope === 'private'
                  ? 'PRIVATE LOCAL OBSERVABILITY / 01'
                  : 'VERIFYING PRIVACY BOUNDARY'}
            </p>
            <h1>AGENT FLIGHT RECORDER</h1>
          </div>
        </div>
        <section className="masthead-stats" aria-label="Recorder status">
          <span>
            <HardDrive size={14} /> {formatCompact(overview?.events ?? 0)} EVENTS
          </span>
          <span>
            <FileDiff size={14} /> {formatCompact(overview?.snapshots ?? 0)} SNAPSHOTS · {formatCompact(overview?.captureGaps ?? 0)} GAPS
          </span>
          <span>
            <ShieldCheck size={14} /> AES-GCM · MASKING: {overview?.evidencePolicy.redactionMode.toUpperCase() ?? '—'} · DB V{overview?.schemaVersion ?? '—'}
          </span>
          <span className={connected ? 'signal-online' : 'signal-offline'} role="status" aria-live="polite">
            <i /> {connected ? 'LIVE LINK' : 'RECONNECTING'}
          </span>
        </section>
        {nativeIngestEnabled ? (
          <button type="button" className="scan-button" onClick={() => void scanNow()} disabled={scanning}>
            <RefreshCw size={14} className={scanning ? 'spin' : ''} /> {scanning ? 'SCANNING' : 'SCAN NOW'}
          </button>
        ) : (
          <button
            type="button"
            className="scan-button sandbox-lock"
            disabled
            title={evidenceScope === 'sandbox' ? 'Native scans and live hooks are disabled in this sandbox.' : 'Checking recorder privacy mode.'}
          >
            <ShieldCheck size={14} /> {evidenceScope === 'sandbox' ? 'SANDBOX LOCKED' : 'CHECKING'}
          </button>
        )}
      </header>

      <div className="shell-utility">
        {error && (
          <div className="error-banner" role="alert">
            <AlertTriangle size={15} /> <span>{error}</span>
            <button type="button" className="error-retry" onClick={() => void loadShell()}>
              RETRY
            </button>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
              <X size={14} />
            </button>
          </div>
        )}
        <nav className="mobile-pane-tabs" aria-label="Recorder views">
          <button type="button" aria-pressed={mobilePane === 'flights'} onClick={() => setMobilePane('flights')}>
            <Box size={14} />
            <span>Flights</span>
            <b>{visibleSessions.length}</b>
          </button>
          <button type="button" aria-pressed={mobilePane === 'timeline'} onClick={() => setMobilePane('timeline')}>
            <Activity size={14} />
            <span>Timeline</span>
            <b>{visibleEvents.length}</b>
          </button>
          <button type="button" aria-pressed={mobilePane === 'evidence'} onClick={() => setMobilePane('evidence')} disabled={!selectedEventId}>
            <FileDiff size={14} />
            <span>Evidence</span>
            <b>{selectedEventId ? '01' : '—'}</b>
          </button>
        </nav>
      </div>

      <div className="cockpit-grid" data-mobile-pane={mobilePane}>
        <aside className="session-bay" aria-label="Recorded sessions">
          <div className="panel-heading">
            <div>
              <span className="section-index">01</span>
              <h2>RECORDED FLIGHTS</h2>
            </div>
            <span className="count-badge">{visibleSessions.length}</span>
          </div>
          <label className="search-field">
            <Search size={14} />
            <input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="SEARCH FLIGHTS" aria-label="Search sessions" />
          </label>
          <fieldset className="provider-switch">
            <legend className="sr-only">Provider filter</legend>
            {(['all', 'codex', 'opencode', 'claude', 'cursor', 'compatible'] as const).map((value) => (
              <button
                type="button"
                key={value}
                className={provider === value ? 'active' : ''}
                aria-pressed={provider === value}
                onClick={() => setProvider(value)}
              >
                {value === 'compatible' ? 'compat' : value}
              </button>
            ))}
          </fieldset>
          <div className="session-list">
            {visibleSessions.map((session, index) => (
              <button
                type="button"
                key={session.id}
                className={`session-card ${session.id === selectedSessionId ? 'selected' : ''}`}
                aria-pressed={session.id === selectedSessionId}
                onClick={() => {
                  setSelectedSessionId(session.id);
                  setPlaying(false);
                  setMobilePane('timeline');
                }}
              >
                <span className="session-number">{String(index + 1).padStart(2, '0')}</span>
                <span className={`provider-glyph provider-${session.provider}`}>{providerInitial(session.provider)}</span>
                <span className="session-copy">
                  <strong>{flightTitle(session.title, session.projectName)}</strong>
                  <span>
                    {session.projectName} · {relativeTime(session.updatedAt)}
                  </span>
                </span>
                <span className="session-events">{formatCompact(session.metrics.totalEvents)}</span>
                {session.status === 'live' && <span className="live-flag">LIVE</span>}
              </button>
            ))}
            {!visibleSessions.length && <EmptySessions sources={sources} />}
          </div>
          <div className="source-rack">
            <span>SOURCE RACK</span>
            {sources.map((source) => (
              <div key={source.provider} title={source.detail}>
                <i className={source.available ? 'available' : ''} />
                <b>{source.provider}</b>
                <small>{source.detail}</small>
              </div>
            ))}
            {captureHealth?.delivery.components.map((component) => (
              <div key={component.component} title={`Last receipt ${relativeTime(component.lastSeenAt)}`}>
                <i className={component.state === 'active' ? 'available' : ''} />
                <b>{component.component}</b>
                <small>{component.state === 'active' ? 'HEARTBEAT ACTIVE' : `IDLE · ${relativeTime(component.lastSeenAt)}`}</small>
              </div>
            ))}
            {captureHealth && (
              <div title={captureHealth.delivery.limitation}>
                <i className={captureHealth.status === 'healthy' ? 'available' : ''} />
                <b>evidence</b>
                <small>
                  {captureHealth.calls.stale} STALE CALLS · {captureHealth.permissions.unknown} UNKNOWN PERMISSIONS
                </small>
              </div>
            )}
          </div>
        </aside>

        <main className="timeline-bay">
          {selectedSession ? (
            <>
              <section className="flight-header">
                <div className="flight-title-row">
                  <div>
                    <p className="eyebrow">FLIGHT / {selectedSession.nativeSessionId.slice(0, 12).toUpperCase()}</p>
                    <h2>{flightTitle(selectedSession.title, selectedSession.projectName)}</h2>
                    <p className="flight-path">{selectedSession.cwd ?? 'Workspace unavailable'}</p>
                  </div>
                  <label className="comparison-control">
                    <span>COMPARE TARGET</span>
                    <select value={comparisonSessionId} onChange={(event) => setComparisonSessionId(event.target.value)}>
                      <option value="">NONE</option>
                      {sessions
                        .filter((session) => session.id !== selectedSession.id)
                        .map((session) => (
                          <option key={session.id} value={session.id}>
                            {flightTitle(session.title, session.projectName)} · {session.provider}
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="flight-agent">
                    <span className={`provider-glyph provider-${selectedSession.provider}`}>{providerInitial(selectedSession.provider)}</span>
                    <div>
                      <b>{selectedSession.provider}</b>
                      <span>{selectedSession.model ?? selectedSession.agentVersion ?? 'native adapter'}</span>
                    </div>
                  </div>
                </div>
                <div className="metric-strip">
                  <Metric label="EVENTS" value={selectedSession.metrics.totalEvents} />
                  <Metric label="TOOLS" value={selectedSession.metrics.toolCalls} />
                  <Metric label="FILES" value={selectedSession.metrics.fileChanges} />
                  <Metric label="COMMANDS" value={selectedSession.metrics.terminalCommands} />
                  <Metric label="TESTS" value={selectedSession.metrics.testRuns} />
                  <Metric label="TOKENS" value={selectedSession.metrics.tokensIn + selectedSession.metrics.tokensOut} compact />
                  <Metric label="FAILURES" value={selectedSession.metrics.errors} alert={selectedSession.metrics.errors > 0} />
                  <Metric label="GAPS" value={selectedSession.metrics.captureGaps} alert={selectedSession.metrics.captureGaps > 0} />
                </div>
              </section>

              {comparison && <ComparisonStrip comparison={comparison} />}

              <section className="playback-deck" aria-label="Timeline playback controls">
                <button
                  type="button"
                  className="transport-main"
                  onClick={() => setPlaying((value) => !value)}
                  aria-label={playing ? 'Pause replay' : 'Play replay'}
                >
                  {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
                </button>
                <button type="button" className="transport-step" onClick={() => moveCursor(-1)} aria-label="Previous event">
                  <ChevronLeft size={16} />
                </button>
                <button type="button" className="transport-step" onClick={() => moveCursor(1)} aria-label="Next event">
                  <ChevronRight size={16} />
                </button>
                <span className="timecode">
                  {String(cursor + 1).padStart(4, '0')} <i>/</i> {String(visibleEvents.length).padStart(4, '0')}
                </span>
                <input
                  className="scrubber"
                  type="range"
                  min={0}
                  max={Math.max(0, visibleEvents.length - 1)}
                  value={cursor}
                  onChange={(event) => setSelectedEventId(visibleEvents[Number(event.target.value)]?.id ?? null)}
                  aria-label="Timeline position"
                />
                <span className="keyboard-hint">J/K STEP · SPACE PLAY</span>
              </section>

              <section className="filter-deck">
                <div className="filter-row">
                  {FILTERS.map((filter) => {
                    const count =
                      filter.id === 'all'
                        ? events.length
                        : filter.id === 'error'
                          ? events.filter((event) => event.status === 'error').length
                          : events.filter((event) => event.kind === filter.id).length;
                    return (
                      <button
                        type="button"
                        key={filter.id}
                        className={activeFilter === filter.id ? 'active' : ''}
                        aria-pressed={activeFilter === filter.id}
                        onClick={() => setActiveFilter(filter.id)}
                      >
                        {filter.label}
                        <span>{count}</span>
                      </button>
                    );
                  })}
                </div>
                <label className="event-search">
                  <Search size={13} />
                  <input value={eventQuery} onChange={(event) => setEventQuery(event.target.value)} placeholder="FIND IN TIMELINE" aria-label="Search events" />
                </label>
              </section>

              <section className="timeline-scroll" ref={timelineRef} aria-label="Session event timeline">
                <div className="timeline-canvas" style={{ height: `${eventVirtualizer.getTotalSize()}px` }}>
                  <div className="timeline-axis" />
                  {eventVirtualizer.getVirtualItems().map((virtualRow) => {
                    const event = visibleEvents[virtualRow.index];
                    return (
                      <EventRow
                        key={event.id}
                        event={event}
                        index={virtualRow.index}
                        start={selectedSession.startedAt}
                        selected={event.id === selectedEventId}
                        onSelect={() => {
                          setSelectedEventId(event.id);
                          setPlaying(false);
                          setMobilePane('evidence');
                        }}
                        measureRef={eventVirtualizer.measureElement}
                        offset={virtualRow.start}
                      />
                    );
                  })}
                </div>
                {loadingEvents && (
                  <div className="no-events" role="status">
                    <RefreshCw size={22} className="spin" />
                    <b>LOADING FLIGHT SIGNALS</b>
                    <span>Decrypting the local timeline.</span>
                  </div>
                )}
                {!loadingEvents && !visibleEvents.length && (
                  <div className="no-events">
                    <CircleDot size={22} />
                    <b>NO SIGNALS IN THIS CHANNEL</b>
                    <span>Adjust filters or search terms.</span>
                  </div>
                )}
              </section>
            </>
          ) : loadingShell ? (
            <LoadingState />
          ) : (
            <WelcomeState onScan={() => void scanNow()} scanning={scanning} />
          )}
        </main>

        <aside className="inspector-bay" aria-label="Event inspector">
          <div className="panel-heading">
            <div>
              <span className="section-index">03</span>
              <h2>EVENT INSPECTOR</h2>
            </div>
            {eventDetail && <span className={`status-stamp status-${eventDetail.status}`}>{eventDetail.status}</span>}
          </div>
          {eventDetail ? (
            <EventInspector
              event={eventDetail}
              evolution={evolution}
              lineage={lineage}
              permissionTrace={permissionTrace}
              onEvolutionPath={selectEvolutionPath}
            />
          ) : (
            <div className="inspector-empty">
              <Zap size={28} />
              <p>Select a signal to inspect its native evidence.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function ComparisonStrip({ comparison }: { comparison: SessionComparison }) {
  return (
    <section className="comparison-strip" aria-label="Session comparison">
      <div className="comparison-caption">
        <span>TARGET Δ</span>
        <b>{flightTitle(comparison.right.title, 'Recorded flight')}</b>
        <small>relative to {flightTitle(comparison.left.title, 'recorded flight')}</small>
      </div>
      <SignedMetric label="EVENTS" value={comparison.metricDelta.totalEvents} />
      <SignedMetric label="TOOLS" value={comparison.metricDelta.toolCalls} />
      <SignedMetric label="TESTS" value={comparison.metricDelta.testRuns} />
      <SignedMetric label="FAILURES" value={comparison.metricDelta.errors} adverse />
      <SignedMetric label="TOKENS" value={comparison.metricDelta.tokensIn + comparison.metricDelta.tokensOut} />
      <SignedMetric label="GAPS" value={comparison.metricDelta.captureGaps} adverse />
      <div className="comparison-files">
        <b>{comparison.files.shared.length}</b>
        <span>SHARED FILES</span>
        <small>
          −{comparison.files.leftOnly.length} / +{comparison.files.rightOnly.length}
        </small>
      </div>
    </section>
  );
}

function SignedMetric({ label, value, adverse = false }: { label: string; value: number; adverse?: boolean }) {
  const tone = value === 0 ? 'neutral' : adverse ? (value > 0 ? 'worse' : 'better') : value > 0 ? 'higher' : 'lower';
  return (
    <div className={`signed-metric ${tone}`}>
      <b>
        {value > 0 ? '+' : ''}
        {formatCompact(value)}
      </b>
      <span>{label}</span>
    </div>
  );
}

function EventRow({
  event,
  index,
  start,
  selected,
  onSelect,
  measureRef,
  offset,
}: {
  event: RecorderEvent;
  index: number;
  start: string;
  selected: boolean;
  onSelect: () => void;
  measureRef: (node: Element | null) => void;
  offset: number;
}) {
  const meta = KIND_META[event.kind];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      ref={measureRef}
      data-index={index}
      aria-current={selected ? 'true' : undefined}
      style={{ transform: `translateY(${offset}px)` }}
      className={`event-row virtual ${selected ? 'selected' : ''} tone-${meta.tone} status-${event.status}`}
      onClick={onSelect}
    >
      <span className="event-sequence">{String(index + 1).padStart(3, '0')}</span>
      <span className="event-elapsed">+{elapsed(start, event.timestamp)}</span>
      <span className="event-node">
        <Icon size={14} strokeWidth={1.8} />
      </span>
      <span className="event-body">
        <span className="event-kicker">
          <b>{meta.label}</b>
          {event.durationMs !== null && <i>{duration(event.durationMs)}</i>}
          {event.actor && <i>{event.actor}</i>}
        </span>
        <strong>{event.title}</strong>
        <span>{event.summary || 'No summary emitted'}</span>
        {(event.command || event.path) && <code>{event.path ?? firstLine(event.command ?? '')}</code>}
      </span>
      <span className="event-status" aria-hidden="true" />
      <span className="sr-only">Status: {event.status}</span>
    </button>
  );
}

function EventInspector({
  event,
  evolution,
  lineage,
  permissionTrace,
  onEvolutionPath,
}: {
  event: RecorderEvent;
  evolution: CodeEvolution | null;
  lineage: CallLineage | null;
  permissionTrace: PermissionTrace | null;
  onEvolutionPath: (path: string) => void;
}) {
  const meta = KIND_META[event.kind];
  const Icon = meta.icon;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : { value: event.payload };
  return (
    <div className="inspector-scroll">
      <section className={`inspector-hero tone-${meta.tone}`}>
        <span className="inspector-icon">
          <Icon size={19} />
        </span>
        <p>
          {meta.label.toUpperCase()} / #{String(event.sequence).padStart(5, '0')}
        </p>
        <h3>{event.title}</h3>
        <span>{event.summary}</span>
      </section>
      <section className="data-grid">
        <DataPoint label="TIMESTAMP" value={formatTimestamp(event.timestamp)} />
        <DataPoint label="DURATION" value={event.durationMs === null ? '—' : duration(event.durationMs)} />
        <DataPoint label="ACTOR" value={event.actor ?? '—'} />
        <DataPoint label="STATUS" value={event.status} />
        {event.callId && <DataPoint label="CALL ID" value={event.callId.slice(0, 16)} wide />}
        {event.turnId && <DataPoint label="TURN ID" value={event.turnId.slice(0, 16)} wide />}
      </section>
      {event.command && (
        <InspectorBlock title="COMMAND">
          <pre>{event.command}</pre>
        </InspectorBlock>
      )}
      {event.path && (
        <InspectorBlock title="AFFECTED PATH">
          <code className="path-code">{event.path}</code>
        </InspectorBlock>
      )}
      {lineage && lineage.attempts.length > 0 && <AttemptLineage lineage={lineage} />}
      {permissionTrace && permissionTrace.flows.length > 0 && <PermissionEvidence trace={permissionTrace} />}
      {event.kind === 'file' && <FileEvolution event={event} evolution={evolution} onPath={onEvolutionPath} />}
      {(event.tokensIn !== null || event.tokensOut !== null) && (
        <InspectorBlock title="RESOURCE METER">
          <div className="resource-grid">
            <DataPoint label="INPUT" value={formatCompact(event.tokensIn ?? 0)} />
            <DataPoint label="OUTPUT" value={formatCompact(event.tokensOut ?? 0)} />
            <DataPoint label="CACHED" value={formatCompact(event.cachedTokens ?? 0)} />
          </div>
        </InspectorBlock>
      )}
      <InspectorBlock title="NORMALIZED PAYLOAD">
        <JsonTree value={payload} />
      </InspectorBlock>
      {event.raw !== undefined && (
        <details className="raw-evidence">
          <summary>RAW NATIVE EVIDENCE</summary>
          <pre>{JSON.stringify(event.raw, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function PermissionEvidence({ trace }: { trace: PermissionTrace }) {
  const flow = trace.current;
  if (!flow) return null;
  return (
    <InspectorBlock title="PERMISSION EVIDENCE">
      <div className={`permission-verdict permission-${flow.outcome}`}>
        <ShieldCheck size={15} />
        <span>
          <b>{flow.outcome}</b>
          <small>{flow.assurance} evidence</small>
        </span>
      </div>
      <div className="permission-facts">
        <DataPoint label="PROVIDER EVENT" value={flow.providerEvent ?? 'not exposed'} />
        <DataPoint label="TOOL" value={flow.tool ?? 'not exposed'} />
      </div>
      {flow.reason && <p className="permission-reason">{flow.reason}</p>}
      {flow.assurance === 'inferred' && (
        <p className="permission-caveat">Execution was observed, but the provider did not emit the operator’s manual allow/deny response.</p>
      )}
      {flow.assurance === 'unresolved' && (
        <p className="permission-caveat">A permission request was observed; no correlated decision or execution evidence has arrived.</p>
      )}
    </InspectorBlock>
  );
}

function AttemptLineage({ lineage }: { lineage: CallLineage }) {
  return (
    <InspectorBlock title="ATTEMPT LINEAGE">
      <div className="attempt-lineage">
        {lineage.attempts.map((attempt) => {
          const active = attempt.eventId === lineage.current?.eventId;
          const elapsed = attempt.completedAt ? Math.max(0, Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt)) : null;
          return (
            <div className={`attempt-card outcome-${attempt.outcome} ${active ? 'active' : ''}`} key={attempt.eventId}>
              <span>ATTEMPT {String(attempt.attempt).padStart(2, '0')}</span>
              <b>{attempt.outcome}</b>
              <small>
                {elapsed === null ? 'result pending' : duration(elapsed)} · {attempt.callId?.slice(0, 12) ?? 'no call id'} · {attempt.facets} facet
                {attempt.facets === 1 ? '' : 's'}
              </small>
              {!attempt.startObserved && <small>start callback not observed</small>}
            </div>
          );
        })}
      </div>
      <p className="lineage-note">Retries are derived only when an identical invocation follows an observed error or block.</p>
    </InspectorBlock>
  );
}

function FileEvolution({ event, evolution, onPath }: { event: RecorderEvent; evolution: CodeEvolution | null; onPath: (path: string) => void }) {
  const diff = evolution?.unifiedDiff ?? extractEvolution(event);
  return (
    <InspectorBlock title="CODE EVOLUTION">
      {evolution && evolution.availablePaths.length > 1 && (
        <fieldset className="evolution-paths">
          <legend className="sr-only">Affected files</legend>
          {evolution.availablePaths.map((path) => (
            <button type="button" key={path} className={path === evolution.path ? 'active' : ''} onClick={() => onPath(path)} title={path}>
              {path.split(/[/\\]/).pop()}
            </button>
          ))}
        </fieldset>
      )}
      {evolution && (evolution.before || evolution.after) && (
        <div className="snapshot-pair">
          <SnapshotCard label="BEFORE" snapshot={evolution.before} />
          <span className="snapshot-arrow">→</span>
          <SnapshotCard label="AFTER" snapshot={evolution.after} />
        </div>
      )}
      {evolution?.gaps.map((gap) => (
        <div className="evolution-gap" key={gap.eventId}>
          <AlertTriangle size={12} />
          <span>
            <b>{gap.code}</b>
            {gap.message}
          </span>
        </div>
      ))}
      {diff ? <DiffView diff={diff} /> : <p className="evolution-empty">No trustworthy full diff or provider edit hunk is available for this event.</p>}
      {evolution?.diffTruncated && <p className="diff-note">Diff preview truncated at 2 MiB; snapshot hashes still identify the captured boundaries.</p>}
    </InspectorBlock>
  );
}

function DiffView({ diff }: { diff: string }) {
  const occurrences = new Map<string, number>();
  return (
    <section className="diff-view" aria-label="Recorded code change">
      {diff
        .split('\n')
        .slice(0, 1200)
        .map((line) => {
          const occurrence = (occurrences.get(line) ?? 0) + 1;
          occurrences.set(line, occurrence);
          const className =
            line.startsWith('+') && !line.startsWith('+++')
              ? 'added'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'removed'
                : line.startsWith('@@') || line.startsWith('***')
                  ? 'marker'
                  : '';
          return (
            <span className={className} key={`${line}-${occurrence}`}>
              {line || ' '}
            </span>
          );
        })}
    </section>
  );
}

function SnapshotCard({ label, snapshot }: { label: string; snapshot: FileSnapshot | null }) {
  return (
    <div className={`snapshot-card ${snapshot ? `snapshot-${snapshot.status}` : 'snapshot-unavailable'}`}>
      <span>{label}</span>
      <b>{snapshot?.status ?? 'unavailable'}</b>
      <code>{snapshot?.hash?.slice(0, 10) ?? '—'}</code>
      <small>{snapshot ? `${snapshot.assurance} · ${snapshot.byteSize === null ? '—' : formatBytes(snapshot.byteSize)}` : 'boundary missing'}</small>
    </div>
  );
}

function JsonTree({ value }: { value: unknown }) {
  return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>;
}

function InspectorBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="inspector-block">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function DataPoint({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'data-point wide' : 'data-point'}>
      <span>{label}</span>
      <b title={value}>{value}</b>
    </div>
  );
}

function Metric({ label, value, compact = false, alert = false }: { label: string; value: number; compact?: boolean; alert?: boolean }) {
  return (
    <div className={alert ? 'metric alert' : 'metric'}>
      <b>{compact ? formatCompact(value) : value.toLocaleString()}</b>
      <span>{label}</span>
    </div>
  );
}

function EmptySessions({ sources }: { sources: SourceHealth[] }) {
  const detected = sources.filter((source) => source.available).length;
  return (
    <div className="session-empty">
      <HardDrive size={24} />
      <b>NO FLIGHTS LOADED</b>
      <span>
        {detected} native source{detected === 1 ? '' : 's'} detected. Run a scan to ingest local evidence.
      </span>
    </div>
  );
}

function WelcomeState({ onScan, scanning }: { onScan: () => void; scanning: boolean }) {
  return (
    <div className="welcome-state">
      <div className="radar-mark">
        <span />
        <span />
        <CircleDot size={30} />
      </div>
      <p className="eyebrow">BLACK BOX READY</p>
      <h2>
        MAKE THE INVISIBLE
        <br />
        EXECUTION VISIBLE.
      </h2>
      <p>Native agent traces stay on this machine, normalized into an auditable timeline without cloud telemetry.</p>
      <button type="button" onClick={onScan} disabled={scanning}>
        <RefreshCw size={15} className={scanning ? 'spin' : ''} /> {scanning ? 'SCANNING SOURCES' : 'SCAN LOCAL SOURCES'}
      </button>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="welcome-state" role="status" aria-live="polite">
      <div className="radar-mark loading">
        <span />
        <span />
        <RefreshCw size={28} className="spin" />
      </div>
      <p className="eyebrow">OPENING LOCAL BLACK BOX</p>
      <h2>
        ASSEMBLING THE
        <br />
        FLIGHT TIMELINE.
      </h2>
      <p>Reading encrypted evidence and checking recorder health on this machine.</p>
    </div>
  );
}

function providerInitial(provider: RecordedSession['provider']): string {
  return provider === 'opencode' ? 'O' : provider === 'claude' ? 'C' : provider === 'cursor' ? '⌁' : provider === 'compatible' ? '+' : 'X';
}

function flightTitle(title: string, fallback: string): string {
  const normalized = title.trim();
  return normalized.startsWith('<') || /path=["']\/var\/folders\//i.test(normalized) ? fallback : normalized || fallback;
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'NOW';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}M AGO`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}H AGO`;
  return `${Math.floor(seconds / 86_400)}D AGO`;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value).toUpperCase();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date(value));
}

function elapsed(start: string, current: string): string {
  const milliseconds = Math.max(0, new Date(current).getTime() - new Date(start).getTime());
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1000)}s`;
}

function firstLine(value: string): string {
  const line = value.split('\n')[0];
  return line.length > 110 ? `${line.slice(0, 109)}…` : line;
}

function extractEvolution(event: RecorderEvent): string | null {
  const payload = asRecord(event.payload);
  const raw = asRecord(event.raw);
  const input = payload.input;
  const stringCandidates = [
    typeof input === 'string' ? input : null,
    typeof payload.patch === 'string' ? payload.patch : null,
    typeof payload.diff === 'string' ? payload.diff : null,
    typeof raw.input === 'string' ? raw.input : null,
    event.command,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of stringCandidates) {
    const decoded = candidate.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
    const start = decoded.indexOf('*** Begin Patch');
    if (start >= 0) {
      const end = decoded.indexOf('*** End Patch', start);
      return decoded.slice(start, end >= 0 ? end + '*** End Patch'.length : undefined);
    }
    if (/^(diff --git|---\s|@@\s)/m.test(decoded)) return decoded;
  }
  const edits = Array.isArray(payload.edits) ? payload.edits : Array.isArray(raw.edits) ? raw.edits : null;
  if (edits) {
    return edits
      .map((value, index) => {
        const edit = asRecord(value);
        const oldText = typeof edit.old_string === 'string' ? edit.old_string : typeof edit.oldString === 'string' ? edit.oldString : '';
        const newText = typeof edit.new_string === 'string' ? edit.new_string : typeof edit.newString === 'string' ? edit.newString : '';
        return [`@@ edit ${index + 1} @@`, ...oldText.split('\n').map((line) => `-${line}`), ...newText.split('\n').map((line) => `+${line}`)].join('\n');
      })
      .join('\n');
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function formatError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
