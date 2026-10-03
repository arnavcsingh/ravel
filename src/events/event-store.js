import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from '../domain/models.js';

/** Events are the durable source of truth; all other state is a projection. */
export class EventStore {
  constructor(directory) {
    this.directory = directory;
    this.blobs = join(directory, 'blobs');
    mkdirSync(this.blobs, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'ravel.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        runtime_seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        UNIQUE(run_id, runtime_seq)
      );
      CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, runtime_seq);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'Events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'Events are immutable'); END;
    `);
    this.insert = this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)');
  }

  putBlob(content) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const key = hash(bytes);
    try { writeFileSync(join(this.blobs, key), bytes, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return key;
  }

  getBlob(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid blob reference.');
    const content = readFileSync(join(this.blobs, key));
    if (hash(content) !== key) throw new Error('Content blob failed its integrity check.');
    return content;
  }

  append(event, applyWorkspace = () => {}, restoreWorkspace = () => {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insert.run(event.event_id, event.run_id, event.runtime_seq, event.kind, JSON.stringify(event));
      applyWorkspace();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      restoreWorkspace();
      throw error;
    }
  }

  events(runId, through = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare('SELECT body FROM events WHERE run_id = ? AND runtime_seq <= ? ORDER BY runtime_seq')
      .all(runId, through).map((row) => JSON.parse(row.body));
  }

  runs() {
    return this.db.prepare("SELECT body FROM events WHERE kind = 'RUN_START' ORDER BY rowid DESC")
      .all().map((row) => JSON.parse(row.body));
  }

  close() { this.db.close(); }
}
