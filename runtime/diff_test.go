package ravel

import "testing"

func TestPatchHeadersAndMultipleHunks(t *testing.T) {
	base := "one\n-- separator\nthree\nfour\nfive\n"
	patch := "diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n one\n--- separator\n+two\n@@ -5 +5 @@\n-five\n+FIVE\n"
	got, err := ApplyPatch(base, patch)
	if err != nil || got != "one\ntwo\nthree\nfour\nFIVE\n" {
		t.Fatalf("%q: %v", got, err)
	}
	got, err = ApplyPatch("old", "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n")
	if err != nil || got != "new" {
		t.Fatalf("newline marker: %q: %v", got, err)
	}
	if _, err = ApplyPatch("one\n", "--- a\n+++ b\n@@ -1 +1 @@\n-one\n+two\n--- c\n+++ d\n@@ -1 +1 @@\n-two\n+three\n"); err == nil {
		t.Fatal("accepted multiple files")
	}
}
