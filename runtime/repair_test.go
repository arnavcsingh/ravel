package ravel

import (
	"context"
	"testing"
)

func staleRepairRoot(t *testing.T) (*testFixture, Version) {
	f := fixture(t, "observe")
	f.read(f.a, "input")
	f.write(f.b, "input", "B")
	stale := f.write(f.a, "output", "constant output")
	ok(t, f.c.FinishAttempt(f.a.ID, "completed"))
	return f, *stale.Version
}

func TestRepairRegeneratesIdenticalContentAndDownstream(t *testing.T) {
	f, old := staleRepairRoot(t)
	agent, err := f.c.CreateAgent("arbitrary downstream", "")
	ok(t, err)
	downstream, err := f.c.CreateAttempt(agent, "downstream", "", "")
	ok(t, err)
	f.read(downstream, "output")
	oldChild := *f.write(downstream, "child", "unchanged client").Version
	ok(t, f.c.FinishAttempt(downstream.ID, "completed"))
	repairChild, err := f.c.CreateRepairAttempt(agent, downstream.TaskID, downstream.ID)
	ok(t, err)
	_, err = f.c.Observe(repairChild.ID, "output")
	check(t, err != nil, "downstream read affected upstream before regeneration")
	repairRoot, err := f.c.CreateRepairAttempt(f.a.AgentID, f.a.TaskID, f.a.ID)
	ok(t, err)
	check(t, len(repairRoot.Frontier) == 0, "repair inherited old frontier")
	source := f.read(repairRoot, "input").Version
	newRoot := f.write(repairRoot, "output", "constant output")
	check(t, newRoot.Committed && !newRoot.Noop && newRoot.Version.ID != old.ID, "identical repair did not publish a new execution")
	check(t, same(newRoot.Version.ContentHash, old.ContentHash) && val(newRoot.Version.PreviousVersionID) == old.ID, "repair changed content or lost history")
	ok(t, f.c.FinishAttempt(repairRoot.ID, "completed"))
	f.read(repairChild, "output")
	newChild := f.write(repairChild, "child", "unchanged client")
	ok(t, f.c.FinishAttempt(repairChild.ID, "completed"))
	check(t, newChild.Committed && newChild.Version.ID != oldChild.ID, "identical downstream did not update head")
	s := f.c.State()
	check(t, len(s.Hazards) == 1 && len(BlastRadius(old.ID, s.Edges, s.Heads).Active) == 0, "repair lost hazard or retained active impact")
	check(t, s.Versions[old.ID].ID == old.ID && s.Versions[oldChild.ID].ID == oldChild.ID, "historical versions changed")
	check(t, len(s.Edges) == 4 && s.Edges[2].SourceVersionID == source.ID && s.Edges[3].SourceVersionID == newRoot.Version.ID, "replacement provenance is not fresh")
	ordinary, err := f.c.CreateAttempt(agent, "", "", downstream.TaskID)
	ok(t, err)
	f.read(ordinary, "output")
	noop := f.write(ordinary, "child", "unchanged client")
	check(t, noop.Noop && noop.Version.ID == newChild.Version.ID, "ordinary no-op semantics changed")
	recovered, err := NewCoordinator(f.store, f.c.Workspace.Root, f.c.RunID)
	ok(t, err)
	defer recovered.Close()
	check(t, val(recovered.State().Attempts[repairRoot.ID].RepairOf) == f.a.ID, "repair identity lost on recovery")
	plan, err := (Projector{Store: f.store}).ReplayPlan(s.Hazards[0].ID)
	ok(t, err)
	check(t, len(plan["steps"].([]Object)) == 5, "historical focused replay changed")
}

func TestRepairRejectsAffectedReadsAndSearchWithoutRecordingThem(t *testing.T) {
	f, _ := staleRepairRoot(t)
	a, err := f.c.CreateRepairAttempt(f.a.AgentID, f.a.TaskID, f.a.ID)
	ok(t, err)
	before := f.c.State().Seq
	_, err = f.c.Observe(a.ID, "output")
	check(t, err != nil, "repair read its affected output")
	_, err = f.c.Search(a.ID, "constant")
	check(t, err != nil, "repair search observed affected output")
	check(t, f.c.State().Seq == before && len(f.c.State().Attempts[a.ID].Frontier) == 0, "blocked reads contaminated repair frontier")
	_, err = f.c.Write(context.Background(), a.ID, "output", ptr("replacement"))
	check(t, err != nil, "repair published without fresh source observations")
}

func TestRepairRejectsStaleCandidateEvenInObserve(t *testing.T) {
	f, old := staleRepairRoot(t)
	a, err := f.c.CreateRepairAttempt(f.a.AgentID, f.a.TaskID, f.a.ID)
	ok(t, err)
	f.read(a, "input")
	intent := f.prepare(a, "output", "replacement")
	f.write(f.b, "input", "C")
	result, err := f.c.CommitWrite(context.Background(), intent.ID)
	ok(t, err)
	check(t, result.Rejected && f.c.State().Heads["output"] == old.ID, "repair published a stale candidate")
	retry, err := f.c.CreateRepairAttempt(f.a.AgentID, f.a.TaskID, f.a.ID)
	ok(t, err)
	check(t, len(retry.Frontier) == 0, "repair retry retained frontier")
	f.read(retry, "input")
	f.write(retry, "output", "replacement")
	check(t, len(BlastRadius(old.ID, f.c.State().Edges, f.c.State().Heads).Active) == 0, "fresh retry did not repair")
}

func TestRepairIdentityMustMatchEndedProducerTask(t *testing.T) {
	f, _ := staleRepairRoot(t)
	_, err := f.c.CreateRepairAttempt(f.b.AgentID, f.a.TaskID, f.a.ID)
	check(t, err != nil, "foreign agent accepted for repair")
	_, err = f.c.CreateRepairAttempt(f.a.AgentID, f.b.TaskID, f.a.ID)
	check(t, err != nil, "foreign task accepted for repair")
	_, err = f.c.CreateRepairAttempt(f.b.AgentID, f.b.TaskID, f.b.ID)
	check(t, err != nil, "running attempt accepted for repair")
}
