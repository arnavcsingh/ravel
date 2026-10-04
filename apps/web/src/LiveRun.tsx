import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { LiveRunDetails } from './LiveRunDetails';

export type LiveRunStatus = {
  runId: string;
  phase: string;
  scheduler?: string;
  canRepair: boolean;
  error?: string;
  warnings?: string[];
  activeAffectedCount?: number;
  hazardCount?: number;
  results?: Record<string, { attemptId: string; summary: string; committedWrites: number }>;
  attempts?: { id: string; role: string; number: number; status: string }[];
  repairs?: {
    status: string;
    replacements: { resourceId: string; before: string; after: string }[];
  }[];
};
type Health = {
  api: boolean;
  gemini: boolean;
  workspace: boolean;
  inspector: boolean;
  spacetime: { enabled: boolean; available?: boolean };
  prompts: Record<string, string>;
  files: Record<string, string>;
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
}: {
  status: LiveRunStatus | null;
  onCreated: (id: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, string>>({});
  const [scheduler, setScheduler] = useState('controlled');
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
          setFiles((old) => (Object.keys(old).length ? old : value.files));
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
  const running = status && ['running', 'held', 'repairing', 'assessing'].includes(status.phase);
  async function start() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ runId: string }>('/live-demo/runs', {
        method: 'POST',
        body: JSON.stringify({ scheduler, mode, prompts, files }),
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
          <strong>LIVE GEMINI</strong>
          <p>Three coding agents. A fresh workspace. Actual runtime events.</p>
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
      {status && <LiveRunDetails status={status} />}
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
          Scheduling
          <select value={scheduler} onChange={(e) => setScheduler(e.target.value)}>
            <option value="controlled">Controlled Interleaving</option>
            <option value="natural">Natural concurrency</option>
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
            : 'Hold the real Backend mutation, run Database, then release Backend and continue Frontend. Scheduling never guarantees a hazard.'}
        </p>
        {Object.entries(prompts).map(([role, prompt]) => (
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
            <label key={path}>
              {path}
              <textarea
                aria-label={`${path} initial content`}
                value={content}
                onChange={(e) => setFiles({ ...files, [path]: e.target.value })}
              />
            </label>
          ))}
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
              }
            }}
          >
            Restore template
          </button>
          <button
            className="button primary"
            disabled={busy || !health?.gemini}
            onClick={() => void start()}
          >
            {busy ? 'Creating…' : 'Start live run'}
          </button>
        </div>
      </dialog>
    </section>
  );
}
