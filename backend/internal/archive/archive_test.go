package archive

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestArchive_WritesJSONLByDateAndAccount(t *testing.T) {
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
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
	raw, _ := json.Marshal(map[string]any{
		"id": id.String(), "schema_version": 1, "type": "message_created",
		"occurred_at": "2026-10-30T05:00:00Z",
		"account_id":  account.String(), "inbox_id": inbox.String(),
		"conversation_id": conv.String(), "trace_id": "t", "hop_count": 0,
		"payload": map[string]any{},
	})
	store := &MemoryStore{}
	w := &Worker{Store: store}
	if err := w.Archive(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	var key string
	for k := range store.Items {
		key = k
	}
	wantPrefix := "archive/" + account.String() + "/" + conv.String() + "/2026-10-30/" + id.String()
	if !strings.HasPrefix(key, wantPrefix) {
		t.Fatalf("key=%s want prefix %s", key, wantPrefix)
	}
}
