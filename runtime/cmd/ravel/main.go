package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	ravel "ravel/runtime"
	"ravel/runtime/integrations/spacetime"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	directory := flag.String("data", env("RAVEL_DATA_DIR", ".ravel/v3"), "SQLite/blob/workspace data directory")
	port := flag.String("port", env("PORT", "4317"), "loopback port (0 chooses an available port)")
	static := flag.String("static", "apps/web/dist", "built frontend directory")
	seed := flag.Bool("seed", true, "initialize the scripted demo in an empty store")
	reset := flag.Bool("reset", false, "archive stopped runtime data")
	flag.Parse()
	if *reset {
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		target, err := ravel.ResetDemo(*directory, cwd)
		if err != nil {
			return err
		}
		fmt.Println("Previous data archived:", target)
		return nil
	}
	lease, err := ravel.AcquireLease(*directory)
	if err != nil {
		return err
	}
	defer lease.Close()
	staticRoot, err := filepath.Abs(*static)
	if err != nil {
		return err
	}
	service, err := ravel.NewService(*directory, staticRoot, *seed)
	if err != nil {
		return err
	}
	defer service.Close()
	projectionConfig := spacetime.FromEnvironment()
	service.ConfigureProjection(ravel.Object{"enabled": projectionConfig.Enabled, "uri": projectionConfig.URI, "database": projectionConfig.Database}, spacetime.New(projectionConfig))
	listener, err := net.Listen("tcp", "127.0.0.1:"+*port)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: service, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stopped)
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	fmt.Printf("Ravel Go runtime ready at http://%s\n", listener.Addr())
	select {
	case err := <-done:
		if err != http.ErrServerClosed {
			return err
		}
	case <-stopped:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		_ = server.Close()
	}
	return nil
}
func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
