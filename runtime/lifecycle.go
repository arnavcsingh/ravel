package ravel

import (
	"fmt"
	"github.com/gofrs/flock"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Lease struct{ lock *flock.Flock }

func AcquireLease(directory string) (*Lease, error) {
	directory, err := filepath.Abs(directory)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(directory), 0700); err != nil {
		return nil, err
	}
	if _, err = os.Stat(filepath.Join(directory, "server.lock")); err == nil {
		return nil, fmt.Errorf("legacy server.lock is present; stop the previous server and release its lease first")
	}
	lock := flock.New(directory + ".lock")
	acquired, err := lock.TryLock()
	if err != nil {
		return nil, err
	}
	if !acquired {
		return nil, fmt.Errorf("a server already owns this data directory; stop it before reset or reuse")
	}
	return &Lease{lock}, nil
}
func (l *Lease) Close() error { return l.lock.Close() }
func ResetDemo(directory, protected string) (string, error) {
	source, err := filepath.Abs(directory)
	if err != nil {
		return "", err
	}
	protected, err = filepath.Abs(protected)
	if err != nil {
		return "", err
	}
	relation, err := filepath.Rel(source, protected)
	if err != nil {
		return "", err
	}
	if relation == "." || (!strings.HasPrefix(relation, ".."+string(filepath.Separator)) && relation != "..") {
		return "", fmt.Errorf("cannot reset repository or parent directory")
	}
	info, err := os.Lstat(source)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("reset requires a real Ravel data directory")
	}
	for _, name := range []string{"ravel.db", "blobs"} {
		if _, err = os.Stat(filepath.Join(source, name)); err != nil {
			return "", fmt.Errorf("not a Ravel data directory")
		}
	}
	lease, err := AcquireLease(source)
	if err != nil {
		return "", err
	}
	defer lease.Close()
	target := source + ".saved-" + time.Now().UTC().Format("2006-01-02T15-04-05.000000000Z")
	if filepath.Dir(target) != filepath.Dir(source) {
		return "", fmt.Errorf("backup escaped parent")
	}
	if err = os.Rename(source, target); err != nil {
		return "", err
	}
	return target, nil
}
