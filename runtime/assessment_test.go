package ravel

import "testing"

func TestExternalAssessmentIsAppendOnlyAnnotation(t *testing.T) {
	s, _ := serviceFixture(t)
	runs, err := s.Store.Runs()
	ok(t, err)
	c, err := s.coordinator(runs[0].ID)
	ok(t, err)
	before := c.State()
	id := before.Hazards[0].ID
	history, err := s.Projector.Snapshot(c.RunID, before.Seq)
	ok(t, err)
	updates, unsubscribe := c.Subscribe()
	defer unsubscribe()
	status, result := request(t, s, "POST", "/api/hazards/"+id+"/assessments", Object{
		"analyzer": "gemini/test-model", "relevance": "CONFLICT",
		"reason": "UUID input contradicts the numeric consumer type.", "affectedElements": []string{"User.id"},
	})
	check(t, status == 200, "assessment request failed")
	assessment := result.(map[string]any)["assessment"].(map[string]any)
	check(t, assessment["analyzer"] == "gemini/test-model" && assessment["assessedSeq"] == float64(before.Seq+1), "assessment attribution lost")
	after := c.State()
	sameJSON(t, before.Versions, after.Versions)
	sameJSON(t, before.Heads, after.Heads)
	sameJSON(t, before.Hazards, after.Hazards)
	sameJSON(t, before.Edges, after.Edges)
	previous, err := s.Projector.Snapshot(c.RunID, before.Seq)
	ok(t, err)
	// The historical view still advertises the current live cursor for navigation.
	history["latestRuntimeSeq"] = after.Seq
	sameJSON(t, history, previous)
	select {
	case event := <-updates:
		check(t, event.Kind == "SEMANTIC_ASSESSMENT", "annotation not emitted to stream")
	default:
		t.Fatal("missing annotation event")
	}
}

func TestExternalAssessmentValidation(t *testing.T) {
	s, _ := serviceFixture(t)
	runs, err := s.Store.Runs()
	ok(t, err)
	c, err := s.coordinator(runs[0].ID)
	ok(t, err)
	before := c.State()
	id := before.Hazards[0].ID
	for _, input := range []Object{
		{},
		{"analyzer": "gemini", "relevance": "CERTAIN", "reason": "reason", "affectedElements": []string{}},
		{"analyzer": "gemini", "relevance": "LIKELY", "reason": "", "affectedElements": []string{}},
		{"analyzer": "gemini", "relevance": "LIKELY", "reason": "reason", "affectedElements": nil},
		{"analyzer": "gemini", "relevance": "LIKELY", "reason": "reason", "affectedElements": []string{""}},
		{"id": "forged", "analyzer": "gemini", "relevance": "LIKELY", "reason": "reason", "affectedElements": []string{}},
	} {
		status, _ := request(t, s, "POST", "/hazards/"+id+"/assessments", input)
		check(t, status == 400, "invalid assessment accepted")
	}
	sameJSON(t, before, c.State())
	status, _ := request(t, s, "POST", "/hazards/missing/assessments", Object{
		"analyzer": "gemini", "relevance": "POSSIBLE", "reason": "reason", "affectedElements": []string{},
	})
	check(t, status == 404, "unknown hazard accepted")
}
