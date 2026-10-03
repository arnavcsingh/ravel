package ravel

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
)

const DemoSchema = "CREATE TABLE users (\n    id INTEGER PRIMARY KEY,\n    email TEXT NOT NULL\n);\n"
const DemoTypes = "export interface User {\n  id: number;\n}\n"
const DemoClient = "// Generate the client from api/types.ts.\n"

// Demo is an in-process conformance fixture. Real coding agents use mediated HTTP operations.
type Demo struct {
	Coordinator                                         *Coordinator
	mu                                                  sync.Mutex
	phase                                               string
	failure                                             *string
	released                                            bool
	release                                             chan struct{}
	done                                                chan struct{}
	interactive                                         bool
	backend, backendAgent, databaseAgent, frontendAgent string
}

func PrepareDemo(store *Store, root, mode string, interactive bool) (*Demo, error) {
	id := ID()
	c, err := NewCoordinator(store, filepath.Join(root, id), id)
	if err != nil {
		return nil, err
	}
	for path, content := range map[string]string{"schema.sql": DemoSchema, "api/types.ts": DemoTypes, "frontend/client.ts": DemoClient} {
		if err = c.Workspace.Write(path, ptr(content)); err != nil {
			return nil, err
		}
	}
	if err = c.Start("The identifier migration", ptr("identifier-migration"), mode); err != nil {
		return nil, err
	}
	for _, v := range []struct {
		path       string
		generation int
	}{{"schema.sql", 17}, {"api/types.ts", 4}, {"frontend/client.ts", 8}} {
		if _, err = c.ImportResource(v.path, v.generation); err != nil {
			return nil, err
		}
	}
	ba, err := c.CreateAgent("Backend", "")
	if err != nil {
		return nil, err
	}
	da, err := c.CreateAgent("Database", "")
	if err != nil {
		return nil, err
	}
	fa, err := c.CreateAgent("Frontend", "")
	if err != nil {
		return nil, err
	}
	b, err := c.CreateAttempt(ba, "Generate API types", "Read schema.sql and update api/types.ts.", "")
	if err != nil {
		return nil, err
	}
	return &Demo{Coordinator: c, phase: "ready", release: make(chan struct{}), done: make(chan struct{}), interactive: interactive, backend: b.ID, backendAgent: ba, databaseAgent: da, frontendAgent: fa}, nil
}
func (d *Demo) Status() Object {
	d.mu.Lock()
	defer d.mu.Unlock()
	return Object{"phase": d.phase, "error": d.failure, "canRelease": d.phase == "held" && !d.released, "workspaceError": d.Coordinator.WorkspaceError()}
}
func (d *Demo) setPhase(phase string) { d.mu.Lock(); d.phase = phase; d.mu.Unlock() }
func (d *Demo) Release() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.phase != "held" || d.released {
		return fmt.Errorf("no pending demo mutation is held")
	}
	d.released = true
	close(d.release)
	return nil
}
func (d *Demo) Done() <-chan struct{} { return d.done }
func backendCandidate(c *Coordinator, attempt string) (string, error) {
	observed, err := c.Observe(attempt, "schema.sql")
	if err != nil {
		return "", err
	}
	kind := "number"
	if strings.Contains(val(observed.Content), "id UUID") {
		kind = "string"
	}
	return fmt.Sprintf("export interface User {\n  id: %s;\n  email: string;\n}\n", kind), nil
}
func backendRun(ctx context.Context, c *Coordinator, attempt string) error {
	candidate, err := backendCandidate(c, attempt)
	if err != nil {
		return err
	}
	result, err := c.Write(ctx, attempt, "api/types.ts", &candidate)
	if err != nil {
		return err
	}
	if result.Rejected {
		return fmt.Errorf("repair/retry rejected unexpectedly")
	}
	return c.FinishAttempt(attempt, "")
}
func frontendRun(ctx context.Context, c *Coordinator, attempt string) error {
	types, err := c.Observe(attempt, "api/types.ts")
	if err != nil {
		return err
	}
	expression := "encodeURIComponent(id)"
	if strings.Contains(val(types.Content), "id: number") {
		expression = "id.toFixed(0)"
	}
	client := "import type { User } from '../api/types';\n\nexport function userUrl(id: User['id']): string {\n  return `/users/${" + expression + "}`;\n}\n"
	if _, err = c.Write(ctx, attempt, "frontend/client.ts", &client); err != nil {
		return err
	}
	return c.FinishAttempt(attempt, "")
}
func (d *Demo) Execute(ctx context.Context) (err error) {
	d.mu.Lock()
	if d.phase != "ready" {
		d.mu.Unlock()
		return fmt.Errorf("demo already started")
	}
	d.phase = "running"
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		if err != nil {
			d.phase = "failed"
			d.failure = ptr(err.Error())
		} else {
			d.phase = "completed"
		}
		d.mu.Unlock()
		close(d.done)
	}()
	c := d.Coordinator
	candidate, err := backendCandidate(c, d.backend)
	if err != nil {
		return err
	}
	intent, err := c.PrepareWrite(d.backend, "api/types.ts", &candidate, "")
	if err != nil {
		return err
	}
	db, err := c.CreateAttempt(d.databaseAgent, "Migrate identifiers", "Migrate User.id from INTEGER to UUID.", "")
	if err != nil {
		return err
	}
	schema, err := c.Observe(db.ID, "schema.sql")
	if err != nil {
		return err
	}
	migrated := strings.Replace(val(schema.Content), "id INTEGER", "id UUID", 1)
	if _, err = c.Write(ctx, db.ID, "schema.sql", &migrated); err != nil {
		return err
	}
	d.setPhase("held")
	if err = c.FinishAttempt(db.ID, ""); err != nil {
		return err
	}
	if d.interactive {
		select {
		case <-d.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	d.setPhase("running")
	result, err := c.CommitWrite(ctx, intent.ID)
	if err != nil {
		return err
	}
	if result.Rejected {
		a := c.State().Attempts[d.backend]
		retry, err := c.CreateAttempt(d.backendAgent, "", "", a.TaskID)
		if err != nil {
			return err
		}
		if err = backendRun(ctx, c, retry.ID); err != nil {
			return err
		}
	} else if err = c.FinishAttempt(d.backend, ""); err != nil {
		return err
	}
	frontend, err := c.CreateAttempt(d.frontendAgent, "Update the client", "Read api/types.ts and update frontend/client.ts.", "")
	if err != nil {
		return err
	}
	if err = frontendRun(ctx, c, frontend.ID); err != nil {
		return err
	}
	if err = c.End(); err != nil {
		return err
	}
	for _, h := range c.State().Hazards {
		result, err := FixtureAssessment(c.Store, h)
		if err != nil {
			return err
		}
		if err = c.Assess(h.ID, result); err != nil {
			return err
		}
	}
	return nil
}

// This preserves the existing labeled demo heuristic, not a provider integration.
func FixtureAssessment(store *Store, h Hazard) (Assessment, error) {
	detail, err := (Projector{store}).Hazard(h.ID, 0)
	if err != nil {
		return Assessment{}, err
	}
	observed := val(detail["observedContent"].(*string))
	current := val(detail["currentContent"].(*string))
	consumer := val(detail["consumerContent"].(*string))
	mismatch := strings.Contains(strings.ToUpper(observed), "ID INTEGER") && strings.Contains(strings.ToUpper(current), "ID UUID") && strings.Contains(consumer, "id: number")
	result := Assessment{Analyzer: "heuristic-demo-v1", Relevance: "POSSIBLE", Reason: "The observed input changed. The heuristic cannot determine whether this difference changes the meaning of the generated output.", AffectedElements: []string{}}
	if mismatch {
		result.Relevance = "LIKELY"
		result.AffectedElements = []string{"User.id"}
		result.Reason = "The schema changed the identifier from INTEGER to UUID, while the generated TypeScript interface still declares id as number. This fixture-specific heuristic identifies a likely contract mismatch."
	}
	return result, nil
}
func RepairDemo(ctx context.Context, c *Coordinator) error {
	s := c.State()
	if s.Run == nil || val(s.Run.Scenario) != "identifier-migration" || s.Run.Status != "completed" {
		return fmt.Errorf("repair requires a completed identifier migration demo")
	}
	for _, a := range s.Attempts {
		if a.Number > 1 {
			return fmt.Errorf("demo already has replacement attempts")
		}
	}
	if err := c.Resume(); err != nil {
		return err
	}
	for _, name := range []string{"Backend", "Frontend"} {
		var agent *Agent
		for _, a := range orderedAgents(s) {
			if a.Name == name {
				agent = a
			}
		}
		if agent == nil {
			return fmt.Errorf("missing demo agent")
		}
		var original *Attempt
		for _, a := range orderedAttempts(s) {
			if a.AgentID == agent.ID {
				original = a
				break
			}
		}
		retry, err := c.CreateAttempt(agent.ID, "", "", original.TaskID)
		if err != nil {
			return err
		}
		if name == "Backend" {
			err = backendRun(ctx, c, retry.ID)
		} else {
			err = frontendRun(ctx, c, retry.ID)
		}
		if err != nil {
			return err
		}
	}
	return c.End()
}
