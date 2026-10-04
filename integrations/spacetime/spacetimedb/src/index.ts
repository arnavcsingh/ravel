import { schema, table, t, SenderError } from 'spacetimedb/server';

const summary = () =>
  table(
    { public: true },
    {
      id: t.string().primaryKey(),
      runId: t.string(),
      runtimeSeq: t.u32(),
      summaryJson: t.string(),
    },
  );

// Disposable debugger projection only. SQLite and immutable blobs remain authoritative.
const spacetimedb = schema({
  publisher: table({ public: false }, { id: t.u32().primaryKey(), identity: t.identity() }),
  debuggerRun: table(
    { public: true },
    { runId: t.string().primaryKey(), runtimeSeq: t.u32(), snapshotJson: t.string() },
  ),
  debuggerAgent: summary(),
  timelineEvent: summary(),
  resourceVersion: summary(),
  hazard: summary(),
  blastRadius: summary(),
  semanticAssessment: summary(),
});
export default spacetimedb;

export const init = spacetimedb.init((ctx) => {
  ctx.db.publisher.insert({ id: 0, identity: ctx.sender });
});

export const publishSnapshot = spacetimedb.reducer(
  { runId: t.string(), runtimeSeq: t.u32(), snapshotJson: t.string() },
  (ctx, { runId, runtimeSeq, snapshotJson }) => {
    const owner = ctx.db.publisher.id.find(0);
    if (!owner || !owner.identity.isEqual(ctx.sender)) throw new SenderError('Publisher required');
    if (!runId || runtimeSeq < 1) throw new SenderError('Invalid projection cursor');
    const snapshot = JSON.parse(snapshotJson);
    if (snapshot.run?.id !== runId || snapshot.currentRuntimeSeq !== runtimeSeq) {
      throw new SenderError('Snapshot does not match projection cursor');
    }
    const previous = ctx.db.debuggerRun.runId.find(runId);
    if (previous && previous.runtimeSeq >= runtimeSeq) return;
    type Summary = { id: string; runId: string; runtimeSeq: number; summaryJson: string };
    type Target = {
      id: { find(id: string): Summary | null; update(row: Summary): Summary };
      insert(row: Summary): Summary;
    };
    const upsert = (target: Target, id: string, value: unknown) => {
      const row = { id, runId, runtimeSeq, summaryJson: JSON.stringify(value) };
      if (target.id.find(id)) target.id.update(row);
      else target.insert(row);
    };
    for (const agent of snapshot.agents) upsert(ctx.db.debuggerAgent, agent.id, agent);
    let lastSeq = 0;
    for (const event of snapshot.timeline) {
      if (event.runtimeSeq <= lastSeq || event.runtimeSeq > runtimeSeq)
        throw new SenderError('Unordered timeline');
      lastSeq = event.runtimeSeq;
      upsert(ctx.db.timelineEvent, event.id, event);
    }
    for (const version of snapshot.graph.nodes) upsert(ctx.db.resourceVersion, version.id, version);
    for (const hazard of snapshot.hazards) {
      upsert(ctx.db.hazard, hazard.id, hazard);
      upsert(ctx.db.blastRadius, hazard.id, {
        active: hazard.activeBlastRadius,
        historical: hazard.historicalBlastRadius,
      });
      if (hazard.assessment) upsert(ctx.db.semanticAssessment, hazard.id, hazard.assessment);
    }
    const row = { runId, runtimeSeq, snapshotJson };
    if (previous) ctx.db.debuggerRun.runId.update(row);
    else ctx.db.debuggerRun.insert(row);
  },
);
