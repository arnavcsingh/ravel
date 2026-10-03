package ravel

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

var windowsDevice = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)`)

func ResourcePath(input string) (string, error) {
	p := strings.ReplaceAll(input, "\\", "/")
	if p == "" || strings.ContainsAny(p, "\x00:") || strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("invalid resource path")
	}
	parts := []string{}
	for _, part := range strings.Split(p, "/") {
		lower := strings.ToLower(part)
		if part == ".." || lower == ".git" || lower == ".ravel" {
			return "", fmt.Errorf("resource path escapes workspace")
		}
		if part == "" || part == "." {
			continue
		}
		if runtime.GOOS == "windows" && (strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || windowsDevice.MatchString(part)) {
			return "", fmt.Errorf("unsupported Windows path")
		}
		parts = append(parts, part)
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("resource file path required")
	}
	return strings.Join(parts, "/"), nil
}

type Workspace struct {
	Root      string
	WriteHook func(string, *string) error
}

func NewWorkspace(root string) (*Workspace, error) {
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	root, err = filepath.Abs(root)
	return &Workspace{Root: root}, err
}
func (w *Workspace) Path(resource string) (string, error) {
	p, err := ResourcePath(resource)
	if err != nil {
		return "", err
	}
	cursor := w.Root
	for _, part := range strings.Split(p, "/") {
		cursor = filepath.Join(cursor, part)
		info, err := os.Lstat(cursor)
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("symlink resources unsupported")
		}
		if err != nil && !os.IsNotExist(err) {
			return "", err
		}
	}
	return cursor, nil
}
func (w *Workspace) Read(resource string) (*string, error) {
	p, err := w.Path(resource)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ptr(string(data)), nil
}
func (w *Workspace) List() ([]string, error) {
	out := []string{}
	err := filepath.WalkDir(w.Root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == w.Root {
			return nil
		}
		name := strings.ToLower(d.Name())
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if name == ".git" || name == ".ravel" || name == "node_modules" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() {
			rel, err := filepath.Rel(w.Root, path)
			if err != nil {
				return err
			}
			normalized, err := ResourcePath(rel)
			if err != nil {
				return err
			}
			out = append(out, normalized)
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}
func (w *Workspace) Write(resource string, content *string) error {
	if w.WriteHook != nil {
		return w.WriteHook(resource, content)
	}
	target, err := w.Path(resource)
	if err != nil {
		return err
	}
	if content == nil {
		err = os.Remove(target)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(target), ".ravel-write-*.tmp")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	_, err = temp.WriteString(*content)
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, target)
}
func (w *Workspace) Reconstruct(s *State, store *Store) error {
	for _, v := range orderedVersions(s) {
		if s.Heads[v.ResourceID] != v.ID {
			continue
		}
		content, err := store.Content(v)
		if err != nil {
			return err
		}
		if err = w.Write(v.ResourceID, content); err != nil {
			return err
		}
	}
	return nil
}
