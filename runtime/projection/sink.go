// Package projection defines the optional debugger publication boundary.
package projection

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type Update struct {
	RunID      string          `json:"runId"`
	RuntimeSeq int             `json:"runtimeSeq"`
	Kind       string          `json:"kind"`
	Snapshot   json.RawMessage `json:"-"`
}

type Sink interface {
	Publish(context.Context, Update) error
}

// SSE preserves the existing protocol. Payloads contain cursors, not snapshots.
type SSE struct {
	Writer  http.ResponseWriter
	Flusher http.Flusher
}

func (s SSE) Publish(_ context.Context, u Update) error {
	_ = http.NewResponseController(s.Writer).SetWriteDeadline(time.Now().Add(10 * time.Second))
	data, err := json.Marshal(u)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(s.Writer, "id: %d\nevent: update\ndata: %s\n\n", u.RuntimeSeq, data)
	s.Flusher.Flush()
	return err
}
