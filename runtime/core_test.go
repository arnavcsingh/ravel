package ravel

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type testFixture struct {
	c     *Coordinator
	store *Store
	a, b  *Attempt
	t     *testing.T
}

func fixture(t *testing.T, mode string) *testFixture {
	t.Helper()
	root := t.TempDir()
	store, err := OpenStore(filepath.Join(root, "data"))
	ok(t, err)
	c, err := NewCoordinator(store, filepath.Join(root, "workspace"), "")
	ok(t, err)
	ok(t, c.Workspace.Write("input", ptr("A")))
	ok(t, c.Start("Test", nil, mode))
	ok(t, c.ImportWorkspace())
	aid, err := c.CreateAgent("A", "")
	ok(t, err)
	a, err := c.CreateAttempt(aid, "Task A", "", "")
	ok(t, err)
	bid, err := c.CreateAgent("B", "")
	ok(t, err)
	b, err := c.CreateAttempt(bid, "Task B", "", "")
	ok(t, err)
	t.Cleanup(func() { c.Close(); _ = store.Close() })
	return &testFixture{c, store, a, b, t}
}
func (f *testFixture) read(a *Attempt, path string) Observed {
	v, err := f.c.Observe(a.ID, path)
	ok(f.t, err)
	return v
}
func (f *testFixture) write(a *Attempt, path, content string) WriteResult {
	v, err := f.c.Write(context.Background(), a.ID, path, &content)
	ok(f.t, err)
	return v
}
func (f *testFixture) prepare(a *Attempt, path, content string) Intent {
	i, err := f.c.PrepareWrite(a.ID, path, &content, "")
	ok(f.t, err)
	return i
}
func TestNoopOwnWriteFrontier(t *testing.T) {
	f := fixture(t, "observe")
	first := f.read(f.a, "input")
	noop := f.write(f.a, "input", "A")
	check(t, noop.Noop && noop.Version.ID == first.Version.ID, "no-op changed generation")
	own := f.write(f.a, "input", "B")
	f.write(f.a, "output", "B")
	s := f.c.State()
	check(t, len(s.Hazards) == 0, "own writes stale")
	check(t, s.Edges[len(s.Edges)-1].SourceVersionID == own.Version.ID, "frontier not advanced")
}
func TestRereadFreshAttempt(t *testing.T) {
	f := fixture(t, "observe")
	f.read(f.a, "input")
	f.write(f.b, "input", "B")
	f.read(f.a, "input")
	f.write(f.a, "output", "B")
	ok(t, f.c.FinishAttempt(f.a.ID, ""))
	next, err := f.c.CreateAttempt(f.a.AgentID, "New", "", "")
	ok(t, err)
	f.write(f.b, "input", "C")
	f.write(next, "other", "unrelated")
	check(t, len(f.c.State().Hazards) == 0, "frontier carried across attempts")
}
func TestContentReversion(t *testing.T) {
	for _, mode := range []string{"observe", "guard"} {
		t.Run(mode, func(t *testing.T) {
			f := fixture(t, mode)
			f.read(f.a, "input")
			f.write(f.b, "input", "B")
			f.write(f.b, "input", "A")
			r := f.write(f.a, "output", "A")
			check(t, !r.Rejected && len(f.c.State().Hazards) == 0, "reversion rejected")
			start := f.write(f.b, "input", "C")
			head := f.write(f.b, "input", "D")
			r = f.write(f.a, "output", "still A")
			if mode == "guard" {
				check(t, r.Rejected, "stale write accepted")
			} else {
				h := f.c.State().Hazards[0]
				check(t, h.StaleSinceVersionID == start.Version.ID && h.ValidationHeadVersionID == head.Version.ID, "continuous stale interval incorrect")
			}
		})
	}
}
func TestMultipleStaleInputs(t *testing.T) {
	f := fixture(t, "observe")
	f.read(f.a, "input")
	f.read(f.a, "missing")
	f.write(f.b, "input", "B")
	f.write(f.b, "missing", "created")
	f.write(f.a, "input", "stale override")
	s := f.c.State()
	check(t, len(s.Hazards) == 2, "missing independent hazard")
	check(t, s.Hazards[0].Evidence == "SAME_RESOURCE_BASE", "missing same-resource evidence")
}
func TestTombstones(t *testing.T) {
	f := fixture(t, "observe")
	absent := f.read(f.a, "absent")
	check(t, absent.Content == nil, "absence is not null")
	empty := f.write(f.b, "absent", "")
	check(t, empty.Version.ContentHash != nil, "empty became absence")
	f.write(f.a, "output", "absence")
	check(t, len(f.c.State().Hazards) == 1, "missing tombstone hazard")
	deleted, err := f.c.Write(context.Background(), f.b.ID, "absent", nil)
	ok(t, err)
	check(t, deleted.Version.Tombstone, "delete not tombstone")
}
func TestSearchListCommandObservations(t *testing.T) {
	f := fixture(t, "observe")
	f.c.RegisterCommand("inspect", func(_ context.Context, files map[string]*string) (CommandResult, error) {
		return CommandResult{*files["input"], 0}, nil
	})
	_, err := f.c.List(f.a.ID)
	ok(t, err)
	_, err = f.c.Command(context.Background(), f.a.ID, "inspect")
	ok(t, err)
	check(t, len(f.c.State().Attempts[f.a.ID].Frontier) == 0, "tool inputs entered model frontier")
	matches, err := f.c.Search(f.a.ID, "A")
	ok(t, err)
	check(t, len(matches) == 1 && len(f.c.State().Attempts[f.a.ID].Frontier) == 1, "search did not observe")
	_, err = f.c.Command(context.Background(), f.a.ID, "rm -rf .")
	check(t, err != nil, "arbitrary command accepted")
}
func TestExactBasePatch(t *testing.T) {
	f := fixture(t, "observe")
	base := f.read(f.a, "input")
	f.write(f.b, "input", "B")
	r, err := f.c.Patch(context.Background(), f.a.ID, "input", base.Version.ID, "--- input\n+++ input\n@@ -1,1 +1,1 @@\n-A\n\\ No newline at end of file\n+C\n\\ No newline at end of file\n")
	ok(t, err)
	content, err := f.store.Content(*r.Version)
	ok(t, err)
	check(t, *content == "C" && f.c.State().Hazards[0].Evidence == "SAME_RESOURCE_BASE", "patch changed base semantics")
	_, err = f.c.Patch(context.Background(), f.a.ID, "other", base.Version.ID, "")
	check(t, err != nil, "foreign base accepted")
	_, err = ApplyPatch("wrong\n", "--- input\n+++ input\n@@ -1 +1 @@\n-A\n+C\n")
	check(t, err != nil, "nonmatching patch applied")
}
func TestRetiredRootActiveDescendant(t *testing.T) {
	f := fixture(t, "observe")
	f.read(f.a, "input")
	f.write(f.b, "input", "B")
	stale := f.write(f.a, "output", "A")
	ok(t, f.c.FinishAttempt(f.a.ID, ""))
	id, err := f.c.CreateAgent("Consumer", "")
	ok(t, err)
	a, err := f.c.CreateAttempt(id, "Consume", "", "")
	ok(t, err)
	f.read(a, "output")
	child := f.write(a, "child", "A")
	repair, err := f.c.CreateAttempt(f.a.AgentID, "Repair", "", "")
	ok(t, err)
	f.read(repair, "input")
	clean := f.write(repair, "output", "B")
	s := f.c.State()
	r := BlastRadius(stale.Version.ID, s.Edges, s.Heads)
	check(t, len(r.Active) == 1 && r.Active[0] == child.Version.ID && !contains(r.Historical, clean.Version.ID), "retired hazard lost downstream head")
}
func TestCapturedIntentImmutability(t *testing.T) {
	f := fixture(t, "observe")
	observed := f.read(f.a, "input")
	*observed.Version.ContentHash = "spoof"
	intent := f.prepare(f.a, "output", "A")
	intent.ObservationIDs = nil
	intent.CandidateHash = nil
	f.write(f.b, "input", "B")
	f.read(f.a, "input")
	r, err := f.c.CommitWrite(context.Background(), intent.ID)
	ok(t, err)
	check(t, !r.Version.Tombstone && len(f.c.State().Hazards) == 1, "returned state changed captured intent")
}
func TestPendingExclusion(t *testing.T) {
	f := fixture(t, "observe")
	intent := f.prepare(f.a, "output", "A")
	_, err := f.c.PrepareWrite(f.a.ID, "second", ptr("B"), "")
	check(t, err != nil, "overlap accepted")
	check(t, f.c.FinishAttempt(f.a.ID, "") != nil, "pending attempt completed")
	f.write(f.b, "input", "B")
	_, err = f.c.CommitWrite(context.Background(), intent.ID)
	ok(t, err)
	ok(t, f.c.FinishAttempt(f.a.ID, ""))
}
func TestGateOutsideMutex(t *testing.T) {
	f := fixture(t, "observe")
	gate := NewScheduler()
	f.c.Gate = gate
	f.read(f.a, "input")
	ok(t, gate.Hold(f.a.ID))
	events, cancel := f.c.Subscribe()
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := f.c.Write(context.Background(), f.a.ID, "output", ptr("A")); done <- err }()
	for {
		select {
		case e := <-events:
			if e.Kind == "WRITE_INTENT" {
				goto captured
			}
		case <-time.After(3 * time.Second):
			t.Fatal("intent never captured")
		}
	}
captured:
	f.write(f.b, "input", "B")
	f.read(f.a, "input")
	ok(t, gate.Release(f.a.ID))
	ok(t, <-done)
	check(t, len(f.c.State().Hazards) == 1, "gate changed provenance")
}
func TestConcurrentWrites(t *testing.T) {
	f := fixture(t, "observe")
	f.read(f.a, "input")
	f.read(f.b, "input")
	a := f.prepare(f.a, "input", "first")
	b := f.prepare(f.b, "input", "second")
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, id := range []string{a.ID, b.ID} {
		wg.Add(1)
		go func(id string) { defer wg.Done(); _, err := f.c.CommitWrite(context.Background(), id); errs <- err }(id)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		ok(t, err)
	}
	s := f.c.State()
	check(t, s.Versions[s.Heads["input"]].Generation == 3 && len(s.Hazards) == 1, "concurrent ordering broken")
	for i, e := range s.Events {
		check(t, e.RuntimeSeq == i+1, "sequence gap")
	}
}
func TestCommandOutsideMutex(t *testing.T) {
	f := fixture(t, "observe")
	entered, release := make(chan struct{}), make(chan struct{})
	f.c.RegisterCommand("slow", func(_ context.Context, _ map[string]*string) (CommandResult, error) {
		close(entered)
		<-release
		return CommandResult{"done", 0}, nil
	})
	done := make(chan error, 1)
	go func() { _, err := f.c.Command(context.Background(), f.a.ID, "slow"); done <- err }()
	<-entered
	f.write(f.b, "input", "B")
	check(t, f.c.FinishAttempt(f.a.ID, "") != nil, "active command completed attempt")
	close(release)
	ok(t, <-done)
}
func TestMaterializationRecovery(t *testing.T) {
	f := fixture(t, "observe")
	f.c.Workspace.WriteHook = func(string, *string) error { return fmt.Errorf("disk busy") }
	r := f.write(f.a, "input", "B")
	check(t, r.Committed && !r.Materialized, "disk failure lost commit")
	disk, err := os.ReadFile(filepath.Join(f.c.Workspace.Root, "input"))
	ok(t, err)
	check(t, string(disk) == "A", "failed disk changed")
	check(t, *f.read(f.a, "input").Content == "B", "reads not database authoritative")
	f.c.Workspace.WriteHook = nil
	ok(t, f.c.Reconstruct())
	disk, err = os.ReadFile(filepath.Join(f.c.Workspace.Root, "input"))
	ok(t, err)
	check(t, string(disk) == "B", "recovery failed")
	recovered, err := NewCoordinator(f.store, f.c.Workspace.Root, f.c.RunID)
	ok(t, err)
	defer recovered.Close()
	sameJSON(t, recovered.State(), f.c.State())
}
func TestSQLiteAtomicRollback(t *testing.T) {
	f := fixture(t, "observe")
	f.read(f.a, "input")
	f.write(f.b, "input", "B")
	intent := f.prepare(f.a, "output", "A")
	before := f.c.State()
	_, err := f.store.DB.Exec("CREATE TRIGGER fail_hazard BEFORE INSERT ON hazards BEGIN SELECT RAISE(ABORT,'injected failure'); END;")
	ok(t, err)
	_, err = f.c.CommitWrite(context.Background(), intent.ID)
	check(t, err != nil && strings.Contains(err.Error(), "injected failure"), "injected failure ignored")
	sameJSON(t, f.c.State(), before)
	events, err := f.store.Events(f.c.RunID, 0)
	ok(t, err)
	state, err := Replay(events)
	ok(t, err)
	sameJSON(t, state, before)
	var count int
	ok(t, f.store.DB.QueryRow("SELECT COUNT(*) FROM hazards").Scan(&count))
	check(t, count == 0, "partial hazard persisted")
	_, err = f.store.DB.Exec("DROP TRIGGER fail_hazard")
	ok(t, err)
	_, err = f.c.CommitWrite(context.Background(), intent.ID)
	ok(t, err)
	check(t, len(f.c.State().Hazards) == 1, "retry lost intent")
}
func TestValidationAndImmutability(t *testing.T) {
	f := fixture(t, "observe")
	observed := f.read(f.a, "input")
	written := f.write(f.a, "output", "value")
	s := f.c.State()
	edge := s.Edges[0]
	edge.SourceVersionID = written.Version.ID
	edge.TargetVersionID = observed.Version.ID
	check(t, AssertDerivation(edge, s.Versions) != nil, "backward DAG edge accepted")
	edge.SourceVersionID = "missing"
	check(t, AssertDerivation(edge, s.Versions) != nil, "unknown DAG version accepted")
	_, err := f.store.DB.Exec("UPDATE events SET kind='invalid'")
	check(t, err != nil, "event update accepted")
	_, err = f.store.DB.Exec("DELETE FROM resource_versions")
	check(t, err != nil, "version deletion accepted")
	_, err = f.c.Observe("foreign", "input")
	check(t, err != nil, "foreign attempt accepted")
	for _, path := range []string{"../escape", ".git/config", "/absolute", "C:/escape"} {
		_, err = f.c.Observe(f.a.ID, path)
		check(t, err != nil, "unsafe path accepted")
	}
	f.write(f.a, "__proto__", "ordinary")
	f.write(f.a, "constructor", "ordinary")
	paths, err := f.c.List(f.a.ID)
	ok(t, err)
	check(t, contains(paths, "__proto__"), "special filename failed")
}
func TestBlobIntegrityAndUncommittedRecovery(t *testing.T) {
	f := fixture(t, "observe")
	i := f.prepare(f.a, "output", "candidate")
	recovered, err := NewCoordinator(f.store, f.c.Workspace.Root, f.c.RunID)
	ok(t, err)
	defer recovered.Close()
	_, err = recovered.CommitWrite(context.Background(), i.ID)
	check(t, err != nil, "crashed intent automatically published")
	key, err := f.store.PutBlob([]byte("bytes"))
	ok(t, err)
	ok(t, os.WriteFile(filepath.Join(f.store.Blobs, key), []byte("corrupt"), 0600))
	_, err = f.store.GetBlob(key)
	check(t, err != nil, "corrupt blob accepted")
}
