import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/events/event-store.js';
import { Runtime } from '../src/runtime/coordinator.js';
import { project, raceSlice } from '../src/replay/projector.js';
import { prepareDemo, executeDemo, repairDemo, files } from '../src/adapters/demo-agent.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ravel-test-'));
  const store = new EventStore(join(root, 'store'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'input.txt'), 'A');
  const runtime = new Runtime(store, workspace);
  runtime.start({ name: 'Test' });
  const a = runtime.agent('A'), b = runtime.agent('B');
  return { root, store, workspace, runtime, a: runtime.attempt(a, 'Read input'), b: runtime.attempt(b, 'Change input') };
}

test('acceptance: exact three-agent race, versions, active blast radius, and replay', async (t) => {
  const { root, store } = fixture(t);
  const demo = prepareDemo(store, join(root, 'demo'));
  const state = await executeDemo(demo);
  const version = (path, generation) => Object.values(state.versions).find((v) => v.resource_id === path && v.generation === generation);
  const schema17 = version('schema.sql', 17), schema18 = version('schema.sql', 18);
  const types5 = version('api/types.ts', 5), client9 = version('frontend/client.ts', 9);
  assert.equal(state.heads['schema.sql'], schema18.version_id);
  assert.equal(state.hazards.length, 1);
  const [hazard] = state.hazards;
  assert.equal(hazard.observed_version_id, schema17.version_id);
  assert.equal(hazard.first_invalidating_version_id, schema18.version_id);
  assert.equal(hazard.head_at_validation_id, schema18.version_id);
  assert.equal(hazard.consuming_version_id, types5.version_id);
  assert.deepEqual(hazard.blast_radius.active, [types5.version_id, client9.version_id]);
  assert.equal(state.version_states[client9.version_id], 'DOWNSTREAM');
  for (const [v, content] of [[schema17, files.schemaBefore], [schema18, files.schemaAfter], [types5, files.typesStale], [client9, files.clientStale]]) {
    assert.equal(store.getBlob(v.blob_ref).toString(), content);
  }
  const recorded = store.events(demo.runtime.runId);
  assert.deepEqual(recorded.map((e) => e.runtime_seq), Array.from({ length: recorded.length }, (_, i) => i + 1));
  assert.deepEqual(project(recorded), state);
  assert.deepEqual(raceSlice(state, hazard.hazard_id).map((e) => e.kind), ['OBSERVE_RESOURCE', 'WRITE_COMMIT', 'WRITE_COMMIT', 'OBSERVE_RESOURCE', 'WRITE_COMMIT']);
  assert.equal(project(recorded.filter((e) => e.runtime_seq < types5.creation_seq)).hazards.length, 0);
  assert.equal(project(recorded.filter((e) => e.runtime_seq === 1)).run.status, 'running');
  for (const edge of state.edges) assert.ok(state.versions[edge.source_version_id].creation_seq < state.versions[edge.target_version_id].creation_seq);
});

test('a reread replaces the frontier and removes direct staleness', (t) => {
  const { runtime: r, a, b } = fixture(t);
  r.observe(a, 'input.txt'); r.write(b, 'input.txt', 'B');
  const reread = r.observe(a, 'input.txt');
  const output = r.write(a, 'output.txt', 'based on B');
  assert.equal(r.state.hazards.length, 0);
  assert.deepEqual(r.state.edges.filter((e) => e.target_version_id === output.version_id).map((e) => e.source_version_id), [reread.version.version_id]);
});

test('content reverts are clean and no-op writes do not advance a generation', (t) => {
  const { runtime: r, a, b } = fixture(t);
  const initial = r.observe(a, 'input.txt').version;
  const noop = r.write(b, 'input.txt', 'A');
  assert.equal(noop.version_id, initial.version_id);
  assert.equal(r.state.events.at(-1).kind, 'NOOP_WRITE');
  r.write(b, 'input.txt', 'B');
  const reverted = r.write(b, 'input.txt', 'A');
  assert.equal(reverted.generation, initial.generation + 2);
  assert.equal(reverted.content_hash, initial.content_hash);
  r.write(a, 'output.txt', 'based on A');
  assert.equal(r.state.hazards.length, 0);
});

test('records the first invalidator separately from the head at validation', (t) => {
  const { runtime: r, a, b } = fixture(t);
  r.observe(a, 'input.txt');
  const first = r.write(b, 'input.txt', 'B');
  r.write(b, 'input.txt', 'C');
  const head = r.write(b, 'input.txt', 'D');
  r.write(a, 'output.txt', 'from A');
  assert.equal(r.state.hazards[0].first_invalidating_version_id, first.version_id);
  assert.equal(r.state.hazards[0].head_at_validation_id, head.version_id);
});

test('same-resource overwrite validates before changing the head and advances own frontier', (t) => {
  const { runtime: r, a, b } = fixture(t);
  r.observe(a, 'input.txt'); r.write(b, 'input.txt', 'B');
  const own = r.write(a, 'input.txt', 'C');
  assert.equal(r.state.hazards.length, 1);
  assert.equal(r.state.hazards[0].evidence_type, 'SAME_RESOURCE_BASE');
  r.write(a, 'output.txt', 'from C');
  assert.equal(r.state.hazards.length, 1);
  assert.ok(r.projection().active_blast_radius.includes(own.version_id));
});

test('new task attempts do not inherit prior observations', (t) => {
  const { runtime: r, a, b } = fixture(t);
  r.observe(a, 'input.txt'); r.write(b, 'input.txt', 'B'); r.finishAttempt(a);
  const next = r.attempt(r.state.attempts[a].agent_id, 'Unrelated task');
  r.write(next, 'output.txt', 'independent');
  assert.equal(r.state.hazards.length, 0);
  assert.equal(r.state.edges.length, 0);
  assert.throws(() => r.observe(a, 'input.txt'), /not active/);
});

test('repair replaces active heads without rewriting historical hazards or provenance', async (t) => {
  const { root, store } = fixture(t);
  const demo = prepareDemo(store, join(root, 'demo'));
  const before = await executeDemo(demo);
  const after = repairDemo(demo.runtime);
  assert.equal(after.active_hazards.length, 0);
  assert.equal(after.active_blast_radius.length, 0);
  assert.equal(after.hazards.length, 1);
  assert.deepEqual(after.hazards[0].blast_radius.historical, before.hazards[0].blast_radius.historical);
  assert.equal(after.version_states[before.hazards[0].consuming_version_id], 'STALE INPUT');
  assert.equal(after.version_states[after.heads['api/types.ts']], 'CLEAN');
  assert.equal(after.version_states[after.heads['frontend/client.ts']], 'CLEAN');
  assert.deepEqual(demo.runtime.projection(before.runtime_seq), before);
  assert.equal(Object.values(after.attempts).filter((a) => a.attempt_number === 2).length, 2);
  assert.throws(() => repairDemo(demo.runtime), /already been repaired/);
});

test('restart restores frontier, version order, and next event sequence', (t) => {
  const { runtime: r, store, workspace, a, b } = fixture(t);
  r.observe(a, 'input.txt');
  const restarted = new Runtime(store, workspace, r.runId);
  restarted.write(b, 'input.txt', 'B');
  restarted.write(a, 'output.txt', 'A');
  assert.equal(restarted.state.hazards.length, 1);
  assert.equal(restarted.state.runtime_seq, r.state.runtime_seq + 3); // write, initial output snapshot, write
  assert.deepEqual(restarted.projection(), project(store.events(r.runId)));
});

test('deleted resources remain versioned and absence is distinct from empty content', (t) => {
  const { runtime: r, a, b } = fixture(t);
  r.observe(a, 'input.txt');
  const deleted = r.write(b, 'input.txt', null);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.blob_ref, null);
  r.write(a, 'output.txt', 'from deleted input');
  assert.equal(r.state.hazards.length, 1);
  const absent = r.observe(a, 'missing.txt').version;
  const empty = r.write(b, 'missing.txt', '');
  assert.notEqual(absent.content_hash, empty.content_hash);
});

test('normalizes paths, rejects traversal, and detects unmediated writes', (t) => {
  const { runtime: r, workspace, a } = fixture(t);
  r.write(a, './nested\\file.txt', 'hello');
  assert.ok(r.state.heads['nested/file.txt']);
  for (const path of ['../escape', 'C:\\escape', '/absolute', '.git/config', '.ravel/blobs/key']) assert.throws(() => r.observe(a, path), /paths/);
  if (process.platform === 'win32') for (const path of ['.. /escape', '.git /config', 'NUL', 'file.txt.']) assert.throws(() => r.observe(a, path), /paths/);
  r.observe(a, 'input.txt');
  writeFileSync(join(workspace, 'input.txt'), 'unmediated');
  assert.throws(() => r.observe(a, 'input.txt'), /Unmediated/);
  assert.throws(() => r.write(a, 'output.txt', 'bad'), /Unmediated/);
});

test('SQLite rejects mutation of historical events and rolls back failed publication', (t) => {
  const { runtime: r, store, a } = fixture(t);
  r.snapshot('output.txt');
  const before = store.events(r.runId).length;
  assert.throws(() => store.db.exec("UPDATE events SET kind = 'CHANGED'"), /immutable/);
  assert.throws(() => store.db.exec('DELETE FROM events'), /immutable/);
  const write = r.workspace.write.bind(r.workspace);
  r.workspace.write = (path, bytes) => { if (bytes !== null) throw new Error('disk failure'); write(path, bytes); };
  assert.throws(() => r.write(a, 'output.txt', 'value'), /disk failure/);
  assert.equal(store.events(r.runId).length, before);
  assert.equal(r.state.versions[r.state.heads['output.txt']].deleted, true);
});

test('runtime sequencing does not use wall time for causality', (t) => {
  const { runtime: r, a, b } = fixture(t);
  r.observe(a, 'input.txt'); r.write(b, 'input.txt', 'B'); r.write(a, 'output.txt', 'A');
  const events = structuredClone(r.state.events);
  for (const event of events) { event.wall_time = '2000-01-01T00:00:00.000Z'; event.monotonic_time = 0; }
  assert.equal(project(events).hazards.length, 1);
  assert.deepEqual(project(events).edges, r.state.edges);
});

test('resource names that match JavaScript object properties remain normal resources', (t) => {
  const { runtime: r, a, b } = fixture(t);
  r.write(b, '__proto__', 'A');
  r.observe(a, '__proto__');
  r.write(b, '__proto__', 'B');
  r.write(a, 'constructor', 'from A');
  assert.equal(r.state.hazards.length, 1);
  assert.equal(r.state.versions[r.state.heads.constructor].resource_id, 'constructor');
});
