import { schema, table, t } from 'spacetimedb/server';

// Disposable debugger projection only. SQLite and immutable blobs remain authoritative.
const spacetimedb = schema({
  publisher: table({ public: false }, { id: t.u32().primaryKey(), identity: t.identity() }),
  debuggerRun: table(
    { public: true },
    { runId: t.string().primaryKey(), runtimeSeq: t.u32(), snapshotJson: t.string() },
  ),
});
export default spacetimedb;

export const init = spacetimedb.init((ctx) => {
  ctx.db.publisher.insert({ id: 0, identity: ctx.sender });
});

export const publishSnapshot = spacetimedb.reducer(
  { runId: t.string(), runtimeSeq: t.u32(), snapshotJson: t.string() },
  (ctx, { runId, runtimeSeq, snapshotJson }) => {
    const owner = ctx.db.publisher.id.find(0);
    if (!owner || !owner.identity.isEqual(ctx.sender)) throw new Error('Publisher required');
    if (!runId || runtimeSeq < 1) throw new Error('Invalid projection cursor');
    const snapshot = JSON.parse(snapshotJson);
    if (snapshot.run?.id !== runId || snapshot.currentRuntimeSeq !== runtimeSeq) {
      throw new Error('Snapshot does not match projection cursor');
    }
    const previous = ctx.db.debuggerRun.runId.find(runId);
    if (previous && previous.runtimeSeq >= runtimeSeq) return;
    const row = { runId, runtimeSeq, snapshotJson };
    if (previous) ctx.db.debuggerRun.runId.update(row);
    else ctx.db.debuggerRun.insert(row);
  },
);
