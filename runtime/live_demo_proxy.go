package ravel

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

// Only the optional Python demo controller handles provider execution.
// Runtime storage and concurrency operations continue through the usual API.
func liveDemoProxy() http.Handler {
	target, err := url.Parse(os.Getenv("RAVEL_DEMO_URL"))
	if err != nil || target.Scheme != "http" || (target.Hostname() != "127.0.0.1" && target.Hostname() != "localhost") || target.User != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 503, Object{"error": "Live demo controller unavailable. Start pnpm demo:live."})
		})
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		director(r)
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/api/live-demo")
		r.Host = target.Host
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		writeJSON(w, 503, Object{"error": "Live demo controller unavailable; recorded runs remain inspectable."})
	}
	return proxy
}
