import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectLive } from '../apps/web/src/live';

const harness = vi.hoisted(() => ({
  config: { enabled: false, available: true, uri: 'https://cloud.invalid', database: 'ravel-test' },
  insert: undefined as undefined | ((ctx: unknown, row: unknown) => void),
  update: undefined as undefined | ((ctx: unknown, old: unknown, row: unknown) => void),
  failure: undefined as undefined | (() => void),
  disconnect: vi.fn(),
}));
vi.mock('../apps/web/src/api', () => ({ api: vi.fn(async () => harness.config) }));
vi.mock('../apps/web/src/spacetime_bindings', () => {
  const connection = {
    db: {
      debuggerRun: {
        onInsert: (fn: typeof harness.insert) => {
          harness.insert = fn;
        },
        onUpdate: (fn: typeof harness.update) => {
          harness.update = fn;
        },
        runId: { find: () => null },
      },
    },
    subscriptionBuilder: () => {
      const builder = { onApplied: () => builder, onError: () => builder, subscribe: vi.fn() };
      return builder;
    },
    disconnect: harness.disconnect,
  };
  return {
    tables: { debuggerRun: { where: () => 'filtered' } },
    DbConnection: {
      builder: () => {
        let connected: (conn: typeof connection) => void;
        const builder = {
          withUri: () => builder,
          withDatabaseName: () => builder,
          onConnect: (fn: typeof connected) => {
            connected = fn;
            return builder;
          },
          onConnectError: (fn: () => void) => {
            harness.failure = fn;
            return builder;
          },
          onDisconnect: () => builder,
          build: () => {
            connected(connection);
            return connection;
          },
        };
        return builder;
      },
    },
  };
});

class FakeStream {
  static latest: FakeStream;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listener?: (value: unknown) => void;
  close = vi.fn();
  constructor() {
    FakeStream.latest = this;
  }
  addEventListener(_event: string, listener: (value: unknown) => void) {
    this.listener = listener;
  }
  emit(runtimeSeq: number) {
    this.listener?.({ data: JSON.stringify({ runId, runtimeSeq, kind: 'WRITE_RESOURCE' }) });
  }
}
const snapshot = JSON.parse(readFileSync('runtime/testdata/observe.json', 'utf8')).snapshots.at(-1);
const runId = snapshot.run.id;
let close: (() => void) | undefined;
const callbacks = () => ({ update: vi.fn(), snapshot: vi.fn(), status: vi.fn(), error: vi.fn() });
const row = (seq = snapshot.currentRuntimeSeq) => ({
  runId,
  runtimeSeq: seq,
  snapshotJson: JSON.stringify({ ...snapshot, currentRuntimeSeq: seq, latestRuntimeSeq: seq }),
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeStream);
  harness.config.enabled = false;
  harness.insert = undefined;
  harness.failure = undefined;
});
afterEach(() => {
  close?.();
  close = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('works entirely through SSE when SpacetimeDB is disabled', async () => {
  const cb = callbacks();
  close = connectLive(runId, cb);
  await vi.dynamicImportSettled();
  FakeStream.latest.onopen?.();
  FakeStream.latest.emit(30);
  expect(cb.status).toHaveBeenLastCalledWith(true, 'sse');
  expect(cb.update).toHaveBeenLastCalledWith(30, 'WRITE_RESOURCE');
  expect(harness.insert).toBeUndefined();
});
it('consumes real subscription snapshots and rejects regressing cursors', async () => {
  harness.config.enabled = true;
  const cb = callbacks();
  close = connectLive(runId, cb);
  await vi.dynamicImportSettled();
  FakeStream.latest.emit(27);
  harness.insert?.({}, row(27));
  expect(cb.snapshot).toHaveBeenCalledTimes(1);
  expect(cb.status).toHaveBeenLastCalledWith(true, 'spacetime');
  harness.update?.({}, row(), row(26));
  expect(cb.snapshot).toHaveBeenCalledTimes(1);
  close();
  close = undefined;
  expect(FakeStream.latest.close).toHaveBeenCalled();
  expect(harness.disconnect).toHaveBeenCalled();
});
it('falls back to SSE after cloud lag without losing the latest cursor', async () => {
  harness.config.enabled = true;
  const cb = callbacks();
  close = connectLive(runId, cb);
  await vi.dynamicImportSettled();
  FakeStream.latest.onopen?.();
  harness.insert?.({}, row(27));
  FakeStream.latest.emit(28);
  await vi.advanceTimersByTimeAsync(2501);
  expect(cb.status).toHaveBeenLastCalledWith(true, 'sse');
  expect(cb.update).toHaveBeenLastCalledWith(28, 'WRITE_RESOURCE');
});
it('keeps SSE available after a failed connection or malformed cloud packet', async () => {
  harness.config.enabled = true;
  const cb = callbacks();
  close = connectLive(runId, cb);
  await vi.dynamicImportSettled();
  FakeStream.latest.onopen?.();
  FakeStream.latest.emit(27);
  harness.insert?.({}, { ...row(), snapshotJson: '{}' });
  harness.failure?.();
  expect(cb.snapshot).not.toHaveBeenCalled();
  expect(cb.status).toHaveBeenLastCalledWith(true, 'sse');
  expect(cb.update).toHaveBeenLastCalledWith(27, 'WRITE_RESOURCE');
});
