package ravel

import (
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

//go:embed schema.sql
var schemaSQL string
var blobKey = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Store struct {
	DB               *sql.DB
	Directory, Blobs string
	blobMu           sync.Mutex
}

func OpenStore(directory string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(directory, "blobs"), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(directory, "ravel.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{DB: db, Directory: directory, Blobs: filepath.Join(directory, "blobs")}
	if _, err = db.Exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)"); err != nil {
		db.Close()
		return nil, err
	}
	var count int
	if err = db.QueryRow("SELECT COUNT(*) FROM schema_migrations WHERE version=1").Scan(&count); err != nil {
		db.Close()
		return nil, err
	}
	if count == 0 {
		tx, err := db.Begin()
		if err != nil {
			db.Close()
			return nil, err
		}
		if _, err = tx.Exec(schemaSQL); err == nil {
			_, err = tx.Exec("INSERT INTO schema_migrations VALUES(1)")
		}
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	return s, nil
}
func (s *Store) Close() error { return s.DB.Close() }
func (s *Store) PutBlob(bytes []byte) (string, error) {
	s.blobMu.Lock()
	defer s.blobMu.Unlock()
	key := hash(bytes)
	file, err := os.OpenFile(filepath.Join(s.Blobs, key), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		_, err = s.GetBlob(key)
		return key, err
	}
	if err != nil {
		return "", err
	}
	_, err = file.Write(bytes)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	return key, err
}
func (s *Store) GetBlob(key string) ([]byte, error) {
	if !blobKey.MatchString(key) {
		return nil, fmt.Errorf("invalid blob reference")
	}
	data, err := os.ReadFile(filepath.Join(s.Blobs, key))
	if err != nil {
		return nil, err
	}
	if hash(data) != key {
		return nil, fmt.Errorf("blob integrity failure")
	}
	return data, nil
}
func (s *Store) Content(v Version) (*string, error) {
	if v.BlobRef == nil {
		return nil, nil
	}
	data, err := s.GetBlob(*v.BlobRef)
	if err != nil {
		return nil, err
	}
	return ptr(string(data)), nil
}
func (s *Store) Events(runID string, through int) ([]Event, error) {
	if through == 0 {
		through = int(^uint(0) >> 1)
	}
	rows, err := s.DB.Query("SELECT body FROM events WHERE run_id=? AND runtime_seq<=? ORDER BY runtime_seq", runID, through)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []Event{}
	for rows.Next() {
		var data []byte
		var e Event
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(data, &e); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}
func (s *Store) Runs() ([]Run, error) {
	rows, err := s.DB.Query("SELECT body FROM runs ORDER BY rowid DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Run{}
	for rows.Next() {
		var data []byte
		var run Run
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(data, &run); err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	return out, rows.Err()
}
func (s *Store) RunForEntity(table, id string) (string, error) {
	if table != "hazards" && table != "resource_versions" {
		return "", fmt.Errorf("invalid entity table")
	}
	var runID string
	err := s.DB.QueryRow("SELECT run_id FROM "+table+" WHERE id=?", id).Scan(&runID)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("entity not found")
	}
	return runID, err
}
func body(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}
func (s *Store) Commit(e Event, state *State) (err error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	exec := func(query string, args ...any) {
		if err == nil {
			_, err = tx.Exec(query, args...)
		}
	}
	run := state.Run
	exec("INSERT INTO runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", run.ID, body(run))
	exec("INSERT INTO events VALUES(?,?,?,?,?)", e.ID, run.ID, e.RuntimeSeq, e.Kind, body(e))
	for _, a := range orderedAgents(state) {
		exec("INSERT INTO agents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", a.ID, run.ID, body(a))
	}
	for _, a := range orderedAttempts(state) {
		task := state.Tasks[a.TaskID]
		exec("INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", task.ID, run.ID, body(task))
		exec("INSERT INTO task_attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", a.ID, run.ID, body(a))
	}
	for _, v := range orderedVersions(state) {
		exec("INSERT OR IGNORE INTO resources VALUES(?,?,?)", stable(run.ID, v.ResourceID), run.ID, v.ResourceID)
		exec("INSERT OR IGNORE INTO resource_versions VALUES(?,?,?,?,?)", v.ID, run.ID, v.ResourceID, v.Generation, body(v))
	}
	for path, id := range state.Heads {
		exec("INSERT INTO resource_heads VALUES(?,?,?) ON CONFLICT(run_id,resource_id) DO UPDATE SET version_id=excluded.version_id", run.ID, path, id)
	}
	for _, o := range state.Observations {
		exec("INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?)", o.ID, run.ID, o.AttemptID, o.VersionID, body(o))
	}
	for _, a := range state.Attempts {
		for path, oid := range a.Frontier {
			exec("INSERT INTO attempt_frontier VALUES(?,?,?,?) ON CONFLICT(attempt_id,resource_id) DO UPDATE SET observation_id=excluded.observation_id", run.ID, a.ID, path, oid)
		}
	}
	for _, edge := range state.Edges {
		exec("INSERT OR IGNORE INTO provenance_edges VALUES(?,?,?,?,?)", edge.ID, run.ID, edge.SourceVersionID, edge.TargetVersionID, body(edge))
	}
	for _, h := range state.Hazards {
		exec("INSERT OR IGNORE INTO hazards VALUES(?,?,?,?)", h.ID, run.ID, h.ConsumerVersionID, body(h))
	}
	for _, a := range state.Assessments {
		exec("INSERT OR IGNORE INTO semantic_assessments VALUES(?,?,?,?)", a.ID, run.ID, a.HazardID, body(a))
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
