import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunCoordinator,
  RavelStore,
  ControlledScheduler,
  Deferred,
  replay,
  blastRadius,
  assertDerivation,
  type RavelSession,
} from '../packages/core/src';
import { prepareDemo, repairDemo, fixture as demoFiles } from '../demo/src';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanup.splice(0).reverse()) clean();
});
async function fixture(
  options: ConstructorParameters<typeof RunCoordinator>[3] = {},
  mode: 'observe' | 'guard' = 'observe',
) {
  const root = mkdtempSync(join(tmpdir(), 'ravel-v2-'));
  const store = new RavelStore(join(root, 'store'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'input'), 'A');
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const run = new RunCoordinator(store, workspace, undefined, options);
  await run.start('Test', null, mode);
  await run.importWorkspace();
  const a = await run.createAttempt(await run.createAgent('A'), 'Task A'),
    b = await run.createAttempt(await run.createAgent('B'), 'Task B');
  return { root, store, workspace, run, a, b };
}
const output = async (session: RavelSession, path: string, content: string) =>
  (await session.writeResource(path, content)).version!;

describe('deterministic acceptance', () => {
  it('records one hazard, exact version provenance, historical blobs and an acyclic replay', async () => {
    const { store, root } = await fixture();
    const demo = await prepareDemo(store, join(root, 'demo'));
    await demo.execute();
    const s = demo.coordinator.state;
    expect(s.hazards).toHaveLength(1);
    const h = s.hazards[0],
      types = s.versions[s.heads['api/types.ts']],
      client = s.versions[s.heads['frontend/client.ts']];
    expect([
      s.versions[s.heads['schema.sql']].generation,
      types.generation,
      client.generation,
    ]).toEqual([18, 5, 9]);
    expect(s.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceVersionId: h.observedVersionId,
          targetVersionId: types.id,
        }),
        expect.objectContaining({ sourceVersionId: types.id, targetVersionId: client.id }),
      ]),
    );
    expect(blastRadius(types.id, s.edges, s.heads).active).toEqual([types.id, client.id]);
    expect(store.content(s.versions[h.observedVersionId])).toEqual(demoFiles.schema);
    expect(store.content(s.versions[h.staleSinceVersionId])).toEqual(demoFiles.migrated);
    expect(store.content(types)).toContain('email: string');
    expect(store.content(client)).toContain('toFixed');
    for (const edge of s.edges) expect(() => assertDerivation(edge, s.versions)).not.toThrow();
    expect(replay(store.events(s.run!.id))).toEqual(s);
    expect(replay(store.events(s.run!.id, 1)).run!.status).toBe('running');
    expect(s.events.map((e) => e.runtimeSeq)).toEqual(s.events.map((_, i) => i + 1));
    const second = await prepareDemo(store, join(root, 'demo'));
    await second.execute();
    expect(second.coordinator.state.events.map((e) => [e.runtimeSeq, e.kind])).toEqual(
      s.events.map((e) => [e.runtimeSeq, e.kind]),
    );
  });
  it('repairs current heads while preserving old hazards and event contents', async () => {
    const { store, root } = await fixture();
    const demo = await prepareDemo(store, join(root, 'demo'));
    await demo.execute();
    const before = demo.coordinator.state;
    await repairDemo(demo.coordinator);
    const after = demo.coordinator.state;
    expect(
      blastRadius(before.hazards[0].consumerVersionId, after.edges, after.heads).active,
    ).toEqual([]);
    expect(after.hazards).toEqual(before.hazards);
    expect(replay(store.events(after.run!.id, before.seq))).toEqual(before);
    expect(after.versions[after.heads['api/types.ts']].generation).toBe(6);
    expect(after.versions[after.heads['frontend/client.ts']].generation).toBe(10);
  });
});

describe('content and observation semantics', () => {
  it('no-op writes preserve generations, but own writes advance the frontier', async () => {
    const { run, a } = await fixture();
    const initial = await a.observeResource('input');
    const noop = await a.writeResource('input', 'A');
    expect(noop.noop).toBe(true);
    expect(noop.version!.id).toBe(initial.version.id);
    const own = await output(a, 'input', 'B');
    await a.writeResource('output', 'B');
    expect(run.state.hazards).toHaveLength(0);
    expect(run.state.edges.at(-1)!.sourceVersionId).toBe(own.id);
  });
  it('reobserving refreshes a frontier; a new attempt starts with no inherited inputs', async () => {
    const { run, a, b } = await fixture();
    await a.observeResource('input');
    await b.writeResource('input', 'B');
    await a.observeResource('input');
    await a.writeResource('output', 'B');
    expect(run.state.hazards).toHaveLength(0);
    await a.complete();
    const next = await run.createAttempt(a.identity.agentId, 'New task');
    await b.writeResource('input', 'C');
    await next.writeResource('other', 'unrelated');
    expect(run.state.hazards).toHaveLength(0);
  });
  it('content reverts are valid; change/revert/change begins a new continuous stale interval', async () => {
    const { run, a, b } = await fixture();
    await a.observeResource('input');
    await b.writeResource('input', 'B');
    await b.writeResource('input', 'A');
    await a.writeResource('output', 'A');
    expect(run.state.hazards).toHaveLength(0);
    const currentStart = await output(b, 'input', 'C');
    const validation = await output(b, 'input', 'D');
    await a.writeResource('output', 'still A');
    expect(run.state.hazards[0].staleSinceVersionId).toBe(currentStart.id);
    expect(run.state.hazards[0].validationHeadVersionId).toBe(validation.id);
  });
  it('detects independent hazards for multiple inputs and validates same-resource base before commit', async () => {
    const { run, a, b } = await fixture();
    await a.observeResource('input');
    await a.observeResource('missing');
    await b.writeResource('input', 'B');
    await b.writeResource('missing', 'created');
    await a.writeResource('input', 'stale override');
    expect(run.state.hazards).toHaveLength(2);
    expect(run.state.hazards.map((h) => h.evidence)).toContain('SAME_RESOURCE_BASE');
  });
  it('distinguishes tombstones, empty contents and deleted resources', async () => {
    const { run, a, b } = await fixture();
    const absent = await a.observeResource('absent');
    expect(absent.content).toBeNull();
    const empty = await output(b, 'absent', '');
    expect(empty.contentHash).not.toBeNull();
    await a.writeResource('output', 'based on absence');
    expect(run.state.hazards).toHaveLength(1);
    const deleted = await b.writeResource('absent', null);
    expect(deleted.version!.tombstone).toBe(true);
  });
  it('search results become observations, while listing and command reads do not', async () => {
    const { run, a } = await fixture({
      commands: { inspect: (files) => ({ output: files.input!, exitCode: 0 }) },
    });
    await a.listResources();
    await a.runCommand('inspect');
    expect(Object.keys(run.state.attempts[a.attemptId].frontier)).toEqual([]);
    const results = await a.searchRepository('A');
    expect(results).toHaveLength(1);
    expect(Object.keys(run.state.attempts[a.attemptId].frontier)).toEqual(['input']);
    await expect(a.runCommand('rm -rf .')).rejects.toThrow('Arbitrary shell');
  });
  it('patches use the exact observed base and still detect stale overwrites', async () => {
    const { run, a, b } = await fixture();
    const base = await a.observeResource('input');
    await b.writeResource('input', 'B');
    await a.applyPatch(
      'input',
      base.version.id,
      '--- input\n+++ input\n@@ -1,1 +1,1 @@\n-A\n\\ No newline at end of file\n+C\n\\ No newline at end of file\n',
    );
    expect(run.state.hazards).toHaveLength(1);
    expect(run.state.hazards[0].evidence).toBe('SAME_RESOURCE_BASE');
    await expect(a.applyPatch('other', base.version.id, '')).rejects.toThrow('base');
  });
});

describe('atomic concurrency and durable state', () => {
  it('keeps a retired stale root active while a downstream head still depends on it', async () => {
    const { run, a, b } = await fixture();
    await a.observeResource('input');
    await b.writeResource('input', 'B');
    const stale = await output(a, 'output', 'A');
    await a.complete();
    const consumer = await run.createAttempt(await run.createAgent('Consumer'), 'Consume output');
    await consumer.observeResource('output');
    const child = await output(consumer, 'child', 'A');
    const repair = await run.createAttempt(a.identity.agentId, 'Repair');
    await repair.observeResource('input');
    const clean = await output(repair, 'output', 'B');
    const radius = blastRadius(stale.id, run.state.edges, run.state.heads);
    expect(radius.active).toEqual([child.id]);
    expect(radius.historical).not.toContain(clean.id);
  });
  it('returned observations and intents cannot rewrite captured runtime state', async () => {
    const { run, a, b } = await fixture();
    const observed = await a.observeResource('input');
    observed.version.contentHash = 'spoof';
    const intent = await run.prepareWrite(a.attemptId, 'output', 'A');
    intent.observationIds.length = 0;
    intent.candidateHash = null;
    await b.writeResource('input', 'B');
    const result = await run.commitWrite(intent.id);
    expect(result.version!.tombstone).toBe(false);
    expect(run.state.hazards).toHaveLength(1);
  });
  it('rejects overlapping mutations in one attempt without blocking other agents', async () => {
    const { run, a, b } = await fixture();
    const intent = await run.prepareWrite(a.attemptId, 'output', 'A');
    await expect(run.prepareWrite(a.attemptId, 'second', 'B')).rejects.toThrow('pending');
    await b.writeResource('input', 'B');
    await run.commitWrite(intent.id);
    await a.complete();
  });
  it('holds a captured mutation outside the lock, then validates and commits atomically', async () => {
    const scheduler = new ControlledScheduler();
    const { run, a, b } = await fixture({ gate: scheduler });
    run.on('event', (e) => scheduler.notify(e));
    await a.observeResource('input');
    scheduler.holdMutation(a.attemptId);
    const pending = a.writeResource('output', 'A');
    await scheduler.waitForEvent((e) => e.kind === 'WRITE_INTENT');
    await b.writeResource('input', 'B');
    // A fresh read AFTER generation of candidate work must not rewrite its captured inputs.
    await a.observeResource('input');
    scheduler.releaseMutation(a.attemptId);
    await pending;
    expect(run.state.hazards).toHaveLength(1);
    expect(run.state.events.map((e) => e.runtimeSeq)).toEqual(
      run.state.events.map((_, i) => i + 1),
    );
  });
  it('serializes concurrent writes with unique generations and sequence numbers', async () => {
    const { run, a, b } = await fixture();
    await Promise.all([a.observeResource('input'), b.observeResource('input')]);
    await Promise.all([a.writeResource('input', 'first'), b.writeResource('input', 'second')]);
    expect(
      Object.values(run.state.versions)
        .filter((v) => v.resourceId === 'input')
        .map((v) => v.generation),
    ).toEqual([1, 2, 3]);
    expect(run.state.hazards).toHaveLength(1);
  });
  it('does not hold the coordinator lock during read-only commands', async () => {
    const entered = new Deferred(),
      release = new Deferred();
    const { a, b } = await fixture({
      commands: {
        slow: async () => {
          entered.resolve();
          await release.promise;
          return { output: 'done', exitCode: 0 };
        },
      },
    });
    const command = a.runCommand('slow');
    await entered.promise;
    await b.writeResource('input', 'B');
    await expect(a.complete()).rejects.toThrow('pending');
    release.resolve();
    expect((await command).output).toBe('done');
  });
  it('keeps DB state authoritative if materialization fails and reconstructs on recovery', async () => {
    const { run, store, workspace, a } = await fixture();
    const originalWrite = run.workspace.write.bind(run.workspace);
    run.workspace.write = () => {
      throw new Error('disk busy');
    };
    const result = await a.writeResource('input', 'B');
    expect(result.committed).toBe(true);
    expect(result.materialized).toBe(false);
    expect(readFileSync(join(workspace, 'input'), 'utf8')).toBe('A');
    expect((await a.observeResource('input')).content).toBe('B');
    run.workspace.write = originalWrite;
    await run.reconstructWorkspace();
    expect(readFileSync(join(workspace, 'input'), 'utf8')).toBe('B');
    const recovered = new RunCoordinator(store, workspace, run.runId);
    expect(recovered.state).toEqual(run.state);
  });
  it('rolls back event, versions, edges, hazards and frontier as one SQLite transaction', async () => {
    const { run, store, a, b } = await fixture();
    await a.observeResource('input');
    await b.writeResource('input', 'B');
    const intent = await run.prepareWrite(a.attemptId, 'output', 'A');
    const before = run.state;
    store.db.exec(
      "CREATE TRIGGER fail_hazard BEFORE INSERT ON hazards BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    );
    await expect(run.commitWrite(intent.id)).rejects.toThrow('injected failure');
    expect(run.state).toEqual(before);
    expect(replay(store.events(run.runId))).toEqual(before);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM hazards').get()).toEqual({ count: 0 });
    store.db.exec('DROP TRIGGER fail_hazard');
    await run.commitWrite(intent.id);
    expect(run.state.hazards).toHaveLength(1);
  });
  it('rejects event mutation, unknown versions, cycles, cross-run attempts and path escapes', async () => {
    const { run, store, a } = await fixture();
    const observed = await a.observeResource('input');
    const written = await output(a, 'output', 'value');
    const edge = run.state.edges[0];
    expect(() =>
      assertDerivation(
        { ...edge, sourceVersionId: written.id, targetVersionId: observed.version.id },
        run.state.versions,
      ),
    ).toThrow('cycle');
    expect(() =>
      assertDerivation({ ...edge, sourceVersionId: 'missing' }, run.state.versions),
    ).toThrow('unknown');
    expect(() => store.db.exec("UPDATE events SET kind='invalid' ")).toThrow('immutable');
    await expect(run.observe('foreign-attempt', 'input')).rejects.toThrow('not active');
    await expect(a.observeResource('../escape')).rejects.toThrow('path');
    await a.writeResource('__proto__', 'ordinary');
    await a.writeResource('constructor', 'ordinary');
    expect(await a.listResources()).toContain('__proto__');
  });
  it('strict guard rejects before publication and the controlled demo retries from fresh state', async () => {
    const { store, root } = await fixture();
    const demo = await prepareDemo(store, join(root, 'guard'), { mode: 'guard' });
    await demo.execute();
    const state = demo.coordinator.state;
    expect(state.hazards).toHaveLength(0);
    expect(Object.values(state.attempts).some((a) => a.status === 'invalidated')).toBe(true);
    expect(Object.values(state.attempts).some((a) => a.number === 2)).toBe(true);
    expect(store.content(state.versions[state.heads['api/types.ts']])).toContain('id: string');
  });
});
