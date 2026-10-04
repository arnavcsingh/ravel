package ravel

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOptionalDemoControllerBoundary(t *testing.T) {
	for _, target := range []string{"", "https://example.com", "http://secret@127.0.0.1:4318"} {
		t.Setenv("RAVEL_DEMO_URL", target)
		response := httptest.NewRecorder()
		liveDemoProxy().ServeHTTP(response, httptest.NewRequest("GET", "/api/live-demo/health", nil))
		if response.Code != 503 {
			t.Fatal(response.Code)
		}
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Error(r.URL.Path)
		}
		writeJSON(w, 200, Object{"ready": true})
	}))
	defer upstream.Close()
	t.Setenv("RAVEL_DEMO_URL", upstream.URL)
	static := t.TempDir()
	ok(t, os.WriteFile(filepath.Join(static, "index.html"), []byte("debugger"), 0600))
	service, err := NewService(t.TempDir(), static, false)
	ok(t, err)
	defer service.Close()
	response := httptest.NewRecorder()
	service.ServeHTTP(response, httptest.NewRequest("GET", "/api/live-demo/health", nil))
	if response.Code != 200 || !strings.Contains(response.Body.String(), "ready") {
		t.Fatal(response.Body.String())
	}
	request := httptest.NewRequest("POST", "/api/live-demo/runs", strings.NewReader("{}"))
	request.Header.Set("Origin", "https://untrusted.invalid")
	response = httptest.NewRecorder()
	service.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatal(response.Code)
	}
}
