package core_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDeployBackboneInCluster(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("caller")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	if _, err := os.Stat(filepath.Join(root, "deploy", "compose", "docker-compose.yml")); !os.IsNotExist(err) {
		t.Fatal("compose harness should be gone")
	}
	job := mustRead(t, filepath.Join(root, "deploy", "k8s", "base", "seed-job.yaml"))
	if !strings.Contains(job, "aura/seed:main") || !strings.Contains(job, "kind: Job") {
		t.Fatal("seed job must run aura/seed:main")
	}
	kust := mustRead(t, filepath.Join(root, "deploy", "k8s", "base", "kustomization.yaml"))
	for _, name := range []string{"postgres.yaml", "nats.yaml", "seaweedfs.yaml"} {
		if !strings.Contains(kust, name) {
			t.Fatalf("kustomization missing %s", name)
		}
	}
	pg := mustRead(t, filepath.Join(root, "deploy", "k8s", "base", "postgres.yaml"))
	assertHas(t, pg, "pgvector/pgvector:0.8.7-pg16", "name: postgres", "nodePort: 30432")
	nats := mustRead(t, filepath.Join(root, "deploy", "k8s", "base", "nats.yaml"))
	assertHas(t, nats, "nats:2.15-alpine", "name: nats", "nodePort: 30422", "nodePort: 30822")
	weed := mustRead(t, filepath.Join(root, "deploy", "k8s", "base", "seaweedfs.yaml"))
	assertHas(t, weed, "chrislusf/seaweedfs:4.03", "name: seaweedfs-filer", "nodePort: 30888", "name: seaweedfs-master", "port: 19333", "port: 18080")
	if _, err := os.Stat(filepath.Join(root, "deploy", "k8s", "nodeport-proxy.sh")); !os.IsNotExist(err) {
		t.Fatal("nodeport proxy should be gone")
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func assertHas(t *testing.T, body string, parts ...string) {
	t.Helper()
	for _, part := range parts {
		if !strings.Contains(body, part) {
			t.Fatalf("missing %q", part)
		}
	}
}
