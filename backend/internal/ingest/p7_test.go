package ingest_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestEnsureStreams_AIExecuteAndEmbedConsumers(t *testing.T) {
	ctx := context.Background()
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{ingest.AIExecuteConsumer, ingest.AIEmbedConsumer} {
		if _, err := js.Consumer(ctx, ingest.TasksStream, name); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestFlush_ToolOntologyEmbedding(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	fxt := seed(t, admin)
	center, pain := mustV7(t), mustV7(t)
	execID := mustV7(t)
	embID := mustV7(t)
	edgeID := mustV7(t)
	flusher := &ingest.Flusher{DB: app, JS: js}
	ack := func(context.Context) error { return nil }

	tool, _ := json.Marshal(map[string]any{
		"id": execID.String(), "schema_version": 1, "type": "tool_execution",
		"occurred_at": time.Now().UTC().Format(time.RFC3339),
		"account_id":  fxt.Account.String(), "inbox_id": fxt.Inbox.String(),
		"conversation_id": fxt.Conversation.String(), "trace_id": "t", "hop_count": 0,
		"payload": map[string]any{
			"tool_name": "refund", "input_args": map[string]any{"amount": 1},
			"output_result": map[string]any{}, "is_success": false, "requires_approval": true,
		},
	})
	ont, _ := json.Marshal(map[string]any{
		"id": mustV7(t).String(), "schema_version": 1, "type": "ontology_extracted",
		"occurred_at": time.Now().UTC().Format(time.RFC3339),
		"account_id":  fxt.Account.String(), "inbox_id": fxt.Inbox.String(),
		"conversation_id": fxt.Conversation.String(), "trace_id": "t", "hop_count": 0,
		"payload": map[string]any{
			"nodes": []any{
				map[string]any{"id": center.String(), "entity_type": "Customer", "name": "Ada", "external_ref_id": fxt.Contact.String()},
				map[string]any{
					"id": pain.String(), "entity_type": "PainPoint", "name": "결제 오류",
					"properties": map[string]any{"source_message_ids": []any{mustV7(t).String()}},
				},
			},
			"edges": []any{
				map[string]any{
					"id": edgeID.String(), "source_node_id": center.String(), "target_node_id": pain.String(),
					"relation_type": "EXPERIENCED", "weight": 1.0, "confidence": 0.9,
				},
			},
		},
	})
	vec := make([]float64, 1536)
	for i := range vec {
		vec[i] = 0.01
	}
	emb, _ := json.Marshal(map[string]any{
		"id": embID.String(), "schema_version": 1, "type": "embedding_upsert",
		"occurred_at": time.Now().UTC().Format(time.RFC3339),
		"account_id":  fxt.Account.String(), "inbox_id": fxt.Inbox.String(),
		"conversation_id": fxt.Conversation.String(), "trace_id": "t", "hop_count": 0,
		"payload": map[string]any{
			"owner_type": "article", "owner_id": pain.String(),
			"model": "text-embedding-3-small", "version": 1, "embedding": vec,
		},
	})
	if err := flusher.Flush(ctx, []ingest.Ackable{
		{Data: tool, Ack: ack}, {Data: ont, Ack: ack}, {Data: emb, Ack: ack},
	}); err != nil {
		t.Fatal(err)
	}
	var toolName string
	if err := admin.QueryRow(ctx, `SELECT tool_name FROM agent_tool_executions WHERE id=$1`, execID).Scan(&toolName); err != nil {
		t.Fatal(err)
	}
	if toolName != "refund" {
		t.Fatalf("tool=%s", toolName)
	}
	var n int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM ontology_nodes WHERE account_id=$1`, fxt.Account).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("nodes=%d", n)
	}
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM embeddings WHERE id=$1`, embID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("embeddings=%d", n)
	}
}

func TestFlush_OntologyRejectsAtomWithoutMessageRefs(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	fxt := seed(t, admin)
	flusher := &ingest.Flusher{DB: app, JS: js}
	ack := func(context.Context) error { return nil }
	ont, _ := json.Marshal(map[string]any{
		"id": mustV7(t).String(), "schema_version": 1, "type": "ontology_extracted",
		"occurred_at": time.Now().UTC().Format(time.RFC3339),
		"account_id":  fxt.Account.String(), "inbox_id": fxt.Inbox.String(),
		"conversation_id": fxt.Conversation.String(), "trace_id": "t", "hop_count": 0,
		"payload": map[string]any{
			"nodes": []any{
				map[string]any{"id": mustV7(t).String(), "entity_type": "PainPoint", "name": "결제 오류"},
			},
			"edges": []any{},
		},
	})
	if err := flusher.Flush(ctx, []ingest.Ackable{{Data: ont, Ack: ack}}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM ontology_nodes WHERE account_id=$1`, fxt.Account).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("nodes=%d", n)
	}
	stream, err := js.Stream(ctx, ingest.IngestionDLQ)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stream.GetLastMsgForSubject(ctx, ingest.DLQSubject); err != nil {
		t.Fatalf("dlq: %v", err)
	}
}

func TestFlush_OntologyPyramidLinks(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	fxt := seed(t, admin)
	center, pain, scenario := mustV7(t), mustV7(t), mustV7(t)
	flusher := &ingest.Flusher{DB: app, JS: js}
	ack := func(context.Context) error { return nil }
	ont, _ := json.Marshal(map[string]any{
		"id": mustV7(t).String(), "schema_version": 1, "type": "ontology_extracted",
		"occurred_at": time.Now().UTC().Format(time.RFC3339),
		"account_id":  fxt.Account.String(), "inbox_id": fxt.Inbox.String(),
		"conversation_id": fxt.Conversation.String(), "trace_id": "t", "hop_count": 0,
		"payload": map[string]any{
			"nodes": []any{
				map[string]any{"id": center.String(), "entity_type": "Customer", "name": "Ada", "external_ref_id": fxt.Contact.String(),
					"properties": map[string]any{"summary": "결제 이슈 고객"}},
				map[string]any{"id": pain.String(), "entity_type": "PainPoint", "name": "결제 오류",
					"properties": map[string]any{"source_message_ids": []any{mustV7(t).String()}}},
				map[string]any{"id": scenario.String(), "entity_type": "Scenario", "name": "결제 상담"},
			},
			"edges": []any{
				map[string]any{"id": mustV7(t).String(), "source_node_id": center.String(), "target_node_id": pain.String(),
					"relation_type": "EXPERIENCED", "weight": 1.0, "confidence": 0.9},
				map[string]any{"id": mustV7(t).String(), "source_node_id": scenario.String(), "target_node_id": pain.String(),
					"relation_type": "CONTAINS_ATOM", "weight": 1.0, "confidence": 1.0},
				map[string]any{"id": mustV7(t).String(), "source_node_id": center.String(), "target_node_id": scenario.String(),
					"relation_type": "HAS_SCENARIO", "weight": 1.0, "confidence": 1.0},
			},
		},
	})
	if err := flusher.Flush(ctx, []ingest.Ackable{{Data: ont, Ack: ack}}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM ontology_nodes WHERE account_id=$1`, fxt.Account).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("nodes=%d", n)
	}
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM ontology_edges WHERE relation_type='HAS_SCENARIO'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("HAS_SCENARIO=%d", n)
	}
}

func TestFlush_Embedding768(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	fxt := seed(t, admin)
	embID := mustV7(t)
	owner := mustV7(t)
	flusher := &ingest.Flusher{DB: app, JS: js}
	ack := func(context.Context) error { return nil }
	vec := make([]float64, 768)
	for i := range vec {
		vec[i] = 0.01
	}
	emb, _ := json.Marshal(map[string]any{
		"id": embID.String(), "schema_version": 1, "type": "embedding_upsert",
		"occurred_at": time.Now().UTC().Format(time.RFC3339),
		"account_id":  fxt.Account.String(), "inbox_id": fxt.Inbox.String(),
		"conversation_id": fxt.Conversation.String(), "trace_id": "t", "hop_count": 0,
		"payload": map[string]any{
			"owner_type": "article", "owner_id": owner.String(),
			"model": "embeddinggemma-2:270m", "version": 1, "embedding": vec,
		},
	})
	if err := flusher.Flush(ctx, []ingest.Ackable{{Data: emb, Ack: ack}}); err != nil {
		t.Fatal(err)
	}
	var dim int
	if err := admin.QueryRow(ctx, `SELECT vector_dims(embedding) FROM embeddings WHERE id=$1`, embID).Scan(&dim); err != nil {
		t.Fatal(err)
	}
	if dim != 768 {
		t.Fatalf("dim=%d", dim)
	}
}

func TestFlush_EmbeddingRejectsEmpty(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	fxt := seed(t, admin)
	flusher := &ingest.Flusher{DB: app, JS: js}
	ack := func(context.Context) error { return nil }
	emb, _ := json.Marshal(map[string]any{
		"id": mustV7(t).String(), "schema_version": 1, "type": "embedding_upsert",
		"occurred_at": time.Now().UTC().Format(time.RFC3339),
		"account_id":  fxt.Account.String(), "inbox_id": fxt.Inbox.String(),
		"conversation_id": fxt.Conversation.String(), "trace_id": "t", "hop_count": 0,
		"payload": map[string]any{
			"owner_type": "article", "owner_id": mustV7(t).String(),
			"model": "embeddinggemma-2:270m", "version": 1, "embedding": []float64{},
		},
	})
	if err := flusher.Flush(ctx, []ingest.Ackable{{Data: emb, Ack: ack}}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM embeddings`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("embeddings=%d", n)
	}
	stream, err := js.Stream(ctx, ingest.IngestionDLQ)
	if err != nil {
		t.Fatal(err)
	}
	got, err := stream.GetLastMsgForSubject(ctx, ingest.DLQSubject)
	if err != nil {
		t.Fatalf("dlq: %v", err)
	}
	if len(got.Data) == 0 {
		t.Fatal("empty dlq payload")
	}
}
