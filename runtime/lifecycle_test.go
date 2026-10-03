package ravel

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLeaseOwnership(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "data")
	lease, err := AcquireLease(directory)
	ok(t, err)
	_, err = AcquireLease(directory)
	check(t, err != nil, "duplicate lease accepted")
	ok(t, lease.Close())
	second, err := AcquireLease(directory)
	ok(t, err)
	ok(t, second.Close())
}
func TestResetArchive(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "data")
	ok(t, os.MkdirAll(filepath.Join(directory, "blobs"), 0700))
	ok(t, os.WriteFile(filepath.Join(directory, "ravel.db"), []byte("history"), 0600))
	target, err := ResetDemo(directory, filepath.Join(root, "repo"))
	ok(t, err)
	check(t, strings.HasPrefix(target, directory+".saved-"), "wrong backup path")
	data, err := os.ReadFile(filepath.Join(target, "ravel.db"))
	ok(t, err)
	check(t, string(data) == "history", "history lost")
	_, err = os.Stat(directory)
	check(t, os.IsNotExist(err), "reset did not archive source")
}
func TestResetRejectsUnsafeTargets(t *testing.T) {
	directory := t.TempDir()
	_, err := ResetDemo(directory, filepath.Join(filepath.Dir(directory), "repo"))
	check(t, err != nil, "unrelated directory accepted")
	ok(t, os.MkdirAll(filepath.Join(directory, "blobs"), 0700))
	ok(t, os.WriteFile(filepath.Join(directory, "ravel.db"), []byte("history"), 0600))
	lease, err := AcquireLease(directory)
	ok(t, err)
	_, err = ResetDemo(directory, filepath.Join(filepath.Dir(directory), "repo"))
	check(t, err != nil, "active reset allowed")
	ok(t, lease.Close())
	_, err = ResetDemo(directory, filepath.Join(directory, "child"))
	check(t, err != nil, "ancestor reset allowed")
	_, err = ResetDemo(directory, directory)
	check(t, err != nil, "repository reset allowed")
}
