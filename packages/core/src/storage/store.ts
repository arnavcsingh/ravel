import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventSchema, type RavelEvent, type Run } from '@ravel/shared';
import type { RunState } from '../domain/state';
import { hash, stableId } from '../domain/identity';
import { migrations } from './migrations';

export class RavelStore {
  readonly db: Database.Database;
  readonly blobs: string;
  constructor(readonly directory: string) {
    this.blobs = join(directory, 'blobs');
    mkdirSync(this.blobs, { recursive: true });
    this.db = new Database(join(directory, 'ravel.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    for (const migration of migrations)
      if (
        !this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version)
      )
        this.db.transaction(() => {
          this.db.exec(migration.sql);
          this.db.prepare('INSERT INTO schema_migrations VALUES (?)').run(migration.version);
        })();
  }
  putBlob(bytes: string | Uint8Array): string {
    const key = hash(bytes);
    try {
      writeFileSync(join(this.blobs, key), bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      this.getBlob(key);
    }
    return key;
  }
  getBlob(key: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid blob reference.');
    const bytes = readFileSync(join(this.blobs, key));
    if (hash(bytes) !== key) throw new Error('Blob integrity failure.');
    return bytes;
  }
  content(version: { blobRef: string | null }): string | null {
    return version.blobRef ? this.getBlob(version.blobRef).toString('utf8') : null;
  }
  events(runId: string, through = Number.MAX_SAFE_INTEGER): RavelEvent[] {
    return (
      this.db
        .prepare(
          'SELECT body FROM events WHERE run_id = ? AND runtime_seq <= ? ORDER BY runtime_seq',
        )
        .all(runId, through) as { body: string }[]
    ).map((row) => EventSchema.parse(JSON.parse(row.body)));
  }
  runs(): Run[] {
    return (
      this.db.prepare('SELECT body FROM runs ORDER BY rowid DESC').all() as { body: string }[]
    ).map((row) => JSON.parse(row.body) as Run);
  }
  runForEntity(table: 'hazards' | 'resource_versions', entityId: string): string | null {
    return (
      (
        this.db.prepare(`SELECT run_id FROM ${table} WHERE id = ?`).get(entityId) as
          { run_id: string } | undefined
      )?.run_id ?? null
    );
  }

  /** The factual event and all logical projections commit together. No filesystem writes here. */
  commit(event: RavelEvent, state: RunState): void {
    this.db.transaction(() => {
      const run = state.run!;
      this.db
        .prepare('INSERT INTO runs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
        .run(run.id, JSON.stringify(run));
      this.db
        .prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)')
        .run(event.id, run.id, event.runtimeSeq, event.kind, JSON.stringify(event));
      for (const [table, values] of [
        ['agents', state.agents],
        ['tasks', state.tasks],
        ['task_attempts', state.attempts],
      ] as const) {
        const insert = this.db.prepare(
          `INSERT INTO ${table} VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`,
        );
        for (const value of Object.values(values))
          insert.run(value.id, run.id, JSON.stringify(value));
      }
      for (const version of Object.values(state.versions)) {
        this.db
          .prepare('INSERT OR IGNORE INTO resources VALUES (?, ?, ?)')
          .run(stableId(run.id, version.resourceId), run.id, version.resourceId);
        this.db
          .prepare('INSERT OR IGNORE INTO resource_versions VALUES (?, ?, ?, ?, ?)')
          .run(version.id, run.id, version.resourceId, version.generation, JSON.stringify(version));
      }
      for (const [resource, versionId] of Object.entries(state.heads))
        this.db
          .prepare(
            'INSERT INTO resource_heads VALUES (?, ?, ?) ON CONFLICT(run_id, resource_id) DO UPDATE SET version_id=excluded.version_id',
          )
          .run(run.id, resource, versionId);
      for (const observation of Object.values(state.observations))
        this.db
          .prepare('INSERT OR IGNORE INTO observations VALUES (?, ?, ?, ?, ?)')
          .run(
            observation.id,
            run.id,
            observation.attemptId,
            observation.versionId,
            JSON.stringify(observation),
          );
      for (const attempt of Object.values(state.attempts))
        for (const [resource, observationId] of Object.entries(attempt.frontier))
          this.db
            .prepare(
              'INSERT INTO attempt_frontier VALUES (?, ?, ?, ?) ON CONFLICT(attempt_id, resource_id) DO UPDATE SET observation_id=excluded.observation_id',
            )
            .run(run.id, attempt.id, resource, observationId);
      for (const edge of state.edges)
        this.db
          .prepare('INSERT OR IGNORE INTO provenance_edges VALUES (?, ?, ?, ?, ?)')
          .run(edge.id, run.id, edge.sourceVersionId, edge.targetVersionId, JSON.stringify(edge));
      for (const hazard of state.hazards)
        this.db
          .prepare('INSERT OR IGNORE INTO hazards VALUES (?, ?, ?, ?)')
          .run(hazard.id, run.id, hazard.consumerVersionId, JSON.stringify(hazard));
      for (const assessment of Object.values(state.assessments))
        this.db
          .prepare('INSERT OR IGNORE INTO semantic_assessments VALUES (?, ?, ?, ?)')
          .run(assessment.id, run.id, assessment.hazardId, JSON.stringify(assessment));
    })();
  }
  close(): void {
    this.db.close();
  }
}
