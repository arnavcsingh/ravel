package ravel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func must[T any](t *testing.T, value T, err error) T {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
func ok(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func check(t *testing.T, condition bool, message string) {
	t.Helper()
	if !condition {
		t.Fatal(message)
	}
}
func sameJSON(t *testing.T, got, want any) {
	t.Helper()
	a, _ := json.Marshal(got)
	b, _ := json.Marshal(want)
	var av, bv any
	_ = json.Unmarshal(a, &av)
	_ = json.Unmarshal(b, &bv)
	if !reflect.DeepEqual(av, bv) {
		t.Fatalf("JSON mismatch\ngot: %s\nwant: %s", a, b)
	}
}

// Fixtures were captured from the unchanged 35-test TypeScript baseline.
func TestBaselineGoldenReplay(t *testing.T) {
	for _, name := range []string{"observe", "guard", "repair", "held"} {
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata", name+".json"))
			ok(t, err)
			var fixture struct {
				Events    []Event           `json:"events"`
				Snapshots []json.RawMessage `json:"snapshots"`
				Snapshot  json.RawMessage   `json:"snapshot"`
				Content   map[string]string `json:"content"`
				Hazards   []json.RawMessage `json:"hazards"`
				Plans     []json.RawMessage `json:"plans"`
			}
			ok(t, json.Unmarshal(data, &fixture))
			store, err := OpenStore(t.TempDir())
			ok(t, err)
			defer store.Close()
			for hash, content := range fixture.Content {
				key, err := store.PutBlob([]byte(content))
				ok(t, err)
				check(t, key == hash, "blob identity changed")
			}
			state := EmptyState()
			for _, event := range fixture.Events {
				ok(t, ApplyEvent(state, event))
				ok(t, store.Commit(event, state))
			}
			projector := Projector{Store: store}
			runID := state.Run.ID
			for i, want := range fixture.Snapshots {
				got, err := projector.Snapshot(runID, i+1)
				ok(t, err)
				sameJSON(t, got, json.RawMessage(want))
			}
			if fixture.Snapshot != nil {
				got, err := projector.Snapshot(runID, 0)
				ok(t, err)
				sameJSON(t, got, fixture.Snapshot)
			}
			for i, h := range state.Hazards {
				got, err := projector.Hazard(h.ID, 0)
				ok(t, err)
				sameJSON(t, got, fixture.Hazards[i])
				plan, err := projector.ReplayPlan(h.ID)
				ok(t, err)
				sameJSON(t, plan, fixture.Plans[i])
			}
		})
	}
}
