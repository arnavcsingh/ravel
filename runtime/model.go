package ravel

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

type Run struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Workspace string  `json:"workspace"`
	Scenario  *string `json:"scenario"`
	Mode      string  `json:"mode"`
	Status    string  `json:"status"`
	StartedAt string  `json:"startedAt"`
	EndedAt   *string `json:"endedAt"`
}
type Agent struct {
	ID      string `json:"id"`
	RunID   string `json:"runId"`
	Name    string `json:"name"`
	Adapter string `json:"adapter"`
	Status  string `json:"status"`
}
type Task struct {
	ID     string `json:"id"`
	RunID  string `json:"runId"`
	Name   string `json:"name"`
	Prompt string `json:"prompt"`
}
type Attempt struct {
	ID               string            `json:"id"`
	TaskID           string            `json:"taskId"`
	AgentID          string            `json:"agentId"`
	Number           int               `json:"number"`
	Status           string            `json:"status"`
	StartedEventID   string            `json:"startedEventId"`
	EndedEventID     *string           `json:"endedEventId"`
	Frontier         map[string]string `json:"frontier"`
	ObservedVersions []string          `json:"observedVersions"`
	ProducedVersions []string          `json:"producedVersions"`
}
type Version struct {
	ID                string  `json:"id"`
	ResourceID        string  `json:"resourceId"`
	Generation        int     `json:"generation"`
	ContentHash       *string `json:"contentHash"`
	BlobRef           *string `json:"blobRef"`
	PreviousVersionID *string `json:"previousVersionId"`
	ProducerAttemptID *string `json:"producerAttemptId"`
	CreatedEventID    string  `json:"createdEventId"`
	CreationSeq       int     `json:"creationSeq"`
	Tombstone         bool    `json:"tombstone"`
}
type Observation struct {
	ID        string `json:"id"`
	AttemptID string `json:"attemptId"`
	VersionID string `json:"versionId"`
	EventID   string `json:"eventId"`
	Type      string `json:"type"`
}
type Edge struct {
	ID              string `json:"id"`
	SourceVersionID string `json:"sourceVersionId"`
	TargetVersionID string `json:"targetVersionId"`
	ObservationID   string `json:"observationId"`
	Evidence        string `json:"evidence"`
}
type Hazard struct {
	ID                      string  `json:"id"`
	ObservedVersionID       string  `json:"observedVersionId"`
	StaleSinceVersionID     string  `json:"staleSinceVersionId"`
	ValidationHeadVersionID string  `json:"validationHeadVersionId"`
	ConsumerVersionID       string  `json:"consumerVersionId"`
	ObservationID           string  `json:"observationId"`
	ObservingAgentID        string  `json:"observingAgentId"`
	InvalidatingAgentID     *string `json:"invalidatingAgentId"`
	Evidence                string  `json:"evidence"`
	DetectedSeq             int     `json:"detectedSeq"`
}
type Assessment struct {
	ID               string   `json:"id"`
	HazardID         string   `json:"hazardId"`
	Analyzer         string   `json:"analyzer"`
	Relevance        string   `json:"relevance"`
	Reason           string   `json:"reason"`
	AffectedElements []string `json:"affectedElements"`
	AssessedSeq      int      `json:"assessedSeq"`
}
type Intent struct {
	ID             string   `json:"id"`
	AttemptID      string   `json:"attemptId"`
	ResourceID     string   `json:"resourceId"`
	CandidateHash  *string  `json:"candidateHash"`
	ObservationIDs []string `json:"observationIds"`
	BaseVersionID  *string  `json:"baseVersionId"`
}
type Event struct {
	ID            string          `json:"id"`
	RunID         string          `json:"runId"`
	RuntimeSeq    int             `json:"runtimeSeq"`
	AgentID       *string         `json:"agentId"`
	TaskID        *string         `json:"taskId"`
	AttemptID     *string         `json:"attemptId"`
	AgentSeq      *int            `json:"agentSeq"`
	WallTime      string          `json:"wallTime"`
	MonotonicTime float64         `json:"monotonicTime"`
	CommandID     *string         `json:"commandId"`
	Kind          string          `json:"kind"`
	Payload       json.RawMessage `json:"payload"`
}
type State struct {
	Run            *Run                   `json:"run"`
	Agents         map[string]*Agent      `json:"agents"`
	Tasks          map[string]*Task       `json:"tasks"`
	Attempts       map[string]*Attempt    `json:"attempts"`
	Versions       map[string]Version     `json:"versions"`
	Heads          map[string]string      `json:"heads"`
	Observations   map[string]Observation `json:"observations"`
	Intents        map[string]Intent      `json:"intents"`
	SettledIntents []string               `json:"settledIntents"`
	Edges          []Edge                 `json:"edges"`
	Hazards        []Hazard               `json:"hazards"`
	Assessments    map[string]Assessment  `json:"assessments"`
	Events         []Event                `json:"events"`
	Seq            int                    `json:"seq"`
}
type Payload struct {
	Version        Version       `json:"version"`
	Observation    Observation   `json:"observation"`
	ObservationIDs []string      `json:"observationIds"`
	Observations   []Observation `json:"observations"`
	IntentID       string        `json:"intentId"`
	Status         string        `json:"status"`
	AgentID        string        `json:"agentId"`
	Task           Task          `json:"task"`
	Attempt        Attempt       `json:"attempt"`
}

func EmptyState() *State {
	return &State{Agents: map[string]*Agent{}, Tasks: map[string]*Task{}, Attempts: map[string]*Attempt{}, Versions: map[string]Version{}, Heads: map[string]string{}, Observations: map[string]Observation{}, Intents: map[string]Intent{}, SettledIntents: []string{}, Edges: []Edge{}, Hazards: []Hazard{}, Assessments: map[string]Assessment{}, Events: []Event{}}
}
func clone[T any](v T) T {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var out T
	if err = json.Unmarshal(data, &out); err != nil {
		panic(err)
	}
	return out
}
func ptr[T any](v T) *T { return &v }
func val(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
func same(a, b *string) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }
func contains(items []string, v string) bool {
	for _, item := range items {
		if item == v {
			return true
		}
	}
	return false
}
func hash(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }
func uuid(raw string) string {
	return fmt.Sprintf("%s-%s-%s-%s-%s", raw[:8], raw[8:12], raw[12:16], raw[16:20], raw[20:32])
}
func ID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return uuid(hex.EncodeToString(b))
}
func stable(parts ...string) string { return uuid(hash([]byte(strings.Join(parts, "\x00")))) }
func orderedVersions(s *State) []Version {
	out := make([]Version, 0, len(s.Versions))
	for _, v := range s.Versions {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreationSeq < out[j].CreationSeq })
	return out
}
func orderedAgents(s *State) []*Agent {
	out := []*Agent{}
	for _, e := range s.Events {
		if e.Kind == "AGENT_START" {
			var a Agent
			_ = json.Unmarshal(e.Payload, &a)
			out = append(out, s.Agents[a.ID])
		}
	}
	return out
}
func orderedAttempts(s *State) []*Attempt {
	out := []*Attempt{}
	for _, e := range s.Events {
		if e.Kind == "TASK_ATTEMPT_START" {
			out = append(out, s.Attempts[val(e.AttemptID)])
		}
	}
	return out
}
func frontierIDs(a *Attempt, s *State) []string {
	ids := []string{}
	seen := map[string]bool{}
	for _, v := range a.ObservedVersions {
		r := s.Versions[v].ResourceID
		if !seen[r] {
			seen[r] = true
			ids = append(ids, a.Frontier[r])
		}
	}
	return ids
}
