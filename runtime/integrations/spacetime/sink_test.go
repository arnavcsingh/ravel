package spacetime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"ravel/runtime/projection"
	"strings"
	"testing"
)

func TestHTTPProjectionAndTokenRefresh(t *testing.T) {
	calls, tokens := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/database/ravel-test/call/publish_snapshot" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("protocol mismatch")
		}
		var args []any
		if err := json.NewDecoder(r.Body).Decode(&args); err != nil {
			t.Error(err)
		}
		if len(args) != 3 || args[0] != "run" || args[1] != float64(7) {
			t.Error(args)
		}
		if calls == 1 {
			w.WriteHeader(401)
			fmt.Fprint(w, "secret echoed by provider")
			return
		}
		w.WriteHeader(200)
	}))
	defer server.Close()
	sink := New(Config{URI: server.URL, Database: "ravel-test"})
	sink.Token = func(context.Context) (string, error) { tokens++; return "secret", nil }
	update := projection.Update{RunID: "run", RuntimeSeq: 7, Snapshot: json.RawMessage(`{"currentRuntimeSeq":7}`)}
	err := sink.Publish(context.Background(), update)
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("unsafe error", err)
	}
	if err = sink.Publish(context.Background(), update); err != nil {
		t.Fatal(err)
	}
	if tokens != 2 {
		t.Fatal("expired token not refreshed")
	}
}
func TestBadConfigurationNeverLoadsCredential(t *testing.T) {
	for _, uri := range []string{"http://remote.invalid", "ftp://localhost", "https://secret@remote.invalid", "https://remote.invalid?token=secret"} {
		sink := New(Config{URI: uri, Database: "ravel-test"})
		sink.Token = func(context.Context) (string, error) { t.Fatal("credential loaded for unsafe host"); return "", nil }
		if err := sink.Publish(context.Background(), projection.Update{}); err == nil {
			t.Fatal(uri)
		}
	}
}
