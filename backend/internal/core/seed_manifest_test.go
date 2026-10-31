package core_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSeedImageSharedByComposeAndJob(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("caller")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	compose, err := os.ReadFile(filepath.Join(root, "deploy", "compose", "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	job, err := os.ReadFile(filepath.Join(root, "deploy", "k8s", "base", "seed-job.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	const image = "aura/seed:main"
	if !strings.Contains(string(compose), image) {
		t.Fatalf("compose missing %s", image)
	}
	if !strings.Contains(string(job), image) {
		t.Fatalf("job missing %s", image)
	}
	if !strings.Contains(string(job), "kind: Job") {
		t.Fatal("expected Job")
	}
}
