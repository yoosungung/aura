package contractgen

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGenerate_EmitsSharedPayloadTypes(t *testing.T) {
	out := filepath.Join(t.TempDir(), "gen.go")
	if err := Generate(schemaDir(t), out); err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	got := string(src)
	for _, want := range []string{
		"package contracts",
		"type MessageCreated struct",
		"type MessageCreatedPayload struct",
		"type ConversationsCreate struct",
		"type ConversationsTransition struct",
		"`json:\"account_id\"`",
		"`json:\"new_status\"`",
		"`json:\"expected_version\"`",
		"`json:\"schema_version\"`",
		"`json:\"contact_inbox_id\"`",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in:\n%s", want, got)
		}
	}
}

func schemaDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("caller")
	}
	dir := filepath.Join(filepath.Dir(file), "..", "..", "..", "contracts")
	if _, err := os.Stat(dir); err != nil {
		t.Fatal(err)
	}
	return dir
}
