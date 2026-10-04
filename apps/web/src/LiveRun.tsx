import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { LiveRunDetails } from './LiveRunDetails';
import { AgentCard as TraceAgentCard } from './AgentCard';
import type { TimelineEvent } from '@ravel/shared';

export type LiveRunStatus = {
  runId: string;
  phase: string;
  scheduler?: string;
  generic?: boolean;
  timelineExtras?: TimelineEvent[];
  agents?: Record<string, LiveAgent>;
  canRepair: boolean;
  error?: string;
  warnings?: string[];
  operationErrors?: { attemptId: string; operation: string; status: number; error: string }[];
  activeAffectedCount?: number;
  hazardCount?: number;
  resultHistory?: Record<string, { attemptId: string; summary: string; committedWrites: number }>;
  results?: Record<string, { attemptId: string; summary: string; committedWrites: number }>;
  attempts?: {
    id: string;
    role: string;
    number: number;
    status: string;
    agentId?: string;
    taskId?: string;
    repairOf?: string | null;
  }[];
  repairs?: {
    status: string;
    error?: string;
    activeAffectedCount?: number;
    attempts?: string[];
    replacements: { resourceId: string; before: string; after: string }[];
  }[];
};
type AgentConfig = { id: string; name: string; task: string };
type LiveAgent = AgentConfig & {
  agentId: string;
  state: string;
  attempt: number;
  attemptId?: string;
  taskId?: string;
  error?: string;
  observed: { path: string; versionId: string; generation: number }[];
  produced?: { path: string; versionId: string; generation: number }[];
  pending?: { path: string; intentId: string } | null;
  activeHazards?: number;
  scheduling?: { paused: boolean; pauseAfter: boolean; hold: boolean };
};
type Health = {
  api: boolean;
  gemini: boolean;
  workspace: boolean;
  inspector: boolean;
  spacetime: { enabled: boolean; available?: boolean };
  prompts: Record<string, string>;
  files: Record<string, string>;
  labFiles: Record<string, string>;
  labAgents: AgentConfig[];
};
export function useLiveRun(runId: string) {
  const [status, setStatus] = useState<LiveRunStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!runId) return;
    let stopped = false;
    const poll = () =>
      api<LiveRunStatus>(`/live-demo/runs/${runId}`)
        .then((value) => {
          if (!stopped) setStatus(value.phase === 'unmanaged' ? null : value);
        })
        .catch(() => {
          if (!stopped)
            setStatus((old) =>
              old
                ? {
                    ...old,
                    error: 'Live controller unavailable; the runtime trace remains inspectable.',
                  }
                : null,
            );
        });
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runId]);
  return status;
}

export function LiveRunPanel({
  status,
  onCreated,
  selectedAgentId,
  historical = false,
  selectAgent,
}: {
  status: LiveRunStatus | null;
  onCreated: (id: string) => Promise<void>;
  selectedAgentId?: string | null;
  historical?: boolean;
  selectAgent?: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, string>>({});
  const [scheduler, setScheduler] = useState('natural');
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState('observe');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    const poll = () =>
      api<Health>('/live-demo/health')
        .then((value) => {
          if (stopped) return;
          setHealth(value);
          setPrompts((old) => (Object.keys(old).length ? old : value.prompts));
          setFiles((old) => (Object.keys(old).length ? old : value.labFiles));
          setAgents((old) => (old.length ? old : value.labAgents));
        })
        .catch(() => {
          if (!stopped) setHealth(null);
        });
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  const running =
    status && ['ready', 'running', 'held', 'repairing', 'assessing'].includes(status.phase);
  async function command(agent: string | null, action: string, task?: string) {
    if (!status) return;
    setBusy(true);
    setError('');
    try {
      await api(`/live-demo/runs/${status.runId}/${agent ? `agents/${agent}/${action}` : action}`, {
        method: 'POST',
        body: JSON.stringify(task ? { task } : {}),
      });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ runId: string }>('/live-demo/runs', {
        method: 'POST',
        body: JSON.stringify(
          scheduler === 'controlled'
            ? { scheduler, mode, prompts, files }
            : { scheduler, mode, agents, files, goal },
        ),
      });
      await onCreated(result.runId);
      dialog.current?.close();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="live-run-panel" aria-label="Live Gemini demo">
      <div className="live-run-heading">
        <div>
          <strong>RAVEL LIVE LAB</strong>
          <p>Give agents tasks. Watch what they observe and publish. Control the interleaving.</p>
        </div>
        <button
          className="button primary"
          disabled={!!running}
          onClick={() => dialog.current?.showModal()}
        >
          New Live Run
        </button>
      </div>
      <div className="live-health" aria-label="Demo health">
        <span>API: {health?.api ? 'ready' : 'controller offline'}</span>
        <span>Gemini: {health?.gemini ? 'configured' : 'not configured'}</span>
        <span>{health?.spacetime.available ? 'SpacetimeDB connected' : 'SSE fallback'}</span>
        <span>Inspector: {health?.inspector ? 'running' : 'optional · separate command'}</span>
        <span>Workspace: {health?.workspace ? 'template ready' : 'unavailable'}</span>
      </div>
      {!health && (
        <p className="muted">
          Start <code>pnpm demo:live</code> to enable live runs.
        </p>
      )}
      {historical && status && (
        <p className="live-warning">
          Current controller state · controls act on the live run. The debugger below shows
          historical replay.
        </p>
      )}
      {status && <LiveRunDetails status={status} />}
      {status?.generic && (
        <details
          key={`${status.runId}:${['ready', 'running'].includes(status.phase)}`}
          open={['ready', 'running'].includes(status.phase)}
        >
          <summary>Live agent controls and current task results</summary>
          {status.generic && (
            <div className="lab-agent-grid">
              {Object.entries(status.agents ?? {}).map(([id, agent]) => (
                <AgentCard
                  key={`${status.runId}:${id}`}
                  agent={agent}
                  interactive={
                    status.scheduler === 'interactive' &&
                    ['ready', 'running'].includes(status.phase)
                  }
                  busy={busy}
                  selected={selectedAgentId === agent.agentId}
                  onSelect={() => selectAgent?.(agent.agentId)}
                  result={
                    status.results?.[id]?.attemptId === agent.attemptId
                      ? status.results?.[id]
                      : undefined
                  }
                  command={(action, task) => void command(id, action, task)}
                />
              ))}
            </div>
          )}
          {status.generic &&
            status.scheduler === 'interactive' &&
            ['ready', 'running'].includes(status.phase) && (
              <div className="lab-controls">
                <button
                  className="button"
                  disabled={
                    busy ||
                    Object.values(status.agents ?? {}).some(
                      (a) => !['queued', 'done', 'failed'].includes(a.state),
                    )
                  }
                  onClick={() => void command(null, 'finish')}
                >
                  Finish run & analyze
                </button>
                <span className="muted">
                  Start agents individually. Finish when your experiment is complete.
                </span>
              </div>
            )}
        </details>
      )}
      <dialog ref={dialog} className="live-run-dialog">
        <button
          className="icon-button dialog-close"
          aria-label="Close live run setup"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
        <h2>New Live Run</h2>
        <p>
          Each start creates a new Run ID and disposable workspace. Previous runs stay available.
        </p>
        <label>
          Goal / run name (optional)
          <input
            className="lab-input"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            maxLength={120}
          />
        </label>
        <label>
          Scheduling
          <select
            value={scheduler}
            onChange={(e) => {
              setScheduler(e.target.value);
              if (health)
                setFiles(e.target.value === 'controlled' ? health.files : health.labFiles);
            }}
          >
            <option value="natural">Natural concurrency</option>
            <option value="interactive">Interactive</option>
            <option value="controlled">Deterministic Race Reproduction</option>
          </select>
        </label>
        <label>
          Validation
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="observe">Observe</option>
            <option value="guard">Guard + retry</option>
          </select>
        </label>
        <p>
          {scheduler === 'natural'
            ? 'Agents start concurrently. A clean run is a valid result.'
            : scheduler === 'interactive'
              ? 'Create a run, then start each agent when you choose. Holds capture real candidate writes; Ravel discovers actual dependencies.'
              : 'Hold the real Backend mutation, run Database, then release Backend and continue Frontend. Scheduling never guarantees a hazard.'}
        </p>
        {scheduler !== 'controlled' && (
          <>
            <div className="lab-presets" aria-label="Task prompt presets">
              <span>Fill tasks:</span>
              {[
                'User ID → UUID',
                'Add account_status',
                'Add organization membership',
                'Rename email field',
                'Add role enum',
                'Feature flag',
                'Custom',
              ].map((preset) => (
                <button
                  type="button"
                  className="button"
                  key={preset}
                  onClick={() => {
                    if (preset === 'Custom') return;
                    setGoal(preset);
                    setAgents(
                      agents.map((agent, i) => ({
                        ...agent,
                        task:
                          i === 0
                            ? `Inspect the repository and implement this change in its source of truth: ${preset}. Choose relevant files. Publish changes through write_resource.`
                            : `Inspect relevant contracts and update your area (${agent.name}) to reflect this change: ${preset}. Choose which files to observe and write. Publish changes through write_resource.`,
                      })),
                    );
                  }}
                >
                  {preset}
                </button>
              ))}
            </div>
            {agents.map((agent, i) => (
              <fieldset className="lab-agent-editor" key={agent.id}>
                <label>
                  Agent name
                  <input
                    className="lab-input"
                    aria-label={`Agent ${i + 1} name`}
                    maxLength={80}
                    value={agent.name}
                    onChange={(e) =>
                      setAgents(
                        agents.map((a) => (a.id === agent.id ? { ...a, name: e.target.value } : a)),
                      )
                    }
                  />
                </label>
                <label>
                  Task
                  <textarea
                    aria-label={`Agent ${i + 1} task`}
                    value={agent.task}
                    onChange={(e) =>
                      setAgents(
                        agents.map((a) => (a.id === agent.id ? { ...a, task: e.target.value } : a)),
                      )
                    }
                  />
                </label>
                <button
                  className="button"
                  disabled={agents.length <= 2}
                  onClick={() => setAgents(agents.filter((a) => a.id !== agent.id))}
                >
                  Remove agent
                </button>
              </fieldset>
            ))}
            <button
              className="button"
              disabled={agents.length >= 6}
              onClick={() =>
                setAgents([
                  ...agents,
                  {
                    id: `agent-${crypto.randomUUID().slice(0, 8)}`,
                    name: `Agent ${agents.length + 1}`,
                    task: 'Inspect relevant files and implement your task. Publish changes through write_resource.',
                  },
                ])
              }
            >
              + Add Agent
            </button>
          </>
        )}
        {scheduler === 'controlled' &&
          Object.entries(prompts).map(([role, prompt]) => (
            <label key={role}>
              {role} Agent
              <textarea
                aria-label={`${role} task`}
                value={prompt}
                onChange={(e) => setPrompts({ ...prompts, [role]: e.target.value })}
              />
            </label>
          ))}
        <details>
          <summary>Edit initial repository</summary>
          {Object.entries(files).map(([path, content]) => (
            <SeedFileEditor
              key={path}
              path={path}
              content={content}
              editable={scheduler !== 'controlled'}
              update={(value) => setFiles({ ...files, [path]: value })}
              remove={() => {
                const next = { ...files };
                delete next[path];
                setFiles(next);
              }}
              rename={(nextPath) => {
                if (nextPath === path) return;
                if (
                  !nextPath ||
                  nextPath.includes('\\') ||
                  nextPath.includes(':') ||
                  nextPath.split('/').some((part) => ['', '.', '..'].includes(part)) ||
                  files[nextPath] !== undefined
                ) {
                  setError('Choose a unique relative repository path.');
                  return;
                }
                const next = { ...files };
                delete next[path];
                next[nextPath] = content;
                setFiles(next);
                setError('');
              }}
            />
          ))}
          {scheduler !== 'controlled' && (
            <button
              className="button"
              onClick={() => {
                const path = `new-file-${Object.keys(files).length}.ts`;
                setFiles({ ...files, [path]: '// Initial file\n' });
              }}
            >
              Add initial file
            </button>
          )}
        </details>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="live-run-heading">
          <button
            className="button"
            onClick={() => {
              if (health) {
                setPrompts(health.prompts);
                setFiles(health.files);
                setScheduler('controlled');
              }
            }}
          >
            Load Sample Scenario
          </button>
          <button
            className="button primary"
            disabled={busy || !health?.gemini}
            onClick={() => void start()}
          >
            {busy
              ? 'Creating…'
              : scheduler === 'interactive'
                ? 'Create Interactive Run'
                : 'Start live run'}
          </button>
        </div>
      </dialog>
      {error && !dialog.current?.open && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function SeedFileEditor({
  path,
  content,
  editable,
  update,
  rename,
  remove,
}: {
  path: string;
  content: string;
  editable: boolean;
  update: (value: string) => void;
  rename: (value: string) => void;
  remove: () => void;
}) {
  const [name, setName] = useState(path);
  return (
    <div className="lab-agent-editor">
      {editable ? (
        <label>
          Resource path
          <input
            className="lab-input"
            aria-label={`${path} path`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => rename(name)}
          />
        </label>
      ) : (
        <strong>{path}</strong>
      )}
      <label>
        Initial content
        <textarea
          aria-label={`${path} initial content`}
          value={content}
          onChange={(e) => update(e.target.value)}
        />
      </label>
      {editable && (
        <button className="button" onClick={remove}>
          Remove file
        </button>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  interactive,
  busy,
  selected,
  command,
  result,
  onSelect,
}: {
  agent: LiveAgent;
  interactive: boolean;
  busy: boolean;
  selected: boolean;
  command: (action: string, task?: string) => void;
  result?: { summary: string; committedWrites: number };
  onSelect: () => void;
}) {
  const [task, setTask] = useState(agent.task);
  const terminal = ['done', 'failed', 'interrupted'].includes(agent.state);
  const latest = agent.observed.at(-1);
  return (
    <article
      className={`lab-agent-card ${selected ? 'selected' : ''} ${agent.state === 'held' ? 'held' : ''}`}
      aria-label={agent.name}
    >
      <TraceAgentCard
        agent={{
          id: agent.agentId,
          name: agent.name,
          state: agent.state,
          attempt: agent.attempt,
          observed: [
            ...new Map(
              agent.observed.map((o) => [
                o.versionId,
                { id: o.versionId, label: `${o.path}@${o.generation}` },
              ]),
            ).values(),
          ],
          pendingMutation: agent.pending?.path,
          output: agent.produced?.length
            ? {
                id: agent.produced.at(-1)!.versionId,
                label: `${agent.produced.at(-1)!.path}@${agent.produced.at(-1)!.generation}`,
              }
            : undefined,
        }}
        selected={selected}
        onSelect={onSelect}
      />
      {!!agent.activeHazards && (
        <p className="live-warning">
          STALE · {agent.activeHazards} active dependency race{agent.activeHazards === 1 ? '' : 's'}
        </p>
      )}
      {interactive && agent.state === 'queued' ? (
        <textarea
          aria-label={`${agent.name} queued task`}
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />
      ) : (
        <p className="lab-task">{agent.task}</p>
      )}
      <p>
        Latest observation: <b>{latest ? `${latest.path}@${latest.generation}` : 'None yet'}</b>
      </p>
      <details>
        <summary>Observed resources ({agent.observed.length})</summary>
        {agent.observed.map((observation, i) => (
          <p className="mono" key={i}>
            {observation.path}@{observation.generation}
          </p>
        ))}
      </details>
      {result && (
        <details>
          <summary>Gemini result · {result.committedWrites} committed writes</summary>
          <p>{result.summary}</p>
        </details>
      )}
      {agent.pending && (
        <p className="live-warning">Pending: {agent.pending.path} candidate · real write intent</p>
      )}
      {agent.scheduling?.hold && <p className="live-warning">Next commit held until release</p>}
      {agent.scheduling?.paused && (
        <p className="muted">Pause requested · takes effect at the next tool boundary</p>
      )}
      {agent.scheduling?.pauseAfter && (
        <p className="muted">Will pause after next file observation</p>
      )}
      {agent.error && <p className="error">{agent.error}</p>}
      {interactive && (
        <div className="lab-controls">
          {agent.state === 'queued' && (
            <button
              className="button primary"
              disabled={busy || !task.trim()}
              onClick={() => command('start', task)}
            >
              Start
            </button>
          )}
          {terminal ? (
            <button className="button" disabled={busy} onClick={() => command('retry')}>
              Retry task
            </button>
          ) : (
            <>
              <button
                className="button"
                disabled={busy}
                onClick={() => command(agent.scheduling?.hold ? 'release' : 'hold')}
              >
                {agent.scheduling?.hold ? 'Release pending commit' : 'Hold next commit'}
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  command(agent.scheduling?.paused || agent.state === 'paused' ? 'resume' : 'pause')
                }
              >
                {agent.scheduling?.paused || agent.state === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => command('pause-after-observation')}
              >
                Pause after next observation
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
