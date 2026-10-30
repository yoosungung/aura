package archive

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestArchive_WritesJSONLByDateAndAccount(t *testing.T) {
	account, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	inbox, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	conv, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	store := &MemoryStore{}
	w := &Worker{Store: store}
	first := envelope(t, account, inbox, conv, "2026-10-30T05:00:00Z")
	second := envelope(t, account, inbox, conv, "2026-10-30T06:00:00Z")
	if err := w.Archive(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	if err := w.Archive(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	if len(store.Items) != 1 {
		t.Fatalf("keys=%d want 1", len(store.Items))
	}
	key := "archive/" + account.String() + "/" + conv.String() + "/2026-10-30.jsonl"
	body, ok := store.Items[key]
	if !ok {
		t.Fatalf("missing %s have %v", key, keys(store.Items))
	}
	lines := bytes.Split(bytes.TrimSuffix(body, []byte("\n")), []byte("\n"))
	if len(lines) != 2 {
		t.Fatalf("lines=%d body=%q", len(lines), body)
	}
	for i, raw := range [][]byte{first, second} {
		if !bytes.Equal(lines[i], raw) {
			t.Fatalf("line %d %s", i, lines[i])
		}
	}
}

func envelope(t *testing.T, account, inbox, conv uuid.UUID, occurred string) []byte {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(map[string]any{
		"id": id.String(), "schema_version": 1, "type": "message_created",
		"occurred_at": occurred, "account_id": account.String(), "inbox_id": inbox.String(),
		"conversation_id": conv.String(), "trace_id": "t", "hop_count": 0,
		"payload": map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func keys(m map[string][]byte) string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return strings.Join(out, ",")
}
