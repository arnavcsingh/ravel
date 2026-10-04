package ravel

import (
	"encoding/json"
	"fmt"
	"reflect"
)

func observe(s *State, o Observation) error {
	a := s.Attempts[o.AttemptID]
	v, found := s.Versions[o.VersionID]
	if a == nil || a.Status != "running" || !found || o.ID == "" {
		return fmt.Errorf("invalid observation identity")
	}
	if _, exists := s.Observations[o.ID]; exists {
		return fmt.Errorf("duplicate observation")
	}
	s.Observations[o.ID] = o
	a.Frontier[v.ResourceID] = o.ID
	a.ObservedVersions = append(a.ObservedVersions, v.ID)
	return nil
}
func addVersion(s *State, v Version, e Event) error {
	if v.ID == "" || v.Generation < 1 || v.CreatedEventID != e.ID || v.CreationSeq != e.RuntimeSeq || v.Tombstone != (v.ContentHash == nil) || !same(v.ContentHash, v.BlobRef) {
		return fmt.Errorf("invalid version")
	}
	if _, exists := s.Versions[v.ID]; exists {
		return fmt.Errorf("duplicate version")
	}
	previous := s.Heads[v.ResourceID]
	if previous != val(v.PreviousVersionID) {
		return fmt.Errorf("version must succeed current head")
	}
	if previous != "" && v.Generation != s.Versions[previous].Generation+1 {
		return fmt.Errorf("invalid generation")
	}
	s.Versions[v.ID] = v
	s.Heads[v.ResourceID] = v.ID
	return nil
}

// ApplyEvent is deterministic. Callers apply it to a candidate state before durable commit.
func ApplyEvent(s *State, e Event) error {
	if e.ID == "" || e.RunID == "" || e.RuntimeSeq != s.Seq+1 {
		return fmt.Errorf("duplicate or out-of-order runtime_seq")
	}
	if s.Run != nil && s.Run.ID != e.RunID {
		return fmt.Errorf("event belongs to another run")
	}
	if s.Run == nil && e.Kind != "RUN_START" {
		return fmt.Errorf("RUN_START required")
	}
	if e.AgentID != nil {
		seq := 0
		for _, old := range s.Events {
			if same(old.AgentID, e.AgentID) {
				seq++
			}
		}
		if e.AgentSeq == nil || *e.AgentSeq != seq+1 {
			return fmt.Errorf("invalid agent sequence")
		}
	}
	if e.AttemptID != nil && e.Kind != "TASK_ATTEMPT_START" {
		a := s.Attempts[*e.AttemptID]
		if a == nil || a.AgentID != val(e.AgentID) || a.TaskID != val(e.TaskID) || a.Status != "running" {
			return fmt.Errorf("inactive or mismatched attempt")
		}
	}
	var p Payload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return err
	}
	switch e.Kind {
	case "RUN_START":
		var run Run
		if err := json.Unmarshal(e.Payload, &run); err != nil {
			return err
		}
		if s.Run != nil || run.ID != e.RunID || (run.Mode != "observe" && run.Mode != "guard") {
			return fmt.Errorf("invalid RUN_START")
		}
		s.Run = &run
	case "RUN_END":
		if p.Status != "completed" && p.Status != "failed" {
			return fmt.Errorf("invalid run status")
		}
		s.Run.Status = p.Status
		s.Run.EndedAt = ptr(e.WallTime)
	case "RUN_RESUME":
		s.Run.Status = "running"
		s.Run.EndedAt = nil
	case "AGENT_START":
		var a Agent
		if err := json.Unmarshal(e.Payload, &a); err != nil {
			return err
		}
		if a.ID == "" || a.RunID != e.RunID {
			return fmt.Errorf("invalid agent")
		}
		s.Agents[a.ID] = &a
	case "AGENT_END":
		if s.Agents[p.AgentID] == nil {
			return fmt.Errorf("unknown agent")
		}
		s.Agents[p.AgentID].Status = "completed"
	case "TASK_ATTEMPT_START":
		a := p.Attempt
		if s.Agents[a.AgentID] == nil || p.Task.RunID != e.RunID || a.TaskID != p.Task.ID || a.ID != val(e.AttemptID) || a.Number < 1 {
			return fmt.Errorf("invalid task attempt")
		}
		if a.RepairOf != nil {
			prior := s.Attempts[*a.RepairOf]
			if prior == nil || prior.Status == "running" || prior.TaskID != a.TaskID || prior.AgentID != a.AgentID || len(a.Frontier) != 0 || len(a.ObservedVersions) != 0 || len(a.ProducedVersions) != 0 {
				return fmt.Errorf("invalid repair attempt")
			}
		}
		if a.Frontier == nil {
			a.Frontier = map[string]string{}
		}
		if a.ObservedVersions == nil {
			a.ObservedVersions = []string{}
		}
		if a.ProducedVersions == nil {
			a.ProducedVersions = []string{}
		}
		s.Tasks[p.Task.ID] = &p.Task
		s.Attempts[a.ID] = &a
		s.Agents[a.AgentID].Status = "running"
	case "TASK_ATTEMPT_END":
		if p.Status != "completed" && p.Status != "failed" && p.Status != "invalidated" {
			return fmt.Errorf("invalid attempt status")
		}
		a := s.Attempts[val(e.AttemptID)]
		a.Status = p.Status
		a.EndedEventID = ptr(e.ID)
	case "RESOURCE_SNAPSHOT":
		if err := addVersion(s, p.Version, e); err != nil {
			return err
		}
	case "OBSERVE_RESOURCE":
		if err := observe(s, p.Observation); err != nil {
			return err
		}
	case "SEARCH_RESULT":
		for _, o := range p.Observations {
			if err := observe(s, o); err != nil {
				return err
			}
		}
	case "WRITE_INTENT":
		var i Intent
		if err := json.Unmarshal(e.Payload, &i); err != nil {
			return err
		}
		if i.AttemptID != val(e.AttemptID) || i.ID == "" {
			return fmt.Errorf("invalid intent")
		}
		for _, oid := range i.ObservationIDs {
			if s.Observations[oid].AttemptID != i.AttemptID {
				return fmt.Errorf("foreign observation")
			}
		}
		s.Intents[i.ID] = i
	case "WRITE_COMMIT", "DELETE_COMMIT":
		i, found := s.Intents[p.IntentID]
		if !found || i.AttemptID != val(e.AttemptID) || i.ResourceID != p.Version.ResourceID || !same(i.CandidateHash, p.Version.ContentHash) || !reflect.DeepEqual(i.ObservationIDs, p.ObservationIDs) || contains(s.SettledIntents, i.ID) {
			return fmt.Errorf("commit does not match captured intent")
		}
		hazards, err := DetectHazards(s, p.ObservationIDs, p.Version)
		if err != nil {
			return err
		}
		if err = addVersion(s, p.Version, e); err != nil {
			return err
		}
		s.Hazards = append(s.Hazards, hazards...)
		for _, oid := range p.ObservationIDs {
			o := s.Observations[oid]
			evidence := "MODEL_OBSERVATION"
			if s.Versions[o.VersionID].ResourceID == p.Version.ResourceID {
				evidence = "SAME_RESOURCE_BASE"
			}
			edge := Edge{stable("edge", p.Version.ID, oid), o.VersionID, p.Version.ID, oid, evidence}
			if err = AssertDerivation(edge, s.Versions); err != nil {
				return err
			}
			s.Edges = append(s.Edges, edge)
		}
		s.Attempts[val(e.AttemptID)].ProducedVersions = append(s.Attempts[val(e.AttemptID)].ProducedVersions, p.Version.ID)
		if err = observe(s, p.Observation); err != nil {
			return err
		}
		s.SettledIntents = append(s.SettledIntents, i.ID)
	case "NOOP_WRITE":
		i, found := s.Intents[p.IntentID]
		if !found || contains(s.SettledIntents, i.ID) || !same(s.Versions[p.Observation.VersionID].ContentHash, i.CandidateHash) {
			return fmt.Errorf("invalid no-op")
		}
		if err := observe(s, p.Observation); err != nil {
			return err
		}
		s.SettledIntents = append(s.SettledIntents, i.ID)
	case "WRITE_REJECTED":
		if _, found := s.Intents[p.IntentID]; !found || contains(s.SettledIntents, p.IntentID) {
			return fmt.Errorf("invalid rejected intent")
		}
		s.SettledIntents = append(s.SettledIntents, p.IntentID)
	case "SEMANTIC_ASSESSMENT":
		var a Assessment
		if err := json.Unmarshal(e.Payload, &a); err != nil {
			return err
		}
		found := false
		for _, h := range s.Hazards {
			if h.ID == a.HazardID {
				found = true
			}
		}
		if !found {
			return fmt.Errorf("unknown hazard")
		}
		s.Assessments[a.HazardID] = a
	case "LIST_RESOURCES", "COMMAND_START", "COMMAND_END", "TOOL_RESULT":
	default:
		return fmt.Errorf("unknown event kind: %s", e.Kind)
	}
	s.Seq = e.RuntimeSeq
	s.Events = append(s.Events, clone(e))
	return nil
}
func Replay(events []Event) (*State, error) {
	s := EmptyState()
	for _, e := range events {
		if err := ApplyEvent(s, e); err != nil {
			return nil, err
		}
	}
	return s, nil
}
