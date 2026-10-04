package ravel

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"ravel/runtime/projection"
	"sync"
	"testing"
	"time"
)

type captureProjection struct {
	mu      sync.Mutex
	updates []projection.Update
	fail    bool
	blocked chan struct{}
	entered chan struct{}
	once    sync.Once
}

func (p *captureProjection) Publish(ctx context.Context, u projection.Update) error {
	if p.entered != nil {
		p.once.Do(func() { close(p.entered) })
	}
	if p.blocked != nil {
		select {
		case <-p.blocked:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.updates = append(p.updates, u)
	if p.fail {
		return fmt.Errorf("offline")
	}
	return nil
}
func TestProjectionCommitRetryAndIdempotence(t *testing.T) {
	s, err := NewService(t.TempDir(), "", false)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, err := NewCoordinator(s.Store, filepath.Join(s.root, "test"), "projection-run")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err = c.Start("Projection", nil, "observe"); err != nil {
		t.Fatal(err)
	}
	sink := &captureProjection{fail: true}
	last := map[string]int{}
	if err = publishCommitted(context.Background(), s.Projector, sink, last); err == nil {
		t.Fatal("expected failure")
	}
	if len(last) != 0 {
		t.Fatal("failed publication advanced cursor")
	}
	sink.fail = false
	if err = publishCommitted(context.Background(), s.Projector, sink, last); err != nil {
		t.Fatal(err)
	}
	if last[c.RunID] != 1 {
		t.Fatal(last)
	}
	if err = publishCommitted(context.Background(), s.Projector, sink, last); err != nil {
		t.Fatal(err)
	}
	if len(sink.updates) != 2 {
		t.Fatal("duplicate publication", len(sink.updates))
	}
	var snapshot Object
	if err = json.Unmarshal(sink.updates[1].Snapshot, &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot["run"].(map[string]any)["workspace"] != "Managed Ravel workspace" {
		t.Fatal("local path exposed")
	}
	// A rolled-back logical commit never appears in the projection.
	_, err = s.Store.DB.Exec("CREATE TRIGGER fail_agent BEFORE INSERT ON agents BEGIN SELECT RAISE(ABORT, 'blocked'); END")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.CreateAgent("Failed", "test"); err == nil {
		t.Fatal("expected rollback")
	}
	if err = publishCommitted(context.Background(), s.Projector, sink, last); err != nil {
		t.Fatal(err)
	}
	if len(sink.updates) != 2 {
		t.Fatal("uncommitted update published")
	}
}
func TestProjectionNetworkCannotBlockCoordinator(t *testing.T) {
	s, err := NewService(t.TempDir(), "", false)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, err := NewCoordinator(s.Store, filepath.Join(s.root, "active"), "active")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err = c.Start("Active", nil, "observe"); err != nil {
		t.Fatal(err)
	}
	gate := make(chan struct{})
	defer close(gate)
	sink := &captureProjection{blocked: gate, entered: make(chan struct{})}
	status := s.StartProjection(sink, 10*time.Millisecond)
	select {
	case <-sink.entered:
	case <-time.After(time.Second):
		t.Fatal("publisher did not start")
	}
	done := make(chan error, 1)
	go func() { _, err := c.CreateAgent("Still runs", "test"); done <- err }()
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("network blocked core")
	}
	if status.Value()["available"] == true {
		t.Fatal("blocked projection reported available")
	}
}
