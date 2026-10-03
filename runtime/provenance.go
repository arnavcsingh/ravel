package ravel

import "fmt"

type StaleInput struct {
	Observation                Observation
	Observed, Head, StaleSince Version
}

func StaleInputs(s *State, ids []string) ([]StaleInput, error) {
	out := []StaleInput{}
	for _, oid := range ids {
		o, found := s.Observations[oid]
		if !found {
			return nil, fmt.Errorf("unknown observation")
		}
		observed := s.Versions[o.VersionID]
		head, found := s.Versions[s.Heads[observed.ResourceID]]
		if !found {
			return nil, fmt.Errorf("missing resource head")
		}
		if same(observed.ContentHash, head.ContentHash) {
			continue
		}
		start := head
		for start.PreviousVersionID != nil {
			previous, found := s.Versions[*start.PreviousVersionID]
			if !found {
				return nil, fmt.Errorf("broken version succession")
			}
			if same(previous.ContentHash, observed.ContentHash) || previous.CreationSeq < observed.CreationSeq {
				break
			}
			start = previous
		}
		out = append(out, StaleInput{o, observed, head, start})
	}
	return out, nil
}
func DetectHazards(s *State, ids []string, output Version) ([]Hazard, error) {
	inputs, err := StaleInputs(s, ids)
	if err != nil {
		return nil, err
	}
	hazards := []Hazard{}
	for _, i := range inputs {
		var invalidator *string
		if i.StaleSince.ProducerAttemptID != nil {
			invalidator = ptr(s.Attempts[*i.StaleSince.ProducerAttemptID].AgentID)
		}
		evidence := "MODEL_OBSERVATION"
		if i.Observed.ResourceID == output.ResourceID {
			evidence = "SAME_RESOURCE_BASE"
		}
		hazards = append(hazards, Hazard{stable("hazard", output.ID, i.Observation.ID), i.Observed.ID, i.StaleSince.ID, i.Head.ID, output.ID, i.Observation.ID, s.Attempts[i.Observation.AttemptID].AgentID, invalidator, evidence, output.CreationSeq})
	}
	return hazards, nil
}
func AssertDerivation(e Edge, versions map[string]Version) error {
	source, ok := versions[e.SourceVersionID]
	target, ok2 := versions[e.TargetVersionID]
	if !ok || !ok2 {
		return fmt.Errorf("unknown resource version")
	}
	if source.CreationSeq >= target.CreationSeq {
		return fmt.Errorf("provenance cycle or backward derivation")
	}
	return nil
}

type Radius struct {
	Historical []string `json:"historical"`
	Active     []string `json:"active"`
}

func BlastRadius(root string, edges []Edge, heads map[string]string) Radius {
	children := map[string][]string{}
	for _, e := range edges {
		children[e.SourceVersionID] = append(children[e.SourceVersionID], e.TargetVersionID)
	}
	r := Radius{[]string{root}, []string{}}
	seen := map[string]bool{root: true}
	for i := 0; i < len(r.Historical); i++ {
		for _, child := range children[r.Historical[i]] {
			if !seen[child] {
				seen[child] = true
				r.Historical = append(r.Historical, child)
			}
		}
	}
	current := map[string]bool{}
	for _, id := range heads {
		current[id] = true
	}
	for _, id := range r.Historical {
		if current[id] {
			r.Active = append(r.Active, id)
		}
	}
	return r
}
