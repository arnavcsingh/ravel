package ravel

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func serviceFixture(t *testing.T) (*Service, *httptest.Server) {
	t.Helper()
	s, err := NewService(filepath.Join(t.TempDir(), "data"), "", true)
	ok(t, err)
	server := httptest.NewServer(s)
	t.Cleanup(func() { server.Close(); _ = s.Close() })
	return s, server
}

type drainedResponse struct {
	*httptest.ResponseRecorder
	body *strings.Reader
	t    *testing.T
}

func (w drainedResponse) WriteHeader(status int) {
	if w.body.Len() != 0 {
		w.t.Fatal("response started before control request body was drained")
	}
	w.ResponseRecorder.WriteHeader(status)
}
func TestControlRequestBodyDrained(t *testing.T) {
	s, _ := serviceFixture(t)
	reader := strings.NewReader("{}")
	r := httptest.NewRequest("POST", "/api/runs/missing/end", reader)
	w := drainedResponse{httptest.NewRecorder(), reader, t}
	s.ServeHTTP(w, r)
	check(t, w.Code == 404, "missing run status changed")
}
func request(t *testing.T, s *Service, method, path string, payload any) (int, any) {
	t.Helper()
	var data []byte
	if payload != nil {
		data = []byte(body(payload))
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var out any
	ok(t, json.Unmarshal(w.Body.Bytes(), &out))
	return w.Code, out
}
func TestDebuggerAPI(t *testing.T) {
	s, _ := serviceFixture(t)
	runs, err := s.Store.Runs()
	ok(t, err)
	runID := runs[0].ID
	status, out := request(t, s, "GET", "/api/health", nil)
	check(t, status == 200 && out.(map[string]any)["runtime"] == "go", "health failed")
	status, out = request(t, s, "GET", "/api/runs/"+runID+"/debugger", nil)
	check(t, status == 200, "snapshot failed")
	hazards := out.(map[string]any)["hazards"].([]any)
	check(t, len(hazards) == 1, "missing hazard")
	id := hazards[0].(map[string]any)["id"].(string)
	status, out = request(t, s, "GET", "/api/hazards/"+id, nil)
	check(t, status == 200 && strings.Contains(out.(map[string]any)["observedContent"].(string), "INTEGER"), "detail failed")
	consumer := out.(map[string]any)["consumerVersionId"].(string)
	status, out = request(t, s, "GET", "/api/hazards/"+id+"/replay", nil)
	check(t, status == 200 && len(out.(map[string]any)["steps"].([]any)) == 5, "replay failed")
	status, _ = request(t, s, "GET", "/api/versions/"+consumer+"/content", nil)
	check(t, status == 200, "version endpoint failed")
	status, _ = request(t, s, "GET", "/api/runs/"+runID+"/debugger?seq=0", nil)
	check(t, status == 400, "invalid sequence accepted")
	status, _ = request(t, s, "GET", "/api/runs/missing/debugger", nil)
	check(t, status == 404, "missing run wrong status")
	r := httptest.NewRequest("POST", "/api/demo", nil)
	r.Header.Set("Origin", "https://foreign.example")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	check(t, w.Code == 403, "foreign mutation allowed")
	status, out = request(t, s, "POST", "/api/hazards/"+id+"/repair", nil)
	check(t, status == 200 && out.(map[string]any)["activeAffectedCount"] == float64(0), "repair failed")
}
func TestInteractiveAPI(t *testing.T) {
	s, _ := serviceFixture(t)
	status, out := request(t, s, "POST", "/api/demo", Object{"interactive": true})
	check(t, status == 201, "demo start failed")
	id := out.(map[string]any)["runId"].(string)
	s.mu.Lock()
	d := s.demos[id]
	s.mu.Unlock()
	events, cancel := d.Coordinator.Subscribe()
	defer cancel()
	timeout := time.NewTimer(3 * time.Second)
	defer timeout.Stop()
	for d.Status()["phase"] != "held" {
		select {
		case <-events:
		case <-timeout.C:
			t.Fatal("demo did not hold")
		}
	}
	snapshot, err := s.Projector.Snapshot(id, 0)
	ok(t, err)
	check(t, len(snapshot["hazards"].([]Object)) == 0 && len(snapshot["staleWindows"].([]Object)) == 1, "held projection invalid")
	status, _ = request(t, s, "POST", "/api/runs/"+id+"/release", nil)
	check(t, status == 200, "release failed")
	<-d.Done()
	snapshot, err = s.Projector.Snapshot(id, 0)
	ok(t, err)
	check(t, len(snapshot["hazards"].([]Object)) == 1, "released hazard missing")
}
func TestSSEReconnect(t *testing.T) {
	s, server := serviceFixture(t)
	runs, err := s.Store.Runs()
	ok(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/runs/"+runs[0].ID+"/stream", nil)
	ok(t, err)
	req.Header.Set("Last-Event-ID", "1")
	response, err := http.DefaultClient.Do(req)
	ok(t, err)
	defer response.Body.Close()
	check(t, response.Header.Get("Content-Type") == "text/event-stream", "not SSE")
	reader := bufio.NewReader(response.Body)
	text := ""
	for !strings.Contains(text, "data:") {
		line, err := reader.ReadString('\n')
		ok(t, err)
		text += line
	}
	check(t, strings.Contains(text, "id: 2") && strings.Contains(text, runs[0].ID), "cursor/run isolation failed")
}
func TestMediatedOperations(t *testing.T) {
	s, _ := serviceFixture(t)
	status, out := request(t, s, "POST", "/api/runs", Object{"name": "HTTP agents", "mode": "guard", "files": Object{"input": "A"}})
	check(t, status == 201, "run creation failed")
	runID := out.(map[string]any)["runId"].(string)
	prefix := "/api/runs/" + runID
	_, out = request(t, s, "POST", prefix+"/agents", Object{"name": "Python"})
	agent := out.(map[string]any)["agentId"].(string)
	_, out = request(t, s, "POST", prefix+"/attempts", Object{"agentId": agent, "name": "Generate"})
	attempt := out.(map[string]any)["id"].(string)
	base := prefix + "/attempts/" + attempt
	status, out = request(t, s, "POST", base+"/observe_resource", Object{"path": "input"})
	check(t, status == 200 && out.(map[string]any)["content"] == "A", "observe failed")
	version := out.(map[string]any)["version"].(map[string]any)["id"].(string)
	status, _ = request(t, s, "POST", base+"/apply_patch", Object{"path": "input", "baseVersionId": version, "patch": "--- input\n+++ input\n@@ -1 +1 @@\n-A\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n"})
	check(t, status == 200, "patch endpoint failed")
	status, out = request(t, s, "POST", base+"/list_resources", nil)
	check(t, status == 200 && len(out.([]any)) == 1, "list failed")
	status, out = request(t, s, "POST", base+"/search_repository", Object{"query": "B"})
	check(t, status == 200 && len(out.([]any)) == 1, "search failed")
	status, _ = request(t, s, "POST", base+"/write_resource", Object{"path": "input"})
	check(t, status == 400, "omitted content deleted resource")
	status, out = request(t, s, "POST", base+"/write_intent", Object{"path": "output", "content": "B"})
	check(t, status == 200, "intent failed")
	intent := out.(map[string]any)["id"].(string)
	_, other := request(t, s, "POST", prefix+"/attempts", Object{"agentId": agent, "name": "Other"})
	otherBase := prefix + "/attempts/" + other.(map[string]any)["id"].(string)
	status, _ = request(t, s, "POST", otherBase+"/commit_write", Object{"intentId": intent})
	check(t, status == 400, "foreign attempt committed intent")
	status, out = request(t, s, "POST", base+"/commit_write", Object{"intentId": intent})
	check(t, status == 200 && out.(map[string]any)["committed"] == true, "commit failed")
	status, _ = request(t, s, "POST", base+"/complete", nil)
	check(t, status == 200, "completion failed")
	request(t, s, "POST", otherBase+"/complete", nil)
	status, _ = request(t, s, "POST", prefix+"/end", nil)
	check(t, status == 200, "end failed")
	status, _ = request(t, s, "GET", "/runs/"+runID+"/debugger", nil)
	check(t, status == 200, "bare API alias failed")
}
func TestSSELiveAndShutdown(t *testing.T) {
	s, server := serviceFixture(t)
	status, out := request(t, s, "POST", "/api/runs", Object{"name": "stream", "files": Object{}})
	check(t, status == 201, "run create failed")
	id := out.(map[string]any)["runId"].(string)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/runs/"+id+"/stream", nil)
	response, err := http.DefaultClient.Do(req)
	ok(t, err)
	reader := bufio.NewReader(response.Body)
	for {
		line, err := reader.ReadString('\n')
		ok(t, err)
		if line == "\n" {
			break
		}
	}
	c, err := s.coordinator(id)
	ok(t, err)
	_, err = c.CreateAgent("live", "")
	ok(t, err)
	frame := ""
	for {
		line, err := reader.ReadString('\n')
		ok(t, err)
		frame += line
		if line == "\n" {
			break
		}
	}
	check(t, strings.Contains(frame, "AGENT_START"), "live update missing")
	cancel()
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
}
