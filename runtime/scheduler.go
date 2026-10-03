package ravel

import (
	"context"
	"fmt"
	"sync"
)

type Scheduler struct {
	mu    sync.Mutex
	holds map[string]chan struct{}
}

func NewScheduler() *Scheduler { return &Scheduler{holds: map[string]chan struct{}{}} }
func (s *Scheduler) Hold(attempt string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.holds[attempt] != nil {
		return fmt.Errorf("already held")
	}
	s.holds[attempt] = make(chan struct{})
	return nil
}
func (s *Scheduler) Release(attempt string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := s.holds[attempt]
	if ch == nil {
		return fmt.Errorf("no held mutation")
	}
	delete(s.holds, attempt)
	close(ch)
	return nil
}
func (s *Scheduler) Wait(ctx context.Context, i Intent) error {
	s.mu.Lock()
	ch := s.holds[i.AttemptID]
	s.mu.Unlock()
	if ch == nil {
		return nil
	}
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
