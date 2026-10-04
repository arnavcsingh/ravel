package ravel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"ravel/runtime/projection"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Service struct {
	Store        *Store
	Projector    Projector
	root         string
	mu           sync.Mutex
	startMu      sync.Mutex
	coordinators map[string]*Coordinator
	demos        map[string]*Demo
	repairing    map[string]bool
	ctx          context.Context
	cancel       context.CancelFunc
	jobs         sync.WaitGroup
	handler      http.Handler
	liveConfig   Object
	liveStatus   *ProjectionStatus
}

func NewService(directory, staticRoot string, seed bool) (*Service, error) {
	directory, err := filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	store, err := OpenStore(directory)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{Store: store, Projector: Projector{store}, root: filepath.Join(directory, "workspaces"), coordinators: map[string]*Coordinator{}, demos: map[string]*Demo{}, repairing: map[string]bool{}, ctx: ctx, cancel: cancel}
	s.routes(staticRoot)
	if seed {
		runs, err := store.Runs()
		if err != nil {
			s.Close()
			return nil, err
		}
		if len(runs) == 0 {
			demo, err := s.startDemo("observe", false)
			if err != nil {
				s.Close()
				return nil, err
			}
			<-demo.Done()
			status := demo.Status()
			if status["phase"] == "failed" {
				s.Close()
				return nil, fmt.Errorf("demo failed: %v", status["error"])
			}
		}
	}
	return s, nil
}
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		origin := r.Header.Get("Origin")
		if origin != "" && origin != "http://"+r.Host {
			writeJSON(w, 403, Object{"error": "Cross-origin mutation is not allowed."})
			return
		}
		// Drain the bounded request before writing any response, including control
		// routes without a JSON payload. Closing a short-lived connection while
		// request bytes remain unread can reset the connection on Windows.
		payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			writeJSON(w, 400, Object{"error": "invalid or oversized request body"})
			return
		}
		r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(payload))
	}
	s.handler.ServeHTTP(w, r)
}
func (s *Service) Close() error {
	s.cancel()
	s.jobs.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.coordinators {
		c.Close()
	}
	return s.Store.Close()
}
func (s *Service) coordinator(runID string) (*Coordinator, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c := s.coordinators[runID]; c != nil {
		return c, nil
	}
	state, err := s.Projector.State(runID, 0)
	if err != nil {
		return nil, err
	}
	workspace, err := filepath.Abs(state.Run.Workspace)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(workspace, s.root+string(filepath.Separator)) {
		return nil, fmt.Errorf("run workspace outside managed directory")
	}
	c, err := NewCoordinator(s.Store, workspace, runID)
	if err != nil {
		return nil, err
	}
	s.coordinators[runID] = c
	return c, nil
}
func (s *Service) startDemo(mode string, interactive bool) (*Demo, error) {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	s.mu.Lock()
	for _, d := range s.demos {
		phase := d.Status()["phase"]
		if phase == "ready" || phase == "running" || phase == "held" {
			s.mu.Unlock()
			return nil, httpError{409, "a demo is already active"}
		}
	}
	s.mu.Unlock()
	d, err := PrepareDemo(s.Store, s.root, mode, interactive)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.demos[d.Coordinator.RunID] = d
	s.coordinators[d.Coordinator.RunID] = d.Coordinator
	s.mu.Unlock()
	s.jobs.Add(1)
	go func() { defer s.jobs.Done(); _ = d.Execute(s.ctx) }()
	return d, nil
}

type httpError struct {
	code    int
	message string
}

func (e httpError) Error() string { return e.message }
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func respond(w http.ResponseWriter, value any, err error) {
	if err == nil {
		writeJSON(w, 200, value)
		return
	}
	status := 400
	var h httpError
	if errors.As(err, &h) {
		status = h.code
	} else if strings.Contains(strings.ToLower(err.Error()), "not found") {
		status = 404
	}
	writeJSON(w, status, Object{"error": err.Error()})
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		if err == io.EOF {
			return nil
		}
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return fmt.Errorf("request must contain one JSON object")
	}
	return nil
}
func sequence(r *http.Request) (int, error) {
	v := r.URL.Query().Get("seq")
	if v == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("seq must be a positive integer")
	}
	return n, nil
}
func (s *Service) routes(staticRoot string) {
	mux := http.NewServeMux()
	s.handler = mux
	mux.Handle("GET /api/live-demo/", liveDemoProxy())
	mux.Handle("POST /api/live-demo/", liveDemoProxy())
	route := func(method, path string, h http.HandlerFunc) {
		mux.HandleFunc(method+" /api"+path, h)
		mux.HandleFunc(method+" "+path, h)
	}
	route("GET", "/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, Object{"status": "ok", "version": "0.3.0", "runtime": "go", "integrations": []Object{{"name": "Gemini", "enabled": false, "configured": strings.TrimSpace(os.Getenv("GEMINI_API_KEY")) != "", "reason": "Available through pnpm gemini in Python; the Go runtime does not invoke providers."}, s.projectionInfo(), {"name": "Fetch", "enabled": false, "configured": strings.TrimSpace(os.Getenv("AGENTVERSE_AGENT_URI")) != "", "reason": "Optional Python Inspector; started separately."}}})
	})
	route("GET", "/live", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.projectionInfo()) })
	route("GET", "/runs", func(w http.ResponseWriter, r *http.Request) { v, err := s.Store.Runs(); respond(w, v, err) })
	route("GET", "/runs/{runId}/debugger", func(w http.ResponseWriter, r *http.Request) {
		seq, err := sequence(r)
		if err != nil {
			respond(w, nil, err)
			return
		}
		v, err := s.Projector.Snapshot(r.PathValue("runId"), seq)
		respond(w, v, err)
	})
	route("GET", "/runs/{runId}/events", func(w http.ResponseWriter, r *http.Request) {
		seq, err := sequence(r)
		if err != nil {
			respond(w, nil, err)
			return
		}
		if _, err = s.Projector.State(r.PathValue("runId"), 0); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := s.Store.Events(r.PathValue("runId"), seq)
		respond(w, v, err)
	})
	route("GET", "/hazards/{hazardId}", func(w http.ResponseWriter, r *http.Request) {
		seq, err := sequence(r)
		if err != nil {
			respond(w, nil, err)
			return
		}
		v, err := s.Projector.Hazard(r.PathValue("hazardId"), seq)
		respond(w, v, err)
	})
	route("GET", "/hazards/{hazardId}/replay", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.Projector.ReplayPlan(r.PathValue("hazardId"))
		respond(w, v, err)
	})
	route("GET", "/versions/{versionId}/content", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.Projector.Version(r.PathValue("versionId"))
		respond(w, v, err)
	})
	route("GET", "/runs/{runId}/stream", s.stream)
	route("POST", "/demo", func(w http.ResponseWriter, r *http.Request) {
		input := struct {
			Mode        string `json:"mode"`
			Interactive bool   `json:"interactive"`
		}{Mode: "observe"}
		if err := decode(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		if input.Mode != "observe" && input.Mode != "guard" {
			respond(w, nil, fmt.Errorf("invalid mode"))
			return
		}
		d, err := s.startDemo(input.Mode, input.Interactive)
		if err != nil {
			respond(w, nil, err)
			return
		}
		writeJSON(w, 201, Object{"runId": d.Coordinator.RunID})
	})
	route("GET", "/runs/{runId}/demo", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("runId")
		state, err := s.Projector.State(id, 0)
		if err != nil {
			respond(w, nil, err)
			return
		}
		s.mu.Lock()
		d, c := s.demos[id], s.coordinators[id]
		s.mu.Unlock()
		if d != nil {
			respond(w, d.Status(), nil)
			return
		}
		phase := "interrupted"
		if state.Run.Status == "completed" {
			phase = "completed"
		}
		var failure *string
		if c != nil {
			failure = c.WorkspaceError()
		}
		respond(w, Object{"phase": phase, "error": nil, "canRelease": false, "workspaceError": failure}, nil)
	})
	route("POST", "/runs/{runId}/release", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		d := s.demos[r.PathValue("runId")]
		s.mu.Unlock()
		if d == nil {
			respond(w, nil, fmt.Errorf("active demo not found"))
			return
		}
		err := d.Release()
		respond(w, Object{"released": true}, err)
	})
	route("POST", "/runs/{runId}/reconstruct", func(w http.ResponseWriter, r *http.Request) {
		c, err := s.coordinator(r.PathValue("runId"))
		if err == nil {
			err = c.Reconstruct()
		}
		respond(w, Object{"reconstructed": true}, err)
	})
	route("POST", "/hazards/{hazardId}/assessments", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Analyzer         string   `json:"analyzer"`
			Relevance        string   `json:"relevance"`
			Reason           string   `json:"reason"`
			AffectedElements []string `json:"affectedElements"`
		}
		if err := decode(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		id := r.PathValue("hazardId")
		runID, err := s.Store.RunForEntity("hazards", id)
		if err != nil {
			respond(w, nil, err)
			return
		}
		c, err := s.coordinator(runID)
		if err == nil {
			err = c.Assess(id, Assessment{Analyzer: input.Analyzer, Relevance: input.Relevance, Reason: input.Reason, AffectedElements: input.AffectedElements})
		}
		if err != nil {
			respond(w, nil, err)
			return
		}
		value, err := s.Projector.Hazard(id, 0)
		respond(w, value, err)
	})
	route("POST", "/hazards/{hazardId}/analyze", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("hazardId")
		runID, err := s.Store.RunForEntity("hazards", id)
		if err != nil {
			respond(w, nil, err)
			return
		}
		c, err := s.coordinator(runID)
		if err != nil {
			respond(w, nil, err)
			return
		}
		var h Hazard
		for _, value := range c.State().Hazards {
			if value.ID == id {
				h = value
			}
		}
		assessment, err := FixtureAssessment(s.Store, h)
		if err == nil {
			err = c.Assess(id, assessment)
		}
		if err != nil {
			respond(w, nil, err)
			return
		}
		v, err := s.Projector.Hazard(id, 0)
		respond(w, v, err)
	})
	route("POST", "/hazards/{hazardId}/repair", func(w http.ResponseWriter, r *http.Request) {
		runID, err := s.Store.RunForEntity("hazards", r.PathValue("hazardId"))
		if err != nil {
			respond(w, nil, err)
			return
		}
		s.mu.Lock()
		if s.repairing[runID] {
			s.mu.Unlock()
			respond(w, Object{"repairing": true}, nil)
			return
		}
		s.repairing[runID] = true
		s.mu.Unlock()
		defer func() { s.mu.Lock(); delete(s.repairing, runID); s.mu.Unlock() }()
		c, err := s.coordinator(runID)
		if err == nil {
			err = RepairDemo(r.Context(), c)
		}
		if err != nil {
			respond(w, nil, err)
			return
		}
		v, err := s.Projector.Snapshot(runID, 0)
		respond(w, v, err)
	})
	route("POST", "/runs", s.createRun)
	route("POST", "/runs/{runId}/agents", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Name    string `json:"name"`
			Adapter string `json:"adapter"`
		}
		if err := decode(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		c, err := s.coordinator(r.PathValue("runId"))
		if err != nil {
			respond(w, nil, err)
			return
		}
		id, err := c.CreateAgent(input.Name, input.Adapter)
		respond(w, Object{"agentId": id}, err)
	})
	route("POST", "/runs/{runId}/attempts", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			AgentID string `json:"agentId"`
			Name    string `json:"name"`
			Prompt  string `json:"prompt"`
			TaskID  string `json:"taskId"`
		}
		if err := decode(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		c, err := s.coordinator(r.PathValue("runId"))
		if err != nil {
			respond(w, nil, err)
			return
		}
		a, err := c.CreateAttempt(input.AgentID, input.Name, input.Prompt, input.TaskID)
		respond(w, a, err)
	})
	route("POST", "/runs/{runId}/attempts/{attemptId}/{operation}", s.agentOperation)
	route("POST", "/runs/{runId}/end", func(w http.ResponseWriter, r *http.Request) {
		c, err := s.coordinator(r.PathValue("runId"))
		if err == nil {
			err = c.End()
		}
		respond(w, Object{"completed": true}, err)
	})
	route("POST", "/runs/{runId}/resume", func(w http.ResponseWriter, r *http.Request) {
		c, err := s.coordinator(r.PathValue("runId"))
		if err == nil {
			err = c.Resume()
		}
		respond(w, Object{"resumed": true}, err)
	})
	if staticRoot != "" {
		if _, err := os.Stat(filepath.Join(staticRoot, "index.html")); err == nil {
			mux.Handle("GET /", http.FileServer(http.Dir(staticRoot)))
		}
	}
}
func (s *Service) createRun(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name  string             `json:"name"`
		Mode  string             `json:"mode"`
		Files map[string]*string `json:"files"`
	}
	if err := decode(w, r, &input); err != nil {
		respond(w, nil, err)
		return
	}
	if input.Mode == "" {
		input.Mode = "observe"
	}
	if input.Mode != "observe" && input.Mode != "guard" {
		respond(w, nil, fmt.Errorf("invalid mode"))
		return
	}
	for path := range input.Files {
		if _, err := ResourcePath(path); err != nil {
			respond(w, nil, err)
			return
		}
	}
	id := ID()
	c, err := NewCoordinator(s.Store, filepath.Join(s.root, id), id)
	if err != nil {
		respond(w, nil, err)
		return
	}
	for path, content := range input.Files {
		if err = c.Workspace.Write(path, content); err != nil {
			c.Close()
			respond(w, nil, err)
			return
		}
	}
	if err = c.Start(input.Name, nil, input.Mode); err == nil {
		err = c.ImportWorkspace()
	}
	if err != nil {
		c.Close()
		respond(w, nil, err)
		return
	}
	s.mu.Lock()
	s.coordinators[id] = c
	s.mu.Unlock()
	writeJSON(w, 201, Object{"runId": id})
}
func (s *Service) agentOperation(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Path          string          `json:"path"`
		Content       json.RawMessage `json:"content"`
		Query         string          `json:"query"`
		BaseVersionID string          `json:"baseVersionId"`
		Patch         string          `json:"patch"`
		IntentID      string          `json:"intentId"`
		Status        string          `json:"status"`
		Name          string          `json:"name"`
	}
	if err := decode(w, r, &input); err != nil {
		respond(w, nil, err)
		return
	}
	c, err := s.coordinator(r.PathValue("runId"))
	if err != nil {
		respond(w, nil, err)
		return
	}
	attemptID := r.PathValue("attemptId")
	a := c.State().Attempts[attemptID]
	if a == nil {
		respond(w, nil, fmt.Errorf("attempt not found in this run"))
		return
	}
	var value any
	switch r.PathValue("operation") {
	case "observe_resource":
		value, err = c.Observe(attemptID, input.Path)
	case "list_resources":
		value, err = c.List(attemptID)
	case "search_repository":
		value, err = c.Search(attemptID, input.Query)
	case "write_resource", "write_intent":
		var content *string
		if len(input.Content) == 0 {
			err = fmt.Errorf("content is required; use explicit null for deletion")
			break
		}
		if err = json.Unmarshal(input.Content, &content); err != nil {
			break
		}
		if r.PathValue("operation") == "write_resource" {
			value, err = c.Write(r.Context(), attemptID, input.Path, content)
		} else {
			value, err = c.PrepareWrite(attemptID, input.Path, content, input.BaseVersionID)
		}
	case "commit_write":
		intent, exists := c.State().Intents[input.IntentID]
		if !exists || intent.AttemptID != attemptID {
			err = fmt.Errorf("intent does not belong to this attempt")
			break
		}
		value, err = c.CommitWrite(r.Context(), input.IntentID)
	case "apply_patch":
		value, err = c.Patch(r.Context(), attemptID, input.Path, input.BaseVersionID, input.Patch)
	case "complete":
		err = c.FinishAttempt(attemptID, input.Status)
		value = Object{"completed": true}
	case "run_command":
		value, err = c.Command(r.Context(), attemptID, input.Name)
	default:
		err = httpError{404, "operation not found"}
	}
	respond(w, value, err)
}
func (s *Service) stream(w http.ResponseWriter, r *http.Request) {
	c, err := s.coordinator(r.PathValue("runId"))
	if err != nil {
		respond(w, nil, err)
		return
	}
	events, unsubscribe := c.Subscribe()
	defer unsubscribe()
	state := c.State()
	last := state.Seq
	if raw := r.Header.Get("Last-Event-ID"); raw != "" {
		last, err = strconv.Atoi(raw)
		if err != nil || last < 0 {
			respond(w, nil, fmt.Errorf("invalid event cursor"))
			return
		}
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		respond(w, nil, fmt.Errorf("stream unsupported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	send := func(seq int, kind string) error {
		return (projection.SSE{Writer: w, Flusher: flusher}).Publish(r.Context(), projection.Update{RunID: c.RunID, RuntimeSeq: seq, Kind: kind})
	}
	for _, e := range state.Events {
		if e.RuntimeSeq > last {
			if err = send(e.RuntimeSeq, e.Kind); err != nil {
				return
			}
			last = e.RuntimeSeq
		}
	}
	if err = send(state.Seq, "CONNECTED"); err != nil {
		return
	}
	if last < state.Seq {
		last = state.Seq
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case e, open := <-events:
			if !open {
				return
			}
			if e.RuntimeSeq > last {
				if err = send(e.RuntimeSeq, e.Kind); err != nil {
					return
				}
				last = e.RuntimeSeq
			}
		case <-heartbeat.C:
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err = fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		}
	}
}
