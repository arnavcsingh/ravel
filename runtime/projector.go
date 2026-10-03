package ravel

import (
	"encoding/json"
	"fmt"
	"path"
	"strings"
)

type Object map[string]any
type Projector struct{ Store *Store }

func object(v any) Object { var out Object; _ = json.Unmarshal([]byte(body(v)), &out); return out }
func (p Projector) State(runID string, seq int) (*State, error) {
	events, err := p.Store.Events(runID, seq)
	if err != nil {
		return nil, err
	}
	s, err := Replay(events)
	if err != nil {
		return nil, err
	}
	if s.Run == nil {
		return nil, fmt.Errorf("run not found")
	}
	return s, nil
}
func summaries(s *State) []Object {
	out := []Object{}
	for _, h := range s.Hazards {
		r := BlastRadius(h.ConsumerVersionID, s.Edges, s.Heads)
		m := object(h)
		m["observed"] = s.Versions[h.ObservedVersionID]
		m["invalidating"] = s.Versions[h.StaleSinceVersionID]
		m["consumer"] = s.Versions[h.ConsumerVersionID]
		m["observerName"] = s.Agents[h.ObservingAgentID].Name
		m["invalidatorName"] = "Repository"
		if h.InvalidatingAgentID != nil {
			m["invalidatorName"] = s.Agents[*h.InvalidatingAgentID].Name
		}
		m["active"] = len(r.Active) > 0
		m["historicalBlastRadius"] = r.Historical
		m["activeBlastRadius"] = r.Active
		m["assessment"] = nil
		if a, exists := s.Assessments[h.ID]; exists {
			m["assessment"] = a
		}
		out = append(out, m)
	}
	return out
}
func eventSeq(s *State, id string) int {
	for _, e := range s.Events {
		if e.ID == id {
			return e.RuntimeSeq
		}
	}
	return 0
}
func hazardIDs(hazards []Hazard, predicate func(Hazard) bool) []string {
	ids := []string{}
	for _, h := range hazards {
		if predicate(h) {
			ids = append(ids, h.ID)
		}
	}
	return ids
}
func (p Projector) Snapshot(runID string, seq int) (Object, error) {
	all, err := p.Store.Events(runID, 0)
	if err != nil {
		return nil, err
	}
	events := all
	if seq > 0 {
		events = []Event{}
		for _, e := range all {
			if e.RuntimeSeq <= seq {
				events = append(events, e)
			}
		}
	}
	s, err := Replay(events)
	if err != nil {
		return nil, err
	}
	if s.Run == nil {
		return nil, fmt.Errorf("run not found")
	}
	hazards := summaries(s)
	states := map[string]string{}
	for id := range s.Versions {
		states[id] = "CLEAN"
	}
	for _, h := range hazards {
		for _, id := range h["historicalBlastRadius"].([]string) {
			states[id] = "DOWNSTREAM"
		}
	}
	for _, h := range s.Hazards {
		if states[h.ConsumerVersionID] == "SEMANTIC_CONFLICT" {
			continue
		}
		states[h.ConsumerVersionID] = "STALE_INPUT"
		if s.Assessments[h.ID].Relevance == "CONFLICT" {
			states[h.ConsumerVersionID] = "SEMANTIC_CONFLICT"
		}
	}
	resources := []string{}
	versions := orderedVersions(s)
	for _, v := range versions {
		if !contains(resources, v.ResourceID) {
			resources = append(resources, v.ResourceID)
		}
	}
	nodes := []Object{}
	edges := []Object{}
	for _, v := range versions {
		x, y := 0, 0
		for i, r := range resources {
			if r == v.ResourceID {
				x = i * 270
			}
		}
		for _, other := range versions {
			if other.ResourceID == v.ResourceID && other.Generation < v.Generation {
				y += 120
			}
		}
		ids := []string{}
		for _, h := range hazards {
			if contains(h["historicalBlastRadius"].([]string), v.ID) || h["observedVersionId"] == v.ID || h["staleSinceVersionId"] == v.ID {
				ids = append(ids, h["id"].(string))
			}
		}
		nodes = append(nodes, Object{"id": v.ID, "label": fmt.Sprintf("%s@%d", path.Base(v.ResourceID), v.Generation), "resourceId": v.ResourceID, "generation": v.Generation, "state": states[v.ID], "currentHead": s.Heads[v.ResourceID] == v.ID, "tombstone": v.Tombstone, "x": x, "y": y, "hazardIds": ids})
	}
	for _, e := range s.Edges {
		edges = append(edges, Object{"id": e.ID, "source": e.SourceVersionID, "target": e.TargetVersionID, "kind": "DERIVED_FROM", "label": strings.ToLower(strings.ReplaceAll(e.Evidence, "_", " "))})
	}
	for _, v := range versions {
		if v.PreviousVersionID != nil {
			edges = append(edges, Object{"id": stable("succession", v.ID), "source": *v.PreviousVersionID, "target": v.ID, "kind": "VERSION_SUCCESSOR", "label": "next version"})
		}
	}
	timeline := []Object{}
	for _, e := range s.Events {
		var payload Payload
		_ = json.Unmarshal(e.Payload, &payload)
		id, action, verb := "", "", ""
		switch e.Kind {
		case "OBSERVE_RESOURCE":
			id = payload.Observation.VersionID
			action = "OBSERVE"
			verb = "observed"
		case "WRITE_COMMIT":
			id = payload.Version.ID
			action = "WRITE"
			verb = "produced"
		case "DELETE_COMMIT":
			id = payload.Version.ID
			action = "DELETE"
			verb = "deleted"
		}
		if id == "" {
			continue
		}
		v := s.Versions[id]
		name := "Runtime"
		if a := s.Agents[val(e.AgentID)]; a != nil {
			name = a.Name
		}
		state := states[id]
		if action == "OBSERVE" {
			state = "CLEAN"
		}
		timeline = append(timeline, Object{"id": e.ID, "runtimeSeq": e.RuntimeSeq, "agentId": e.AgentID, "agentName": name, "action": action, "description": fmt.Sprintf("%s %s %s@%d", name, verb, v.ResourceID, v.Generation), "versionId": id, "resourceId": v.ResourceID, "state": state, "hazardIds": hazardIDs(s.Hazards, func(h Hazard) bool {
			return h.ConsumerVersionID == id || (e.Kind == "OBSERVE_RESOURCE" && h.ObservationID == payload.Observation.ID)
		})})
	}
	windows := []Object{}
	affected := map[string]bool{}
	for _, h := range s.Hazards {
		windows = append(windows, staleWindow(s, h))
		r := BlastRadius(h.ConsumerVersionID, s.Edges, s.Heads)
		for _, id := range r.Active {
			affected[id] = true
		}
	}
	for _, e := range s.Events {
		if e.Kind != "WRITE_INTENT" {
			continue
		}
		var i Intent
		_ = json.Unmarshal(e.Payload, &i)
		if contains(s.SettledIntents, i.ID) {
			continue
		}
		inputs, err := StaleInputs(s, i.ObservationIDs)
		if err != nil {
			return nil, err
		}
		for _, input := range inputs {
			windows = append(windows, Object{"hazardId": i.ID, "agentId": s.Attempts[i.AttemptID].AgentID, "observedSeq": eventSeq(s, input.Observation.EventID), "startSeq": input.StaleSince.CreationSeq, "endSeq": s.Seq, "resourceId": input.Observed.ResourceID})
		}
	}
	rejected, retries := 0, 0
	for _, e := range s.Events {
		if e.Kind == "WRITE_REJECTED" {
			rejected++
		}
	}
	for _, a := range s.Attempts {
		if a.Number > 1 {
			retries++
		}
	}
	latest := 0
	if len(all) > 0 {
		latest = all[len(all)-1].RuntimeSeq
	}
	return Object{"run": s.Run, "agents": orderedAgents(s), "timeline": timeline, "graph": Object{"nodes": nodes, "edges": edges}, "hazards": hazards, "staleWindows": windows, "currentRuntimeSeq": s.Seq, "latestRuntimeSeq": latest, "activeAffectedCount": len(affected), "eventCount": len(events), "heads": s.Heads, "canRepair": val(s.Run.Scenario) == "identifier-migration" && s.Run.Status == "completed" && len(affected) > 0 && retries == 0, "guard": Object{"rejectedWrites": rejected, "retries": retries}}, nil
}
func staleWindow(s *State, h Hazard) Object {
	return Object{"hazardId": h.ID, "agentId": h.ObservingAgentID, "observedSeq": eventSeq(s, s.Observations[h.ObservationID].EventID), "startSeq": s.Versions[h.StaleSinceVersionID].CreationSeq, "endSeq": s.Versions[h.ConsumerVersionID].CreationSeq, "resourceId": s.Versions[h.ObservedVersionID].ResourceID}
}
func (p Projector) Hazard(id string, seq int) (Object, error) {
	runID, err := p.Store.RunForEntity("hazards", id)
	if err != nil {
		return nil, err
	}
	s, err := p.State(runID, seq)
	if err != nil {
		return nil, err
	}
	var summary Object
	var hazard Hazard
	for i, h := range s.Hazards {
		if h.ID == id {
			hazard = h
			summary = summaries(s)[i]
			break
		}
	}
	if summary == nil {
		return nil, fmt.Errorf("hazard not found at this point in trace")
	}
	observed, err := p.Store.Content(s.Versions[hazard.ObservedVersionID])
	if err != nil {
		return nil, err
	}
	head := s.Versions[hazard.ValidationHeadVersionID]
	current, err := p.Store.Content(head)
	if err != nil {
		return nil, err
	}
	consumer := s.Versions[hazard.ConsumerVersionID]
	content, err := p.Store.Content(consumer)
	if err != nil {
		return nil, err
	}
	summary["runId"] = runID
	summary["observedContent"] = observed
	summary["currentContent"] = current
	summary["consumerContent"] = content
	summary["validationHead"] = head
	left, right := "(absent)\n", "(absent)\n"
	if observed != nil {
		left = *observed
	}
	if current != nil {
		right = *current
	}
	summary["diff"] = DiffLines(left, right)
	summary["observationSeq"] = eventSeq(s, s.Observations[hazard.ObservationID].EventID)
	summary["staleWindow"] = staleWindow(s, hazard)
	summary["taskName"] = s.Tasks[s.Attempts[val(consumer.ProducerAttemptID)].TaskID].Name
	return summary, nil
}
func (p Projector) ReplayPlan(id string) (Object, error) {
	detail, err := p.Hazard(id, 0)
	if err != nil {
		return nil, err
	}
	runID := detail["runId"].(string)
	s, err := p.State(runID, 0)
	if err != nil {
		return nil, err
	}
	snapshot, err := p.Snapshot(runID, 0)
	if err != nil {
		return nil, err
	}
	var h Hazard
	for _, v := range s.Hazards {
		if v.ID == id {
			h = v
			break
		}
	}
	affected := detail["historicalBlastRadius"].([]string)
	observedEvent := s.Observations[h.ObservationID].EventID
	invalidating := s.Versions[h.StaleSinceVersionID].CreatedEventID
	consumer := s.Versions[h.ConsumerVersionID].CreatedEventID
	eventIDs := map[string]bool{observedEvent: true, invalidating: true}
	for _, v := range affected {
		eventIDs[s.Versions[v].CreatedEventID] = true
	}
	for _, edge := range s.Edges {
		if contains(affected, edge.SourceVersionID) && contains(affected, edge.TargetVersionID) {
			eventIDs[s.Observations[edge.ObservationID].EventID] = true
		}
	}
	steps := []Object{}
	for _, e := range s.Events {
		if !eventIDs[e.ID] {
			continue
		}
		item := Object{"agentName": "Runtime", "action": e.Kind, "description": e.Kind}
		for _, v := range snapshot["timeline"].([]Object) {
			if v["id"] == e.ID {
				item = v
				break
			}
		}
		annotation := "Candidate provenance carries the impact downstream."
		switch {
		case e.ID == observedEvent:
			annotation = "The agent now knows this input version."
		case e.ID == invalidating:
			annotation = "The observed content becomes stale here."
		case e.ID == consumer:
			annotation = "The held output is committed using the stale observation."
		case item["action"] == "OBSERVE":
			annotation = "Another agent observes the stale-derived artifact."
		}
		nodes, edges := []string{}, []string{}
		if vid, ok := item["versionId"].(string); ok {
			nodes = append(nodes, vid)
			for _, edge := range snapshot["graph"].(Object)["edges"].([]Object) {
				if edge["kind"] == "DERIVED_FROM" && edge["target"] == vid {
					edges = append(edges, edge["id"].(string))
				}
			}
		}
		steps = append(steps, Object{"runtimeSeq": e.RuntimeSeq, "agent": item["agentName"], "action": item["action"], "description": item["description"], "annotation": annotation, "highlightNodes": nodes, "highlightEdges": edges, "openStaleWindow": e.ID == invalidating, "closeStaleWindow": e.ID == consumer})
	}
	return Object{"runId": runID, "hazardId": id, "steps": steps}, nil
}
func (p Projector) Version(id string) (Object, error) {
	runID, err := p.Store.RunForEntity("resource_versions", id)
	if err != nil {
		return nil, err
	}
	s, err := p.State(runID, 0)
	if err != nil {
		return nil, err
	}
	v := s.Versions[id]
	content, err := p.Store.Content(v)
	if err != nil {
		return nil, err
	}
	out := object(v)
	out["content"] = content
	out["runId"] = runID
	return out, nil
}
