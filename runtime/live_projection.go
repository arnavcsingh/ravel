package ravel

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"ravel/runtime/projection"
	"sync"
	"time"
)

type ProjectionStatus struct {
	mu        sync.RWMutex
	Available bool
	Error     string
}

func (p *ProjectionStatus) set(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Available = err == nil
	p.Error = ""
	if err != nil {
		p.Error = err.Error()
	}
}
func (p *ProjectionStatus) Value() Object {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return Object{"available": p.Available, "error": p.Error}
}

// StartProjection tails committed SQLite facts through an independent read-only
// connection. Network I/O never holds a coordinator mutex or writer connection.
// Coalesced snapshots contain the full timeline in deterministic runtime_seq
// order; a failed publish is retried from SQLite without a lossy memory queue.
func (s *Service) StartProjection(sink projection.Sink, interval time.Duration) *ProjectionStatus {
	if interval <= 0 {
		interval = 500 * time.Millisecond
	}
	status := &ProjectionStatus{}
	s.jobs.Add(1)
	go func() {
		defer s.jobs.Done()
		db, err := sql.Open("sqlite", filepath.ToSlash(filepath.Join(s.Store.Directory, "ravel.db"))+"?mode=ro")
		if err != nil {
			status.set(fmt.Errorf("projection reader unavailable"))
			return
		}
		defer db.Close()
		db.SetMaxOpenConns(1)
		if _, err = db.Exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000"); err != nil {
			status.set(err)
			return
		}
		reader := Projector{&Store{DB: db, Directory: s.Store.Directory, Blobs: s.Store.Blobs}}
		last := map[string]int{}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		delay := interval
		next := time.Time{}
		for {
			if time.Now().After(next) {
				err = publishCommitted(s.ctx, reader, sink, last)
				status.set(err)
				if err != nil {
					delay *= 2
					if delay > 30*time.Second {
						delay = 30 * time.Second
					}
				} else {
					delay = interval
				}
				next = time.Now().Add(delay)
			}
			select {
			case <-s.ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return status
}

func (s *Service) ConfigureProjection(config Object, sink projection.Sink) {
	s.liveConfig = config
	if enabled, _ := config["enabled"].(bool); enabled && sink != nil {
		s.liveStatus = s.StartProjection(sink, 500*time.Millisecond)
	}
}
func (s *Service) projectionInfo() Object {
	value := Object{"name": "SpacetimeDB", "enabled": false, "configured": true, "available": false, "fallback": "sse"}
	for key, item := range s.liveConfig {
		value[key] = item
	}
	if s.liveStatus != nil {
		for key, item := range s.liveStatus.Value() {
			value[key] = item
		}
	}
	return value
}

func publishCommitted(ctx context.Context, reader Projector, sink projection.Sink, last map[string]int) error {
	runs, err := reader.Store.Runs()
	if err != nil {
		return fmt.Errorf("projection read failed")
	}
	for _, run := range runs {
		var seq int
		if err = reader.Store.DB.QueryRow("SELECT COALESCE(MAX(runtime_seq),0) FROM events WHERE run_id=?", run.ID).Scan(&seq); err != nil {
			return err
		}
		if seq <= last[run.ID] {
			continue
		}
		snapshot, err := reader.Snapshot(run.ID, seq)
		if err != nil {
			return err
		}
		// Suppress local filesystem paths in the public, disposable read model.
		value := *snapshot["run"].(*Run)
		value.Workspace = "Managed Ravel workspace"
		snapshot["run"] = &value
		// latestRuntimeSeq may reflect newer commits. This packet represents exactly seq.
		snapshot["latestRuntimeSeq"] = seq
		data, err := json.Marshal(snapshot)
		if err != nil {
			return err
		}
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err = sink.Publish(callCtx, projection.Update{RunID: run.ID, RuntimeSeq: seq, Kind: "SNAPSHOT", Snapshot: data})
		cancel()
		if err != nil {
			return err
		}
		last[run.ID] = seq
	}
	return nil
}
