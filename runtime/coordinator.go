package ravel

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

type CommandResult struct {
	Output   string `json:"output"`
	ExitCode int    `json:"exitCode"`
}
type ReadonlyCommand func(context.Context, map[string]*string) (CommandResult, error)
type Gate interface {
	Wait(context.Context, Intent) error
}
type Coordinator struct {
	mu             sync.Mutex
	Store          *Store
	Workspace      *Workspace
	RunID          string
	current        *State
	pending        map[string]Intent
	commands       map[string]ReadonlyCommand
	activeCommands map[string]int
	Gate           Gate
	closed         bool
	workspaceError *string
	subscribers    map[chan Event]bool
	epoch          time.Time
}

func NewCoordinator(store *Store, workspace, runID string) (*Coordinator, error) {
	if runID == "" {
		runID = ID()
	}
	w, err := NewWorkspace(workspace)
	if err != nil {
		return nil, err
	}
	events, err := store.Events(runID, 0)
	if err != nil {
		return nil, err
	}
	s, err := Replay(events)
	if err != nil {
		return nil, err
	}
	return &Coordinator{Store: store, Workspace: w, RunID: runID, current: s, pending: map[string]Intent{}, commands: map[string]ReadonlyCommand{}, activeCommands: map[string]int{}, subscribers: map[chan Event]bool{}, epoch: time.Now()}, nil
}
func (c *Coordinator) State() *State { c.mu.Lock(); defer c.mu.Unlock(); return clone(c.current) }
func (c *Coordinator) WorkspaceError() *string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return clone(c.workspaceError)
}
func (c *Coordinator) Subscribe() (chan Event, func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan Event, 256)
	if c.closed {
		close(ch)
	} else {
		c.subscribers[ch] = true
	}
	return ch, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.subscribers[ch] {
			delete(c.subscribers, ch)
			close(ch)
		}
	}
}
func (c *Coordinator) record(kind string, payload func(string, int) any, attemptID, agentID, commandID string) error {
	if c.closed {
		return fmt.Errorf("coordinator closed")
	}
	s := c.current
	e := Event{ID: ID(), RunID: c.RunID, RuntimeSeq: s.Seq + 1, Kind: kind, WallTime: time.Now().UTC().Format(time.RFC3339Nano), MonotonicTime: float64(time.Since(c.epoch).Microseconds()) / 1000}
	if a := s.Attempts[attemptID]; a != nil {
		e.AttemptID = ptr(attemptID)
		e.AgentID = ptr(a.AgentID)
		e.TaskID = ptr(a.TaskID)
	} else if agentID != "" {
		e.AgentID = ptr(agentID)
	}
	if commandID != "" {
		e.CommandID = ptr(commandID)
	}
	data := payload(e.ID, e.RuntimeSeq)
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	e.Payload = raw
	if kind == "TASK_ATTEMPT_START" {
		var p Payload
		if err = json.Unmarshal(raw, &p); err != nil {
			return err
		}
		e.AttemptID = ptr(p.Attempt.ID)
		e.TaskID = ptr(p.Task.ID)
	}
	if e.AgentID != nil {
		seq := 1
		for _, old := range s.Events {
			if same(old.AgentID, e.AgentID) {
				seq++
			}
		}
		e.AgentSeq = ptr(seq)
	}
	candidate := clone(s)
	if err = ApplyEvent(candidate, e); err != nil {
		return err
	}
	if err = c.Store.Commit(e, candidate); err != nil {
		return err
	}
	c.current = candidate
	for ch := range c.subscribers {
		select {
		case ch <- clone(e):
		default:
			delete(c.subscribers, ch)
			close(ch)
		}
	}
	return nil
}
func fixed(v any) func(string, int) any { return func(string, int) any { return v } }
func (c *Coordinator) requireRun() error {
	if c.closed || c.current.Run == nil || c.current.Run.Status != "running" {
		return fmt.Errorf("run is not active")
	}
	return nil
}
func (c *Coordinator) requireAttempt(id string) (*Attempt, error) {
	if err := c.requireRun(); err != nil {
		return nil, err
	}
	a := c.current.Attempts[id]
	if a == nil || a.Status != "running" {
		return nil, fmt.Errorf("attempt is not active in this run")
	}
	return a, nil
}
func (c *Coordinator) Start(name string, scenario *string, mode string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.current.Run != nil {
		return fmt.Errorf("run already exists")
	}
	if mode == "" {
		mode = "observe"
	}
	if mode != "observe" && mode != "guard" {
		return fmt.Errorf("invalid mode")
	}
	run := Run{c.RunID, name, c.Workspace.Root, scenario, mode, "running", time.Now().UTC().Format(time.RFC3339Nano), nil}
	return c.record("RUN_START", fixed(run), "", "", "")
}
func (c *Coordinator) CreateAgent(name, adapter string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.requireRun(); err != nil {
		return "", err
	}
	if adapter == "" {
		adapter = "scripted"
	}
	id := ID()
	err := c.record("AGENT_START", fixed(Agent{id, c.RunID, name, adapter, "running"}), "", id, "")
	return id, err
}
func (c *Coordinator) CreateAttempt(agentID, name, prompt, taskID string) (*Attempt, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.createAttempt(agentID, name, prompt, taskID, nil)
}

// Repair is a fresh execution of an existing task, never a relabeling of its output.
func (c *Coordinator) CreateRepairAttempt(agentID, taskID, repairOf string) (*Attempt, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	prior := c.current.Attempts[repairOf]
	if prior == nil || prior.Status == "running" || prior.AgentID != agentID || prior.TaskID != taskID {
		return nil, fmt.Errorf("repair must reference an ended attempt of the same agent and task")
	}
	return c.createAttempt(agentID, "", "", taskID, ptr(repairOf))
}

func (c *Coordinator) createAttempt(agentID, name, prompt, taskID string, repairOf *string) (*Attempt, error) {
	if err := c.requireRun(); err != nil {
		return nil, err
	}
	if c.current.Agents[agentID] == nil {
		return nil, fmt.Errorf("unknown agent")
	}
	task := c.current.Tasks[taskID]
	if taskID == "" {
		task = &Task{ID(), c.RunID, name, prompt}
	}
	if task == nil {
		return nil, fmt.Errorf("unknown task")
	}
	number := 1
	for _, a := range c.current.Attempts {
		if a.TaskID == task.ID {
			number++
		}
	}
	id := ID()
	err := c.record("TASK_ATTEMPT_START", func(eid string, _ int) any {
		return map[string]any{"task": task, "attempt": Attempt{id, task.ID, agentID, number, "running", eid, nil, map[string]string{}, []string{}, []string{}, repairOf}}
	}, "", agentID, "")
	if err != nil {
		return nil, err
	}
	return clone(c.current.Attempts[id]), nil
}
func (c *Coordinator) snapshot(path string, generation int) (Version, error) {
	if err := c.requireRun(); err != nil {
		return Version{}, err
	}
	normalized, err := ResourcePath(path)
	if err != nil {
		return Version{}, err
	}
	if id := c.current.Heads[normalized]; id != "" {
		return c.current.Versions[id], nil
	}
	content, err := c.Workspace.Read(normalized)
	if err != nil {
		return Version{}, err
	}
	var key *string
	if content != nil {
		h, err := c.Store.PutBlob([]byte(*content))
		if err != nil {
			return Version{}, err
		}
		key = &h
	}
	id := ID()
	if generation < 1 {
		return Version{}, fmt.Errorf("invalid generation")
	}
	err = c.record("RESOURCE_SNAPSHOT", func(eid string, seq int) any {
		return map[string]any{"version": Version{id, normalized, generation, key, key, nil, nil, eid, seq, content == nil}}
	}, "", "", "")
	return c.current.Versions[id], err
}
func (c *Coordinator) ImportResource(path string, generation int) (Version, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, err := c.snapshot(path, generation)
	return clone(v), err
}
func (c *Coordinator) ImportWorkspace() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	files, err := c.Workspace.List()
	if err != nil {
		return err
	}
	for _, path := range files {
		if _, err = c.snapshot(path, 1); err != nil {
			return err
		}
	}
	return nil
}

type Observed struct {
	Version Version `json:"version"`
	Content *string `json:"content"`
}

func observation(eid, attemptID, versionID, kind string) Observation {
	return Observation{ID(), attemptID, versionID, eid, kind}
}

func (c *Coordinator) affectedVersion(id string) bool {
	for _, h := range c.current.Hazards {
		if contains(BlastRadius(h.ConsumerVersionID, c.current.Edges, c.current.Heads).Historical, id) {
			return true
		}
	}
	return false
}

func (c *Coordinator) Observe(attemptID, path string) (Observed, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.requireAttempt(attemptID); err != nil {
		return Observed{}, err
	}
	v, err := c.snapshot(path, 1)
	if err != nil {
		return Observed{}, err
	}
	if c.current.Attempts[attemptID].RepairOf != nil && c.affectedVersion(v.ID) {
		return Observed{}, fmt.Errorf("repair cannot use affected output %s as input; regenerate from fresh source dependencies", v.ResourceID)
	}
	content, err := c.Store.Content(v)
	if err != nil {
		return Observed{}, err
	}
	err = c.record("OBSERVE_RESOURCE", func(eid string, _ int) any {
		return map[string]any{"observation": observation(eid, attemptID, v.ID, "DIRECT_READ")}
	}, attemptID, "", "")
	return Observed{clone(v), content}, err
}
func (c *Coordinator) List(attemptID string) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.requireAttempt(attemptID); err != nil {
		return nil, err
	}
	paths := []string{}
	for path, id := range c.current.Heads {
		if !c.current.Versions[id].Tombstone {
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	return paths, c.record("LIST_RESOURCES", fixed(map[string]any{"resources": paths}), attemptID, "", "")
}

type Match struct {
	ResourceID string `json:"resourceId"`
	VersionID  string `json:"versionId"`
	Line       int    `json:"line"`
	Text       string `json:"text"`
}

func (c *Coordinator) Search(attemptID, query string) ([]Match, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.requireAttempt(attemptID); err != nil {
		return nil, err
	}
	if len(query) == 0 || len(query) > 500 {
		return nil, fmt.Errorf("search query must be 1-500 characters")
	}
	paths := []string{}
	for path := range c.current.Heads {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	matches := []Match{}
	versions := []string{}
	for _, path := range paths {
		v := c.current.Versions[c.current.Heads[path]]
		content, err := c.Store.Content(v)
		if err != nil {
			return nil, err
		}
		if content == nil {
			continue
		}
		for i, line := range strings.Split(*content, "\n") {
			if strings.Contains(line, query) {
				if c.current.Attempts[attemptID].RepairOf != nil && c.affectedVersion(v.ID) {
					return nil, fmt.Errorf("repair search matches affected output %s; observe fresh source dependencies directly", v.ResourceID)
				}
				matches = append(matches, Match{path, v.ID, i + 1, line})
				if !contains(versions, v.ID) {
					versions = append(versions, v.ID)
				}
			}
		}
	}
	err := c.record("SEARCH_RESULT", func(eid string, _ int) any {
		observations := []Observation{}
		for _, id := range versions {
			observations = append(observations, observation(eid, attemptID, id, "SEARCH_RESULT"))
		}
		return map[string]any{"query": query, "matches": matches, "observations": observations}
	}, attemptID, "", "")
	return matches, err
}
func (c *Coordinator) hasPending(attemptID string) bool {
	for _, i := range c.pending {
		if i.AttemptID == attemptID {
			return true
		}
	}
	return false
}
func (c *Coordinator) PrepareWrite(attemptID, path string, content *string, baseID string) (Intent, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	a, err := c.requireAttempt(attemptID)
	if err != nil {
		return Intent{}, err
	}
	if c.hasPending(attemptID) || c.activeCommands[attemptID] > 0 {
		return Intent{}, fmt.Errorf("attempt has pending work")
	}
	head, err := c.snapshot(path, 1)
	if err != nil {
		return Intent{}, err
	}
	a = c.current.Attempts[a.ID]
	var key *string
	if content != nil {
		h, err := c.Store.PutBlob([]byte(*content))
		if err != nil {
			return Intent{}, err
		}
		key = &h
	}
	ids := frontierIDs(a, c.current)
	var base *string
	if baseID != "" {
		v, exists := c.current.Versions[baseID]
		oid := ""
		for _, e := range c.current.Events {
			var p Payload
			_ = json.Unmarshal(e.Payload, &p)
			obs := append([]Observation{p.Observation}, p.Observations...)
			for _, o := range obs {
				if o.AttemptID == a.ID && o.VersionID == baseID {
					oid = o.ID
				}
			}
		}
		if !exists || v.ResourceID != head.ResourceID || oid == "" {
			return Intent{}, fmt.Errorf("patch base must be an observed version of the same resource")
		}
		filtered := []string{}
		for _, id := range ids {
			if c.current.Versions[c.current.Observations[id].VersionID].ResourceID != head.ResourceID {
				filtered = append(filtered, id)
			}
		}
		ids = append(filtered, oid)
		base = ptr(baseID)
	} else if oid := a.Frontier[head.ResourceID]; oid != "" {
		base = ptr(c.current.Observations[oid].VersionID)
	}
	intent := Intent{ID(), a.ID, head.ResourceID, key, ids, base}
	if err = c.record("WRITE_INTENT", fixed(intent), a.ID, "", ""); err != nil {
		return Intent{}, err
	}
	c.pending[intent.ID] = clone(intent)
	return clone(intent), nil
}

type WriteResult struct {
	Version      *Version `json:"version"`
	Committed    bool     `json:"committed"`
	Noop         bool     `json:"noop"`
	Rejected     bool     `json:"rejected"`
	Materialized bool     `json:"materialized"`
}

func (c *Coordinator) CommitWrite(ctx context.Context, intentID string) (WriteResult, error) {
	c.mu.Lock()
	intent, exists := c.pending[intentID]
	gate := c.Gate
	c.mu.Unlock()
	if !exists {
		return WriteResult{}, fmt.Errorf("unknown or settled intent")
	}
	if gate != nil {
		if err := gate.Wait(ctx, clone(intent)); err != nil {
			return WriteResult{}, err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	intent, exists = c.pending[intentID]
	if !exists {
		return WriteResult{}, fmt.Errorf("pending mutation already settled")
	}
	a, err := c.requireAttempt(intent.AttemptID)
	if err != nil {
		return WriteResult{}, err
	}
	head := c.current.Versions[c.current.Heads[intent.ResourceID]]
	stale, err := StaleInputs(c.current, intent.ObservationIDs)
	if err != nil {
		return WriteResult{}, err
	}
	if a.RepairOf != nil {
		if len(intent.ObservationIDs) == 0 {
			return WriteResult{}, fmt.Errorf("repair requires fresh source observations before publication")
		}
		for _, oid := range intent.ObservationIDs {
			if c.affectedVersion(c.current.Observations[oid].VersionID) {
				return WriteResult{}, fmt.Errorf("repair input carries affected provenance; regenerate from fresh source dependencies")
			}
		}
	}
	if (c.current.Run.Mode == "guard" || a.RepairOf != nil) && len(stale) > 0 {
		ids := []string{}
		for _, input := range stale {
			ids = append(ids, input.Observation.ID)
		}
		if err = c.record("WRITE_REJECTED", fixed(map[string]any{"intentId": intent.ID, "staleObservationIds": ids, "reason": "Observed content changed before publication."}), intent.AttemptID, "", ""); err != nil {
			return WriteResult{}, err
		}
		delete(c.pending, intentID)
		err = c.record("TASK_ATTEMPT_END", fixed(map[string]any{"status": "invalidated"}), intent.AttemptID, "", "")
		return WriteResult{Rejected: true, Materialized: true}, err
	}
	// An affected head must be replaced by the actual repair execution's provenance,
	// even when its newly generated content shares the existing immutable blob.
	regenerated := a.RepairOf != nil && c.affectedVersion(head.ID) && head.ProducerAttemptID != nil && c.current.Attempts[*head.ProducerAttemptID].TaskID == a.TaskID
	if same(intent.CandidateHash, head.ContentHash) && !regenerated {
		if err = c.record("NOOP_WRITE", func(eid string, _ int) any {
			return map[string]any{"observation": observation(eid, intent.AttemptID, head.ID, "OWN_WRITE"), "intentId": intentID}
		}, intent.AttemptID, "", ""); err != nil {
			return WriteResult{}, err
		}
		delete(c.pending, intentID)
		v := clone(head)
		return WriteResult{Version: &v, Noop: true, Materialized: c.materialize(head)}, nil
	}
	id := ID()
	kind := "WRITE_COMMIT"
	if intent.CandidateHash == nil {
		kind = "DELETE_COMMIT"
	}
	err = c.record(kind, func(eid string, seq int) any {
		return map[string]any{"version": Version{id, intent.ResourceID, head.Generation + 1, intent.CandidateHash, intent.CandidateHash, ptr(head.ID), ptr(intent.AttemptID), eid, seq, intent.CandidateHash == nil}, "observationIds": intent.ObservationIDs, "observation": observation(eid, intent.AttemptID, id, "OWN_WRITE"), "intentId": intentID}
	}, intent.AttemptID, "", "")
	if err != nil {
		return WriteResult{}, err
	}
	delete(c.pending, intentID)
	v := clone(c.current.Versions[id])
	return WriteResult{Version: &v, Committed: true, Materialized: c.materialize(v)}, nil
}
func (c *Coordinator) materialize(v Version) bool {
	content, err := c.Store.Content(v)
	if err == nil {
		err = c.Workspace.Write(v.ResourceID, content)
	}
	if err != nil {
		c.workspaceError = ptr(err.Error())
		return false
	}
	return true
}
func (c *Coordinator) Write(ctx context.Context, attemptID, path string, content *string) (WriteResult, error) {
	i, err := c.PrepareWrite(attemptID, path, content, "")
	if err != nil {
		return WriteResult{}, err
	}
	return c.CommitWrite(ctx, i.ID)
}
func (c *Coordinator) Patch(ctx context.Context, attemptID, path, baseID, patch string) (WriteResult, error) {
	c.mu.Lock()
	v, found := c.current.Versions[baseID]
	c.mu.Unlock()
	normalized, err := ResourcePath(path)
	if err != nil {
		return WriteResult{}, err
	}
	if !found || v.ResourceID != normalized {
		return WriteResult{}, fmt.Errorf("unknown patch base")
	}
	content, err := c.Store.Content(v)
	if err != nil {
		return WriteResult{}, err
	}
	candidate, err := ApplyPatch(val(content), patch)
	if err != nil {
		return WriteResult{}, err
	}
	i, err := c.PrepareWrite(attemptID, path, &candidate, baseID)
	if err != nil {
		return WriteResult{}, err
	}
	return c.CommitWrite(ctx, i.ID)
}
func (c *Coordinator) Reconstruct() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.Workspace.Reconstruct(c.current, c.Store); err != nil {
		return err
	}
	c.workspaceError = nil
	return nil
}
func (c *Coordinator) FinishAttempt(attemptID, status string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.requireAttempt(attemptID); err != nil {
		return err
	}
	if c.hasPending(attemptID) || c.activeCommands[attemptID] > 0 {
		return fmt.Errorf("attempt still has pending work")
	}
	if status == "" {
		status = "completed"
	}
	if status != "completed" && status != "failed" {
		return fmt.Errorf("invalid completion status")
	}
	return c.record("TASK_ATTEMPT_END", fixed(map[string]any{"status": status}), attemptID, "", "")
}
func (c *Coordinator) Assess(hazardID string, result Assessment) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if strings.TrimSpace(result.Analyzer) == "" || len(result.Analyzer) > 200 || strings.TrimSpace(result.Reason) == "" || len(result.Reason) > 16000 {
		return fmt.Errorf("assessment requires a bounded analyzer and reason")
	}
	switch result.Relevance {
	case "IRRELEVANT", "POSSIBLE", "LIKELY", "CONFLICT":
	default:
		return fmt.Errorf("invalid assessment relevance")
	}
	if result.AffectedElements == nil || len(result.AffectedElements) > 100 {
		return fmt.Errorf("affectedElements must be an array with at most 100 entries")
	}
	for _, element := range result.AffectedElements {
		if strings.TrimSpace(element) == "" || len(element) > 1000 {
			return fmt.Errorf("invalid affected element")
		}
	}
	return c.record("SEMANTIC_ASSESSMENT", func(_ string, seq int) any {
		result.ID = ID()
		result.HazardID = hazardID
		result.AssessedSeq = seq
		return result
	}, "", "", "")
}
func (c *Coordinator) End() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.requireRun(); err != nil {
		return err
	}
	for _, a := range c.current.Attempts {
		if a.Status == "running" {
			return fmt.Errorf("finish all attempts before ending run")
		}
	}
	for _, a := range orderedAgents(c.current) {
		if a.Status == "running" {
			if err := c.record("AGENT_END", fixed(map[string]any{"agentId": a.ID}), "", a.ID, ""); err != nil {
				return err
			}
		}
	}
	return c.record("RUN_END", fixed(map[string]any{"status": "completed"}), "", "", "")
}
func (c *Coordinator) Resume() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.current.Run == nil || c.current.Run.Status != "completed" {
		return fmt.Errorf("only completed runs can resume")
	}
	return c.record("RUN_RESUME", fixed(map[string]any{}), "", "", "")
}
func (c *Coordinator) RegisterCommand(name string, handler ReadonlyCommand) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.commands[name] = handler
}
func (c *Coordinator) Command(ctx context.Context, attemptID, name string) (CommandResult, error) {
	c.mu.Lock()
	handler := c.commands[name]
	if handler == nil {
		c.mu.Unlock()
		return CommandResult{}, fmt.Errorf("unknown read-only command; arbitrary shell execution unsupported")
	}
	if _, err := c.requireAttempt(attemptID); err != nil {
		c.mu.Unlock()
		return CommandResult{}, err
	}
	if c.hasPending(attemptID) {
		c.mu.Unlock()
		return CommandResult{}, fmt.Errorf("pending mutation")
	}
	files := map[string]*string{}
	ids := []string{}
	for _, v := range orderedVersions(c.current) {
		if c.current.Heads[v.ResourceID] != v.ID {
			continue
		}
		content, err := c.Store.Content(v)
		if err != nil {
			c.mu.Unlock()
			return CommandResult{}, err
		}
		files[v.ResourceID] = content
		ids = append(ids, v.ID)
	}
	id := ID()
	err := c.record("COMMAND_START", fixed(map[string]any{"id": id, "name": name, "inputVersionIds": ids}), attemptID, "", id)
	if err != nil {
		c.mu.Unlock()
		return CommandResult{}, err
	}
	c.activeCommands[attemptID]++
	c.mu.Unlock()
	start := time.Now()
	result, handlerErr := handler(ctx, files)
	if handlerErr != nil {
		result = CommandResult{handlerErr.Error(), 1}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	defer func() { c.activeCommands[attemptID]-- }()
	if err = c.record("COMMAND_END", fixed(map[string]any{"exitCode": result.ExitCode, "name": name, "durationMs": float64(time.Since(start).Microseconds()) / 1000}), attemptID, "", id); err == nil {
		err = c.record("TOOL_RESULT", fixed(map[string]any{"output": result.Output, "inputVersionIds": ids, "success": result.ExitCode == 0}), attemptID, "", id)
	}
	return result, err
}
func (c *Coordinator) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	for ch := range c.subscribers {
		delete(c.subscribers, ch)
		close(ch)
	}
}
