import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DebuggerSnapshotSchema,
  HazardDetailSchema,
  ReplayPlanSchema,
  StreamUpdateSchema,
  type DebuggerSnapshot,
  type GraphNode,
  type HazardDetail,
  type RavelEvent,
  type ReplayStep,
  type Run,
  type Version,
} from '@ravel/shared';
import { api } from './api';
import { Timeline } from './Timeline';
import { CausalGraph } from './CausalGraph';
import { Inspector } from './Inspector';

type DemoStatus = {
  phase: string;
  canRelease: boolean;
  error: string | null;
  workspaceError: string | null;
};
export default function App() {
  const [runs, setRuns] = useState<Run[]>([]),
    [runId, setRunId] = useState('');
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
        api<DemoStatus>(`/runs/${runId}/demo`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const parsed = DebuggerSnapshotSchema.parse(value);
      setSnapshot(parsed);
      setLatest(parsed.latestRuntimeSeq);
      setDemo(status);
      return parsed;
    },
    [runId],
  );
  useEffect(() => {
    loadRuns()
      .then((values) => setRunId(values[0]?.id ?? ''))
      .catch(report);
  }, [loadRuns, report]);
  useEffect(() => {
    stop();
    setLive(true);
    setSnapshot(null);
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
    const stream = new EventSource(`/api/runs/${runId}/stream`);
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    const update = (message: MessageEvent) => {
      try {
        const event = StreamUpdateSchema.parse(JSON.parse(message.data));
        setLatest((old) => Math.max(old, event.runtimeSeq));
        if (live) load().catch(report);
        if (event.kind === 'DEMO_FAILED')
          setError('The demo failed. Check the runtime terminal and start a new run.');
      } catch (failure) {
        report(failure);
      }
    };
    stream.addEventListener('update', update as EventListener);
    return () => stream.close();
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
    if (!eventView || !snapshot) return;
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
      await load(next.runtimeSeq);
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
  async function inspect(node: GraphNode) {
    if (node.hazardIds[0]) {
      setSelected(node.hazardIds[0]);
      setVersion(null);
      if (!snapshot?.hazards.find((h) => h.id === node.hazardIds[0])?.active) setHistory(true);
    } else
      setVersion(await api<Version & { content: string | null }>(`/versions/${node.id}/content`));
  }
  const shownHazards = snapshot?.hazards.filter((h) => history || h.active) ?? [];
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
          <span className="repo-icon">⌘</span>identifier-migration
        </div>
        <div className="nav-label">OBSERVABILITY</div>
        <nav aria-label="Main navigation">
          <button
            className={`nav-item ${!eventView ? 'active' : ''}`}
            onClick={() => setEventView(false)}
            aria-label="Causal debugger"
          >
            <span>⌁</span>Causal debugger
            <span className="nav-count">
              {snapshot?.hazards.filter((h) => h.active).length ?? 0}
            </span>
          </button>
          <button
            className={`nav-item ${eventView ? 'active' : ''}`}
            onClick={() => setEventView(true)}
            aria-label="Event log"
          >
            <span>≡</span>Event log
          </button>
        </nav>
        <div className="sidebar-note">
          <div className="mini-threads">
            <i />
            <i />
            <i />
          </div>
          <strong>Follow the cause.</strong>
          <p>See where shared context drifts, and what follows.</p>
        </div>
        <div className="sidebar-bottom">
          <span className="connection-dot" />
          <span>{connected ? 'Runtime connected' : 'Reconnecting…'}</span>
          <span>v0.3</span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="muted">Workspace</span>
            <span className="slash">/</span>Causal debugger
          </div>
          <button className="text-button" onClick={() => about.current?.showModal()}>
            How to read this trace <span>↗</span>
          </button>
        </header>
        <div className="page-heading">
          <div>
            <div className="eyebrow">SHARED STATE. VISIBLE CONSEQUENCES.</div>
            <h1>
              A race, unraveled<span>.</span>
            </h1>
            <p>Trace an observation from the moment it becomes stale to the work it shapes.</p>
          </div>
          <button
            className="button primary"
            disabled={busy || ['held', 'running', 'ready'].includes(demo?.phase ?? '')}
            onClick={action(newDemo)}
          >
            <span>＋</span>Run live demo
          </button>
        </div>
        <div className="runbar">
          <div className="run-choice">
            <span className="run-icon">◈</span>
            <label htmlFor="run-select">Run</label>
            <select
              id="run-select"
              aria-label="Select recorded run"
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
            >
              {runs.map((run, i) => (
                <option key={run.id} value={run.id}>
                  {run.name} · {String(runs.length - i).padStart(2, '0')}
                </option>
              ))}
            </select>
          </div>
          <div className="run-meta">
            <span className="pill">{snapshot?.run.mode.toUpperCase() ?? 'OBSERVE'} MODE</span>
            <span className="status-label">
              {!live
                ? '◷ REPLAYING'
                : demo?.phase === 'held'
                  ? 'Ⅱ MUTATION HELD'
                  : snapshot?.run.status === 'running'
                    ? '● RUNNING'
                    : '● RECORDED'}
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
          <span>Scripted agents · no API keys</span>
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
          <div className="empty-state">Loading the recorded execution…</div>
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
                <strong className="danger">
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
                        <tr key={event.id}>
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
                          {hazard.active ? '' : ' · repaired'}
                        </option>
                      ))}
                    </select>
                  )}
                  {snapshot.hazards.length > 0 && shownHazards.length === 0 && (
                    <span>Current heads are clean. Historical evidence is preserved.</span>
                  )}
                </div>
                <div className="debugger-grid">
                  <div className="visuals">
                    <Timeline
                      snapshot={snapshot}
                      step={step}
                      selectHazard={(id) => {
                        setSelected(id);
                        setVersion(null);
                      }}
                    />
                    <CausalGraph
                      snapshot={snapshot}
                      step={step}
                      inspect={(node) => {
                        inspect(node).catch(report);
                      }}
                    />
                    <section className="replay-panel">
                      <div className="replay-title">
                        <span className="replay-symbol">↶</span>
                        <div>
                          <strong>{step ? step.description : 'Replay the execution'}</strong>
                          <span>
                            {step ? step.annotation : 'Recorded facts. One event at a time.'}
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
                  <Inspector
                    detail={detail}
                    version={version}
                    versionLabels={Object.fromEntries(
                      snapshot.graph.nodes.map((node) => [node.id, node.label]),
                    )}
                    canRepair={snapshot.canRepair}
                    busy={busy}
                    replay={action(replayRace)}
                    repair={action(async () => {
                      stop();
                      await api(`/hazards/${hazardId}/repair`, { method: 'POST' });
                      setLive(true);
                      setHistory(true);
                      await load();
                    })}
                    analyze={action(async () => {
                      await api(`/hazards/${hazardId}/analyze`, { method: 'POST' });
                      setLive(true);
                      await load();
                    })}
                    back={() => setVersion(null)}
                  />
                </div>
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
        <div className="eyebrow">A NOTE ON EVIDENCE</div>
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
