// Package spacetime publishes disposable read models. It never mutates Ravel.
package spacetime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"ravel/runtime/projection"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Enabled  bool   `json:"enabled"`
	URI      string `json:"uri"`
	Database string `json:"database"`
	CLI      string `json:"-"`
}

func FromEnvironment() Config {
	c := Config{Enabled: strings.EqualFold(os.Getenv("RAVEL_SPACETIME_ENABLED"), "true"), URI: os.Getenv("RAVEL_SPACETIME_URI"), Database: os.Getenv("RAVEL_SPACETIME_DATABASE"), CLI: os.Getenv("RAVEL_SPACETIME_CLI")}
	if c.URI == "" {
		c.URI = "https://maincloud.spacetimedb.com"
	}
	if c.Database == "" {
		c.Database = "ravel-mhacks-2026"
	}
	if c.CLI == "" {
		c.CLI = "spacetime"
		if p := filepath.Join(os.Getenv("LOCALAPPDATA"), "SpacetimeDB", "spacetime.exe"); os.Getenv("LOCALAPPDATA") != "" {
			if _, err := os.Stat(p); err == nil {
				c.CLI = p
			}
		}
	}
	return c
}

var jwt = regexp.MustCompile(`[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
var name = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

type Sink struct {
	Config Config
	Client *http.Client
	Token  func(context.Context) (string, error)
	mu     sync.Mutex
	token  string
}

func New(c Config) *Sink {
	s := &Sink{Config: c, Client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	s.Token = func(ctx context.Context) (string, error) {
		data, err := exec.CommandContext(ctx, c.CLI, "login", "show", "--token").Output()
		if err != nil {
			return "", fmt.Errorf("SpacetimeDB CLI login unavailable")
		}
		token := jwt.FindString(string(data))
		if token == "" {
			return "", fmt.Errorf("SpacetimeDB CLI has no login token")
		}
		return token, nil
	}
	return s
}
func (s *Sink) Publish(ctx context.Context, u projection.Update) error {
	host, err := url.Parse(s.Config.URI)
	if err != nil || host.Host == "" || (host.Scheme != "https" && host.Scheme != "http") || host.User != nil || host.RawQuery != "" || host.Fragment != "" || !name.MatchString(s.Config.Database) {
		return fmt.Errorf("invalid SpacetimeDB configuration")
	}
	// Only loopback permits plaintext transport of the CLI credential.
	if host.Scheme == "http" && host.Hostname() != "127.0.0.1" && host.Hostname() != "localhost" {
		return fmt.Errorf("SpacetimeDB requires HTTPS outside loopback")
	}
	s.mu.Lock()
	token := s.token
	s.mu.Unlock()
	if token == "" {
		token, err = s.Token(ctx)
		if err != nil {
			return err
		}
		s.mu.Lock()
		s.token = token
		s.mu.Unlock()
	}
	host.Path = strings.TrimRight(host.Path, "/") + "/v1/database/" + s.Config.Database + "/call/publish_snapshot"
	data, err := json.Marshal([]any{u.RunID, u.RuntimeSeq, string(u.Snapshot)})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, host.String(), bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("invalid projection request")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := s.Client.Do(req)
	if err != nil {
		return fmt.Errorf("SpacetimeDB unavailable")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == 401 {
			s.mu.Lock()
			s.token = ""
			s.mu.Unlock()
		}
		// Never log a response body or token; providers may echo request data.
		return fmt.Errorf("SpacetimeDB rejected projection (HTTP %d)", response.StatusCode)
	}
	return nil
}
