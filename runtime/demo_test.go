package ravel

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDemoObserveGuardRepair(t *testing.T) {
	for _, mode := range []string{"observe", "guard"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			store, err := OpenStore(filepath.Join(root, "store"))
			ok(t, err)
			defer store.Close()
			d, err := PrepareDemo(store, filepath.Join(root, "workspaces"), mode, false)
			ok(t, err)
			defer d.Coordinator.Close()
			ok(t, d.Execute(context.Background()))
			s := d.Coordinator.State()
			check(t, s.Versions[s.Heads["schema.sql"]].Generation == 18 && s.Versions[s.Heads["api/types.ts"]].Generation == 5 && s.Versions[s.Heads["frontend/client.ts"]].Generation == 9, "demo generations changed")
			var fixture struct {
				Events []Event `json:"events"`
			}
			data, err := os.ReadFile(filepath.Join("testdata", mode+".json"))
			ok(t, err)
			ok(t, json.Unmarshal(data, &fixture))
			check(t, len(s.Events) == len(fixture.Events), "demo event count changed")
			for i, e := range s.Events {
				check(t, e.Kind == fixture.Events[i].Kind, "demo event ordering changed")
			}
			if mode == "guard" {
				check(t, len(s.Hazards) == 0, "guard published stale output")
				retried := false
				for _, a := range s.Attempts {
					if a.Number == 2 {
						retried = true
					}
				}
				check(t, retried, "guard did not retry")
				return
			}
			check(t, len(s.Hazards) == 1, "missing demo hazard")
			h := s.Hazards[0]
			check(t, len(BlastRadius(h.ConsumerVersionID, s.Edges, s.Heads).Active) == 2, "wrong radius")
			before := clone(s)
			ok(t, RepairDemo(context.Background(), d.Coordinator))
			s = d.Coordinator.State()
			check(t, s.Versions[s.Heads["api/types.ts"]].Generation == 6 && s.Versions[s.Heads["frontend/client.ts"]].Generation == 10, "repair generations changed")
			sameJSON(t, s.Hazards, before.Hazards)
			check(t, len(BlastRadius(h.ConsumerVersionID, s.Edges, s.Heads).Active) == 0, "repair did not clean heads")
			events, err := store.Events(s.Run.ID, before.Seq)
			ok(t, err)
			replayed, err := Replay(events)
			ok(t, err)
			sameJSON(t, replayed, before)
		})
	}
}
func TestProjectionSemantics(t *testing.T) {
	root := t.TempDir()
	store, err := OpenStore(root)
	ok(t, err)
	defer store.Close()
	d, err := PrepareDemo(store, filepath.Join(root, "workspaces"), "observe", false)
	ok(t, err)
	defer d.Coordinator.Close()
	ok(t, d.Execute(context.Background()))
	p := Projector{store}
	h := d.Coordinator.State().Hazards[0]
	snapshot, err := p.Snapshot(d.Coordinator.RunID, h.DetectedSeq-1)
	ok(t, err)
	check(t, len(snapshot["hazards"].([]Object)) == 0, "future hazard leaked")
	_, err = p.Hazard(h.ID, h.DetectedSeq-1)
	check(t, err != nil, "future detail leaked")
	detail, err := p.Hazard(h.ID, h.DetectedSeq)
	ok(t, err)
	check(t, detail["assessment"] == nil, "future assessment leaked")
	plan, err := p.ReplayPlan(h.ID)
	ok(t, err)
	steps := plan["steps"].([]Object)
	check(t, len(steps) == 5 && steps[1]["openStaleWindow"] == true && steps[2]["closeStaleWindow"] == true, "focused replay changed")
}
