package ravel

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

func lines(text string) []string {
	if text == "" {
		return []string{}
	}
	out := strings.SplitAfter(text, "\n")
	if out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return out
}
func DiffLines(before, after string) []Object {
	a, b := lines(before), lines(after)
	out := []Object{}
	if len(a)*len(b) > 4_000_000 {
		for _, l := range a {
			out = append(out, Object{"kind": "removed", "text": strings.TrimSuffix(l, "\n")})
		}
		for _, l := range b {
			out = append(out, Object{"kind": "added", "text": strings.TrimSuffix(l, "\n")})
		}
		return out
	}
	dp := make([][]int, len(a)+1)
	for i := range dp {
		dp[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		kind, text := "", ""
		if i < len(a) && j < len(b) && a[i] == b[j] {
			kind = "context"
			text = a[i]
			i++
			j++
		} else if i < len(a) && (j == len(b) || dp[i+1][j] >= dp[i][j+1]) {
			kind = "removed"
			text = a[i]
			i++
		} else {
			kind = "added"
			text = b[j]
			j++
		}
		out = append(out, Object{"kind": kind, "text": strings.TrimSuffix(text, "\n")})
	}
	return out
}

var hunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

type patchLine struct {
	kind byte
	text string
}

// ApplyPatch applies exact unified hunks only; fuzz and implicit alternate bases are forbidden.
func ApplyPatch(base, patch string) (string, error) {
	source := lines(base)
	input := lines(patch)
	out := []string{}
	cursor := 0
	hunks := 0
	headers := 0
	for i := 0; i < len(input); {
		line := strings.TrimSuffix(input[i], "\n")
		if hunks == 0 && (strings.HasPrefix(line, "diff --git ") || strings.HasPrefix(line, "index ")) {
			i++
			continue
		}
		if strings.HasPrefix(line, "--- ") {
			headers++
			if headers > 1 {
				return "", fmt.Errorf("multiple patch files unsupported")
			}
			i++
			continue
		}
		if strings.HasPrefix(line, "+++ ") {
			i++
			continue
		}
		match := hunkHeader.FindStringSubmatch(line)
		if match == nil {
			return "", fmt.Errorf("invalid patch hunk")
		}
		start, _ := strconv.Atoi(match[1])
		oldCount, newCount := 1, 1
		if match[2] != "" {
			oldCount, _ = strconv.Atoi(match[2])
		}
		if match[4] != "" {
			newCount, _ = strconv.Atoi(match[4])
		}
		offset := start - 1
		if oldCount == 0 {
			offset = start
		}
		if offset < cursor || offset > len(source) {
			return "", fmt.Errorf("patch base offset mismatch")
		}
		out = append(out, source[cursor:offset]...)
		cursor = offset
		i++
		ops := []patchLine{}
		readOld, readNew := 0, 0
		for i < len(input) && !strings.HasPrefix(input[i], "@@ ") {
			raw := input[i]
			if readOld == oldCount && readNew == newCount && !strings.HasPrefix(raw, "\\ No newline") {
				break
			}
			if strings.HasPrefix(raw, "\\ No newline at end of file") {
				if len(ops) == 0 {
					return "", fmt.Errorf("invalid newline marker")
				}
				ops[len(ops)-1].text = strings.TrimSuffix(ops[len(ops)-1].text, "\n")
				i++
				continue
			}
			if len(raw) == 0 || !strings.ContainsRune(" +-", rune(raw[0])) {
				return "", fmt.Errorf("invalid patch line")
			}
			ops = append(ops, patchLine{raw[0], raw[1:]})
			if raw[0] != '+' {
				readOld++
			}
			if raw[0] != '-' {
				readNew++
			}
			i++
		}
		removed, added := 0, 0
		for _, op := range ops {
			if op.kind != '+' {
				if cursor >= len(source) || source[cursor] != op.text {
					return "", fmt.Errorf("patch does not apply to declared base")
				}
				cursor++
				removed++
			}
			if op.kind != '-' {
				out = append(out, op.text)
				added++
			}
		}
		if removed != oldCount || added != newCount {
			return "", fmt.Errorf("patch hunk counts mismatch")
		}
		hunks++
	}
	if hunks == 0 {
		return "", fmt.Errorf("patch requires hunks")
	}
	out = append(out, source[cursor:]...)
	return strings.Join(out, ""), nil
}
