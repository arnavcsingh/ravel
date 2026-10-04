import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DebuggerSnapshotSchema,
  HazardDetailSchema,
  ReplayPlanSchema,
  type DebuggerSnapshot,
  type GraphNode,
  type HazardDetail,
  type RavelEvent,
  type ReplayStep,
  type Run,
  type Version,
  type TimelineEvent,
} from '@ravel/shared';
import { api } from './api';
import { connectLive, type LiveMode } from './live';
import { Timeline } from './Timeline';
import { CausalGraph } from './CausalGraph';
import { Inspector } from './Inspector';
import { LiveRunPanel, useLiveRun } from './LiveRun';
import { WorkspaceSplit } from './WorkspaceSplit';
import { ResourceHeads } from './ResourceHeads';
import { EventDetails } from './EventDetails';
import { RaceSummary } from './RaceSummary';
import { executionView, rejectedInputs } from './traceView';
import { GuardValidationPanel } from './GuardValidationPanel';

type DemoStatus = {
  phase: string;
  canRelease: boolean;
  error: string | null;
  workspaceError: string | null;
};
export default function App() {
  const [runs, setRuns] = useState<Run[]>([]),
    [runId, setRunId] = useState('');
  const liveRun = useLiveRun(runId);
  const [selectedEvent, setSelectedEvent] = useState<TimelineEvent | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const versionRequest = useRef(0);
  const [snapshot, setSnapshot] = useState<DebuggerSnapshot | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<HazardDetail | null>(null);
  const [version, setVersion] = useState<(Version & { content: string | null }) | null>(null),
    [error, setError] = useState(''),
    [connected, setConnected] = useState(false);
  const [live, setLive] = useState(true),
    [latest, setLatest] = useState(1),
    [playing, setPlaying] = useState(false),
    [step, setStep] = useState<ReplayStep | null>(null);
  const [liveMode, setLiveMode] = useState<LiveMode>('sse');
  const [events, setEvents] = useState<RavelEvent[]>([]),
    [eventView, setEventView] = useState(false),
    [history, setHistory] = useState(false),
    [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<DemoStatus | null>(null),
    [mode, setMode] = useState<'observe' | 'guard'>('observe'),
    [interactive, setInteractive] = useState(true);
  const about = useRef<HTMLDialogElement>(null),
    playback = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    loading = useRef<AbortController | null>(null);
  const report = useCallback((failure: unknown) => {
    if ((failure as Error).name !== 'AbortError') setError((failure as Error).message);
  }, []);
  const action = (fn: () => Promise<unknown>) => () => {
    setError('');
    setBusy(true);
    fn()
      .catch(report)
      .finally(() => setBusy(false));
  };
  const stop = useCallback(() => {
    playback.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPlaying(false);
  }, []);
  const loadRuns = useCallback(async () => {
    const values = await api<Run[]>('/runs');
    setRuns(values);
    return values;
  }, []);
  const load = useCallback(
    async (seq?: number) => {
      if (!runId) return;
      loading.current?.abort();
      const controller = new AbortController();
      loading.current = controller;
      const [value, status] = await Promise.all([
        api<unknown>(`/runs/${runId}/debugger${seq ? `?seq=${seq}` : ''}`, {
          signal: controller.signal,
        }),
        api<DemoStatus>(`/runs/${runId}/demo`, { signal: controller.signal }).catch((failure) => {
          report(failure);
          return null;
        }),
      ]);
      if (controller.signal.aborted) return;
      const parsed = DebuggerSnapshotSchema.parse(value);
      setSnapshot(parsed);
      setLatest(parsed.latestRuntimeSeq);
      setDemo(status);
      return parsed;
    },
    [runId, report],
  );
  useEffect(() => {
    loadRuns()
      .then((values) => setRunId(values[0]?.id ?? ''))
      .catch(report);
  }, [loadRuns, report]);
  useEffect(() => {
    stop();
    setLive(true);
    setEvents([]);
    setSnapshot(null);
    setSelectedEvent(null);
    setSelectedAgent(null);
    setSelectedVersion(null);
    versionRequest.current++;
    setSelected(null);
    setVersion(null);
    setStep(null);
    setDetail(null);
    load().catch(report);
    return () => {
      loading.current?.abort();
      stop();
    };
  }, [runId, load, stop, report]);
  useEffect(() => {
    if (!runId) return;
    return connectLive(runId, {
      status: (connected, mode) => {
        setConnected(connected);
        setLiveMode(mode);
      },
      error: report,
      snapshot: (value) => {
        setLatest((old) => Math.max(old, value.latestRuntimeSeq));
        if (live) {
          loading.current?.abort();
          setSnapshot(value);
        }
        api<DemoStatus>(`/runs/${runId}/demo`).then(setDemo).catch(report);
      },
      update: (seq, kind) => {
        setLatest((old) => Math.max(old, seq));
        if (live) load().catch(report);
        if (kind === 'DEMO_FAILED')
          setError('The demo failed. Check the runtime terminal and start a new run.');
      },
    });
  }, [runId, live, load, report]);
  const hazardId =
    snapshot?.hazards.find((h) => h.id === selected)?.id ??
    snapshot?.hazards.find((h) => history || h.active)?.id ??
    null;
  useEffect(() => {
    setDetail(null);
    if (!hazardId || !snapshot) return;
    const controller = new AbortController();
    api<unknown>(`/hazards/${hazardId}?seq=${snapshot.currentRuntimeSeq}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setDetail(HazardDetailSchema.parse(value));
      })
      .catch(report);
    return () => controller.abort();
  }, [hazardId, snapshot?.currentRuntimeSeq, report]);
  useEffect(() => {
    if (!snapshot) return;
    const controller = new AbortController();
    api<RavelEvent[]>(`/runs/${runId}/events?seq=${snapshot.currentRuntimeSeq}`, {
      signal: controller.signal,
    })
      .then(setEvents)
      .catch(report);
    return () => controller.abort();
  }, [eventView, snapshot?.currentRuntimeSeq, runId, report]);
  async function play(steps: ReplayStep[]) {
    stop();
    setLive(false);
    setPlaying(true);
    versionRequest.current++;
    setSelectedEvent(null);
    setSelectedVersion(null);
    setSelectedAgent(null);
    setVersion(null);
    const token = playback.current;
    const tick = async (index: number) => {
      if (token !== playback.current) return;
      const next = steps[index];
      if (!next) {
        setPlaying(false);
        return;
      }
      setStep(next);
      const frame = await load(next.runtimeSeq);
      const event = frame?.timeline.find((e) => e.runtimeSeq === next.runtimeSeq);
      setSelectedAgent(
        event?.agentId ?? frame?.agents.find((a) => a.name === next.agent)?.id ?? null,
      );
      setSelectedVersion(event?.versionId ?? next.highlightNodes[0] ?? null);
      if (token === playback.current)
        timer.current = setTimeout(() => tick(index + 1).catch(report), 950);
    };
    await tick(0);
  }
  async function replayRace() {
    if (!hazardId) return;
    const plan = ReplayPlanSchema.parse(await api(`/hazards/${hazardId}/replay`));
    setSelected(hazardId);
    await play(plan.steps);
  }
  async function newDemo() {
    stop();
    setError('');
    const result = await api<{ runId: string }>('/demo', {
      method: 'POST',
      body: JSON.stringify({ mode, interactive }),
    });
    await loadRuns();
    setRunId(result.runId);
  }
  async function inspectVersion(node: GraphNode) {
    const request = ++versionRequest.current;
    setSelectedVersion(node.id);
    setVersion(null);
    const value = await api<Version & { content: string | null }>(`/versions/${node.id}/content`);
    if (request === versionRequest.current) setVersion(value);
  }
  function inspectEvent(event: TimelineEvent) {
    versionRequest.current++;
    setSelectedEvent(event);
    setSelectedAgent(event.agentId);
    setSelectedVersion(event.versionId);
    setVersion(null);
    if (event.hazardIds[0]) {
      setSelected(event.hazardIds[0]);
      if (!snapshot?.hazards.find((h) => h.id === event.hazardIds[0])?.active) setHistory(true);
    }
  }
  async function inspect(node: GraphNode) {
    setSelectedVersion(node.id);
    setSelectedEvent(null);
    versionRequest.current++;
    setSelectedVersion(node.id);
    setSelectedAgent(
      snapshot?.timeline.find((e) => e.versionId === node.id && e.action !== 'OBSERVE')?.agentId ??
        null,
    );
    if (node.hazardIds[0]) {
      setSelected(node.hazardIds[0]);
      setVersion(null);
      if (!snapshot?.hazards.find((h) => h.id === node.hazardIds[0])?.active) setHistory(true);
    } else await inspectVersion(node);
  }
  const shownHazards = snapshot?.hazards.filter((h) => history || h.active) ?? [];
  const trace = snapshot ? executionView(snapshot, events, liveRun?.timelineExtras) : null;
  return (
    <>
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Ravel home">
          <svg viewBox="0 0 32 36" aria-hidden="true">
            <path d="M6 31V5h12c12 0 12 16 0 16H6m10 0 11 10M6 12h12" />
          </svg>
          ravel<span className="brand-dot">.</span>
        </a>
        <div className="workspace-label">
          WORKSPACE <span>LOCAL</span>
        </div>
        <div className="workspace-name">
          {snapshot?.run.scenario ?? snapshot?.run.name ?? 'Select a run'}
        </div>
        <div className="nav-label">OBSERVABILITY</div>
        <nav aria-label="Main navigation">
          <button
            className={`nav-item ${!eventView ? 'active' : ''}`}
            onClick={() => setEventView(false)}
            aria-label="Causal debugger"
            aria-pressed={!eventView}
          >
            Causal debugger
            <span
              className={snapshot?.hazards.some((h) => h.active) ? 'nav-count danger' : 'nav-count'}
            >
              {snapshot?.hazards.filter((h) => h.active).length ?? 0}
            </span>
          </button>
          <button
            className={`nav-item ${eventView ? 'active' : ''}`}
            onClick={() => setEventView(true)}
            aria-label="Event log"
            aria-pressed={eventView}
          >
            Event log
          </button>
        </nav>
        <div className="sidebar-bottom">
          <span className={`connection-dot ${connected ? '' : 'disconnected'}`} />
          <span>
            {connected
              ? liveMode === 'spacetime'
                ? 'SpacetimeDB live'
                : 'Runtime connected · SSE'
              : 'Reconnecting…'}
          </span>
          <span>v0.3</span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="muted">Workspace</span>
            <span className="slash">/</span>
            {eventView ? 'Event log' : 'Causal debugger'}
          </div>
          <button className="text-button" onClick={() => about.current?.showModal()}>
            How to read this trace <span>↗</span>
          </button>
        </header>
        <div className="page-heading">
          <div>
            <h1>{eventView ? 'Event log' : 'Causal debugger'}</h1>
            <p>Agent execution, shared state, and the consequences of stale context.</p>
          </div>
          <button
            className="button primary"
            disabled={busy || ['held', 'running', 'ready'].includes(demo?.phase ?? '')}
            onClick={action(newDemo)}
          >
            {busy ? 'Working…' : 'Run scripted fixture'}
          </button>
        </div>
        <LiveRunPanel
          status={liveRun}
          historical={!live}
          selectAgent={setSelectedAgent}
          selectedAgentId={selectedAgent}
          onCreated={async (id) => {
            await loadRuns();
            setRunId(id);
          }}
        />
        <div className="runbar">
          <div className="run-choice">
            <label htmlFor="run-select">Run</label>
            <select
              id="run-select"
              aria-label="Select recorded run"
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
            >
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name} · {run.mode} · {run.id.slice(0, 8)} ·{' '}
                  {new Date(run.startedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </option>
              ))}
            </select>
          </div>
          <div className="run-meta">
            <span className="pill">{snapshot?.run.mode.toUpperCase() ?? 'OBSERVE'} MODE</span>
            <span className="status-label">
              {!live
                ? playing
                  ? 'PLAYING TRACE'
                  : 'HISTORICAL VIEW'
                : demo?.phase === 'held'
                  ? 'MUTATION HELD'
                  : snapshot?.run.status === 'running'
                    ? 'RUNNING'
                    : 'RECORDED'}
            </span>
          </div>
        </div>
        <div className="demo-options">
          <label>
            Next run{' '}
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as 'observe' | 'guard')}
              aria-label="Next run mode"
            >
              <option value="observe">Observe the race</option>
              <option value="guard">Guard and retry</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={interactive}
              onChange={(event) => setInteractive(event.target.checked)}
            />
            Pause before the stale write commits
          </label>
          <span>Scripted demo · no API keys</span>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
            <button className="text-button" onClick={() => setError('')}>
              Dismiss
            </button>
          </div>
        )}
        {demo?.canRelease && (
          <div className="held-banner">
            <div>
              <strong>The backend’s candidate is waiting.</strong>
              <p>
                The database has changed its input. Release the write to{' '}
                {snapshot?.run.mode === 'guard'
                  ? 'watch Guard reject it and retry.'
                  : 'watch Ravel detect the stale derivation.'}
              </p>
            </div>
            <button
              className="button primary"
              disabled={busy}
              onClick={action(async () => {
                await api(`/runs/${runId}/release`, { method: 'POST' });
                await load();
              })}
            >
              Release pending write →
            </button>
          </div>
        )}
        {demo?.workspaceError && (
          <div className="error">
            Logical history was saved, but workspace materialization failed: {demo.workspaceError}
            <button
              className="button"
              onClick={action(async () => {
                await api(`/runs/${runId}/reconstruct`, { method: 'POST' });
                await load();
              })}
            >
              Rebuild workspace
            </button>
          </div>
        )}
        {!snapshot ? (
          <div className="empty-state" role="status">
            {error
              ? 'Execution unavailable. Check the runtime connection and reload.'
              : runId
                ? 'Loading the recorded execution…'
                : 'Create a New Live Run to begin an experiment.'}
          </div>
        ) : (
          <>
            {snapshot.run.mode === 'guard' && snapshot.guard.rejectedWrites > 0 && (
              <div className="guard-banner" role="status">
                <strong>
                  Guard prevented {snapshot.guard.rejectedWrites} stale write
                  {snapshot.guard.rejectedWrites === 1 ? '' : 's'}.
                </strong>
                <span>
                  {snapshot.guard.retries} replacement attempt
                  {snapshot.guard.retries === 1 ? '' : 's'} used fresh state.{' '}
                  {snapshot.activeAffectedCount === 0
                    ? 'Current heads are clean.'
                    : 'Inspect the remaining affected heads.'}
                </span>
              </div>
            )}
            <div className="stats">
              <div>
                <span className="stat-label">Agents</span>
                <strong>{snapshot.agents.length}</strong>
                <span className="stat-detail">sharing a workspace</span>
              </div>
              <div>
                <span className="stat-label">Recorded events</span>
                <strong>{snapshot.eventCount}</strong>
                <span className="stat-detail">ordered by the runtime</span>
              </div>
              <div>
                <span className="stat-label">Active incidents</span>
                <strong className={snapshot.hazards.some((h) => h.active) ? 'danger' : ''}>
                  {snapshot.hazards.filter((h) => h.active).length}
                </strong>
                <span className="stat-detail">stale observations</span>
              </div>
              <div>
                <span className="stat-label">Affected heads</span>
                <strong>{snapshot.activeAffectedCount}</strong>
                <span className="stat-detail">in current shared state</span>
              </div>
            </div>
            {eventView ? (
              <section className="panel">
                <div className="panel-heading">
                  <h2>Immutable event log</h2>
                  <span className="mono">RUNTIME ORDER</span>
                </div>
                <div className="event-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>SEQ</th>
                        <th>AGENT</th>
                        <th>EVENT</th>
                        <th>DETAIL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((event) => (
                        <tr
                          key={event.id}
                          className={
                            snapshot.timeline.some(
                              (entry) => entry.id === event.id && entry.hazardIds.length > 0,
                            )
                              ? 'event-hazard'
                              : ''
                          }
                        >
                          <td>{String(event.runtimeSeq).padStart(3, '0')}</td>
                          <td>
                            {snapshot.agents.find((a) => a.id === event.agentId)?.name ?? 'Runtime'}
                          </td>
                          <td>{event.kind}</td>
                          <td>
                            {snapshot.timeline.find((e) => e.id === event.id)?.description ??
                              (event.kind === 'TOOL_RESULT' ? event.payload.output : '—')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : (
              <>
                <div className="incidents-bar">
                  <label>
                    <input
                      type="checkbox"
                      checked={history}
                      onChange={(event) => {
                        setHistory(event.target.checked);
                        setSelected(null);
                        setVersion(null);
                      }}
                    />
                    Include historical incidents
                  </label>
                  {shownHazards.length > 0 && (
                    <select
                      aria-label="Select incident"
                      value={hazardId ?? ''}
                      onChange={(event) => {
                        setSelected(event.target.value);
                        setVersion(null);
                      }}
                    >
                      {shownHazards.map((hazard, i) => (
                        <option key={hazard.id} value={hazard.id}>
                          Incident {i + 1} · {hazard.observed.resourceId} →{' '}
                          {hazard.consumer.resourceId}
                          {hazard.active ? '' : ' · no active impact'}
                        </option>
                      ))}
                    </select>
                  )}
                  {snapshot.hazards.length > 0 && shownHazards.length === 0 && (
                    <span>Current heads are clean. Historical evidence is preserved.</span>
                  )}
                </div>
                <RaceSummary snapshot={snapshot} detail={detail} />
                <Timeline
                  snapshot={trace!}
                  selectEvent={inspectEvent}
                  selectedEventId={selectedEvent?.id ?? null}
                  selectedAgentId={selectedAgent}
                  selectAgent={(id) => setSelectedAgent(id || null)}
                  events={events}
                  agentStates={
                    live && liveRun?.generic
                      ? Object.fromEntries(
                          Object.values(liveRun.agents ?? {}).map((a) => [a.agentId, a.state]),
                        )
                      : undefined
                  }
                  step={step}
                  selectHazard={(id) => {
                    setSelected(id);
                    setVersion(null);
                  }}
                />
                <WorkspaceSplit>
                  <div className="visuals">
                    <CausalGraph
                      hazardId={hazardId}
                      focusVersionIds={
                        selectedEvent?.action === 'GUARD_REJECT'
                          ? rejectedInputs(selectedEvent.id, events).flatMap((input) => [
                              input.observed.id,
                              input.current.id,
                            ])
                          : []
                      }
                      selectedVersionId={selectedVersion}
                      snapshot={snapshot}
                      step={step}
                      inspect={(node) => {
                        inspect(node).catch(report);
                      }}
                    />
                    <section className="replay-panel">
                      <div className="replay-title">
                        <div>
                          <strong>{step ? step.description : 'Trace replay'}</strong>
                          <span>
                            {step
                              ? step.annotation
                              : 'Stored causal events. Replay does not re-execute agents.'}
                          </span>
                        </div>
                        <button
                          className="text-button"
                          onClick={action(async () => {
                            stop();
                            setStep(null);
                            setLive(true);
                            await load();
                          })}
                        >
                          Jump to latest ↗
                        </button>
                      </div>
                      <div className="replay-controls">
                        <button
                          className="icon-button"
                          aria-label="Go to first event"
                          onClick={action(async () => {
                            stop();
                            setLive(false);
                            setStep(null);
                            await load(1);
                          })}
                        >
                          |◀
                        </button>
                        <button
                          className="icon-button play-button"
                          aria-label={playing ? 'Pause trace' : 'Play trace'}
                          onClick={action(async () => {
                            if (playing) {
                              stop();
                              return;
                            }
                            const start =
                              snapshot.currentRuntimeSeq >= latest
                                ? 1
                                : snapshot.currentRuntimeSeq + 1;
                            await play(
                              Array.from({ length: latest - start + 1 }, (_, index) => ({
                                runtimeSeq: start + index,
                                agent: '',
                                action: '',
                                description: `Event ${start + index}`,
                                annotation: 'Stepping through the immutable event log.',
                                highlightNodes: [],
                                highlightEdges: [],
                                openStaleWindow: false,
                                closeStaleWindow: false,
                              })),
                            );
                          })}
                        >
                          {playing ? 'Ⅱ' : '▶'}
                        </button>
                        <button
                          className="icon-button"
                          aria-label="Step forward"
                          onClick={action(async () => {
                            stop();
                            setLive(false);
                            setStep(null);
                            await load(Math.min(latest, snapshot.currentRuntimeSeq + 1));
                          })}
                        >
                          ▶|
                        </button>
                        <input
                          aria-label="Replay sequence"
                          type="range"
                          min={1}
                          max={latest}
                          value={snapshot.currentRuntimeSeq}
                          onChange={(event) => {
                            stop();
                            setLive(false);
                            setStep(null);
                            load(Number(event.target.value)).catch(report);
                          }}
                        />
                        <span className="mono">
                          {snapshot.currentRuntimeSeq} / {latest}
                        </span>
                      </div>
                    </section>
                  </div>
                  <div className="evidence-column">
                    {selectedEvent && selectedEvent.runtimeSeq <= snapshot.currentRuntimeSeq && (
                      <EventDetails
                        event={selectedEvent}
                        snapshot={snapshot}
                        facts={events}
                        close={() => setSelectedEvent(null)}
                      />
                    )}
                    {selectedEvent?.action === 'GUARD_REJECT' &&
                      selectedEvent.runtimeSeq <= snapshot.currentRuntimeSeq && (
                        <GuardValidationPanel event={selectedEvent} events={events} />
                      )}
                    <Inspector
                      hasIncident={!!hazardId}
                      analysisLabel={liveRun ? 'Reassess with Gemini ↗' : undefined}
                      detail={detail}
                      version={
                        version && version.creationSeq <= snapshot.currentRuntimeSeq
                          ? version
                          : null
                      }
                      versionLabels={Object.fromEntries(
                        snapshot.graph.nodes.map((node) => [node.id, node.label]),
                      )}
                      canRepair={live && (liveRun ? liveRun.canRepair : snapshot.canRepair)}
                      busy={
                        busy ||
                        !!(
                          liveRun &&
                          ['repairing', 'assessing', 'running', 'held', 'ready'].includes(
                            liveRun.phase,
                          )
                        )
                      }
                      replay={action(replayRace)}
                      repair={action(async () => {
                        stop();
                        await api(
                          liveRun
                            ? `/live-demo/runs/${runId}/repair`
                            : `/hazards/${hazardId}/repair`,
                          {
                            method: 'POST',
                            ...(liveRun ? { body: JSON.stringify({ hazardId }) } : {}),
                          },
                        );
                        setLive(true);
                        setHistory(true);
                        await load();
                      })}
                      analyze={action(async () => {
                        await api(
                          liveRun
                            ? `/live-demo/runs/${runId}/analyze`
                            : `/hazards/${hazardId}/analyze`,
                          { method: 'POST' },
                        );
                        setLive(true);
                        await load();
                      })}
                      back={() => {
                        versionRequest.current++;
                        setVersion(null);
                        setSelectedVersion(null);
                      }}
                      currentVersion={
                        version ? snapshot.heads[version.resourceId] === version.id : false
                      }
                      producerName={
                        version
                          ? snapshot.timeline.find(
                              (event) =>
                                event.versionId === version.id && event.action !== 'OBSERVE',
                            )?.agentName
                          : undefined
                      }
                    />
                  </div>
                </WorkspaceSplit>
                <ResourceHeads
                  snapshot={trace!}
                  events={events}
                  selectedId={selectedVersion}
                  inspect={(node) => {
                    inspectVersion(node).catch(report);
                  }}
                />
              </>
            )}
          </>
        )}
        <footer>
          <span className="footer-brand">ravel.</span>
          <span>A causal concurrency debugger for coding agents</span>
          <span>MHACKS 2026</span>
        </footer>
      </main>
      <dialog ref={about}>
        <button
          className="icon-button dialog-close"
          aria-label="Close explanation"
          onClick={() => about.current?.close()}
        >
          ×
        </button>
        <h2>
          Stale is a fact.
          <br />
          Impact needs context.
        </h2>
        <p>
          Ravel records what each task attempt observed. A write is stale if those recorded contents
          differ from the current resource heads when it commits.
        </p>
        <p>
          The highlighted window starts at the beginning of the current uninterrupted stale
          interval. Version succession is shown as a dashed line and is excluded from the blast
          radius.
        </p>
        <p>
          <strong>Downstream</strong> means potentially affected through recorded candidate
          provenance. It does not prove incorrectness. Semantic explanations here use a labeled
          local heuristic.
        </p>
        <p>
          The agents are deterministic scripts using the same bound session interface intended for
          future model adapters. No external service is required. Replay only reads recorded facts;
          Repair creates new attempts.
        </p>
        <p>
          Guard validates each write and retries the controlled backend task. It does not roll back
          an entire multi-write task attempt.
        </p>
      </dialog>
    </>
  );
}
