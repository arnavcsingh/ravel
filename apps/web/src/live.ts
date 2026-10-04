import { DebuggerSnapshotSchema, StreamUpdateSchema, type DebuggerSnapshot } from '@ravel/shared';
import { api } from './api';

export type LiveMode = 'sse' | 'spacetime';
type Callbacks = {
  update: (seq: number, kind: string) => void;
  snapshot: (value: DebuggerSnapshot) => void;
  status: (connected: boolean, mode: LiveMode) => void;
  error: (error: unknown) => void;
};
type LiveConfig = { enabled: boolean; available: boolean; uri?: string; database?: string };

// Keep SSE subscribed while using the cloud read model, so fallback never loses
// a commit. A lagging cloud packet cannot replace a newer local cursor.
export function connectLive(runId: string, callbacks: Callbacks) {
  let stopped = false,
    sseConnected = false,
    cloudReady = false,
    localSeq = 0,
    cloudSeq = 0;
  let disconnect: (() => void) | undefined;
  let lag: ReturnType<typeof setTimeout> | undefined;
  let pendingKind = 'UPDATE';
  const stream = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
  const status = () =>
    callbacks.status(sseConnected || cloudReady, cloudReady ? 'spacetime' : 'sse');
  const fallback = () => {
    if (stopped) return;
    cloudReady = false;
    if (lag) clearTimeout(lag);
    lag = undefined;
    status();
    callbacks.update(localSeq, pendingKind);
  };
  stream.onopen = () => {
    sseConnected = true;
    status();
  };
  stream.onerror = () => {
    sseConnected = false;
    status();
  };
  stream.addEventListener('update', (message) => {
    try {
      const event = StreamUpdateSchema.parse(JSON.parse((message as MessageEvent).data));
      if (event.runId !== runId || event.runtimeSeq < localSeq) return;
      localSeq = event.runtimeSeq;
      pendingKind = event.kind;
      if (!cloudReady) callbacks.update(event.runtimeSeq, event.kind);
      else if (localSeq > cloudSeq && !lag) lag = setTimeout(fallback, 2500);
    } catch (error) {
      callbacks.error(error);
    }
  });
  async function start() {
    try {
      const config = await api<LiveConfig>('/live');
      if (stopped || !config.enabled || !config.uri || !config.database) return;
      const { DbConnection, tables } = await import('./spacetime_bindings');
      if (stopped) return;
      const accept = (row: { runId: string; runtimeSeq: number; snapshotJson: string }) => {
        if (
          stopped ||
          row.runId !== runId ||
          row.runtimeSeq < localSeq ||
          row.runtimeSeq < cloudSeq
        )
          return;
        try {
          const value = DebuggerSnapshotSchema.parse(JSON.parse(row.snapshotJson));
          if (value.run.id !== runId || value.currentRuntimeSeq !== row.runtimeSeq)
            throw new Error('Invalid projection cursor');
          cloudSeq = row.runtimeSeq;
          cloudReady = true;
          if (lag) clearTimeout(lag);
          lag = undefined;
          callbacks.snapshot(value);
          status();
        } catch {
          fallback();
        }
      };
      const connection = DbConnection.builder()
        .withUri(config.uri)
        .withDatabaseName(config.database)
        .onConnect((conn) => {
          conn.db.debuggerRun.onInsert((_ctx, row) => accept(row));
          conn.db.debuggerRun.onUpdate((_ctx, _old, row) => accept(row));
          conn
            .subscriptionBuilder()
            .onApplied(() => {
              const row = conn.db.debuggerRun.runId.find(runId);
              if (row) accept(row);
            })
            .onError(fallback)
            .subscribe([tables.debuggerRun.where((row) => row.runId.eq(runId))]);
        })
        .onConnectError(fallback)
        .onDisconnect(fallback)
        .build();
      disconnect = () => connection.disconnect();
    } catch {
      fallback();
    }
  }
  void start();
  // Detect publisher outages even when the WebSocket itself stays connected.
  const health = setInterval(() => {
    api<LiveConfig>('/live')
      .then((config) => {
        if (cloudReady && (!config.enabled || !config.available)) fallback();
      })
      .catch(() => {
        if (cloudReady) fallback();
      });
  }, 3000);
  return () => {
    stopped = true;
    clearInterval(health);
    if (lag) clearTimeout(lag);
    stream.close();
    disconnect?.();
  };
}
