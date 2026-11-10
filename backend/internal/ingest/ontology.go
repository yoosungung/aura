package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func insertToolExecution(ctx context.Context, tx pgx.Tx, raw []byte) error {
	env, err := Parse(raw)
	if err != nil {
		return err
	}
	var wrap struct {
		Payload struct {
			ToolName         string          `json:"tool_name"`
			InputArgs        json.RawMessage `json:"input_args"`
			OutputResult     json.RawMessage `json:"output_result"`
			IsSuccess        bool            `json:"is_success"`
			RequiresApproval bool            `json:"requires_approval"`
			ApprovedBy       string          `json:"approved_by"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		return err
	}
	if wrap.Payload.ToolName == "" {
		return fmt.Errorf("invalid tool execution")
	}
	args := wrap.Payload.InputArgs
	if len(args) == 0 {
		args = []byte("{}")
	}
	out := wrap.Payload.OutputResult
	if len(out) == 0 {
		out = []byte("{}")
	}
	var approved any
	if wrap.Payload.ApprovedBy != "" {
		id, err := uuid.Parse(wrap.Payload.ApprovedBy)
		if err != nil {
			return fmt.Errorf("invalid tool execution")
		}
		approved = id
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO agent_tool_executions (
			id, account_id, conversation_id, tool_name, input_args, output_result,
			is_success, requires_approval, approved_by
		) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)
		ON CONFLICT (id) DO UPDATE SET
			output_result = EXCLUDED.output_result,
			is_success = EXCLUDED.is_success,
			approved_by = COALESCE(EXCLUDED.approved_by, agent_tool_executions.approved_by)`,
		env.ID, env.AccountID, env.ConversationID, wrap.Payload.ToolName, string(args), string(out),
		wrap.Payload.IsSuccess, wrap.Payload.RequiresApproval, approved)
	return err
}

var atomEntityTypes = map[string]struct{}{
	"PainPoint": {}, "Preference": {}, "Product": {}, "Feature": {},
}

type ontologyNodeIn struct {
	ID            string         `json:"id"`
	EntityType    string         `json:"entity_type"`
	Name          string         `json:"name"`
	ExternalRefID string         `json:"external_ref_id"`
	Properties    map[string]any `json:"properties"`
}

type ontologyEdgeIn struct {
	ID                   string  `json:"id"`
	SourceNodeID         string  `json:"source_node_id"`
	TargetNodeID         string  `json:"target_node_id"`
	RelationType         string  `json:"relation_type"`
	Weight               float64 `json:"weight"`
	ValidFrom            string  `json:"valid_from"`
	ValidUntil           *string `json:"valid_until"`
	Confidence           float64 `json:"confidence"`
	SourceConversationID string  `json:"source_conversation_id"`
}

func validateOntologyPyramid(nodes []ontologyNodeIn, edges []ontologyEdgeIn) error {
	byID := map[string]string{}
	scenarios := map[string]struct{}{}
	customers := map[string]struct{}{}
	for _, n := range nodes {
		byID[n.ID] = n.EntityType
		if n.EntityType == "Scenario" {
			scenarios[n.ID] = struct{}{}
		}
		if n.EntityType == "Customer" {
			customers[n.ID] = struct{}{}
		}
		if _, isAtom := atomEntityTypes[n.EntityType]; isAtom {
			if n.Properties == nil {
				return fmt.Errorf("invalid ontology node: atom missing source_message_ids")
			}
			ids, ok := n.Properties["source_message_ids"]
			if !ok {
				return fmt.Errorf("invalid ontology node: atom missing source_message_ids")
			}
			arr, ok := ids.([]any)
			if !ok || len(arr) == 0 {
				return fmt.Errorf("invalid ontology node: atom missing source_message_ids")
			}
		}
	}
	if len(scenarios) == 0 {
		return nil
	}
	contains := map[string]int{}
	hasScenario := map[string]struct{}{}
	for _, e := range edges {
		switch e.RelationType {
		case "CONTAINS_ATOM":
			if _, ok := scenarios[e.SourceNodeID]; ok {
				if _, isAtom := atomEntityTypes[byID[e.TargetNodeID]]; isAtom {
					contains[e.SourceNodeID]++
				}
			}
		case "HAS_SCENARIO":
			if _, ok := customers[e.SourceNodeID]; ok {
				if _, ok := scenarios[e.TargetNodeID]; ok {
					hasScenario[e.TargetNodeID] = struct{}{}
				}
			}
		}
	}
	for sid := range scenarios {
		if contains[sid] < 1 {
			return fmt.Errorf("invalid ontology edge: Scenario missing CONTAINS_ATOM")
		}
		if _, ok := hasScenario[sid]; !ok {
			return fmt.Errorf("invalid ontology edge: Scenario missing HAS_SCENARIO")
		}
	}
	return nil
}

func insertOntology(ctx context.Context, tx pgx.Tx, raw []byte) error {
	env, err := Parse(raw)
	if err != nil {
		return err
	}
	var wrap struct {
		Payload struct {
			Nodes []ontologyNodeIn `json:"nodes"`
			Edges []ontologyEdgeIn `json:"edges"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		return err
	}
	if err := validateOntologyPyramid(wrap.Payload.Nodes, wrap.Payload.Edges); err != nil {
		return err
	}
	for _, n := range wrap.Payload.Nodes {
		id, err := uuid.Parse(n.ID)
		if err != nil || n.EntityType == "" || n.Name == "" {
			return fmt.Errorf("invalid ontology node")
		}
		props, _ := json.Marshal(n.Properties)
		if n.Properties == nil {
			props = []byte("{}")
		}
		var ext any
		if n.ExternalRefID != "" {
			ext = n.ExternalRefID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO ontology_nodes (id, account_id, entity_type, name, external_ref_id, properties)
			VALUES ($1,$2,$3,$4,$5,$6::jsonb)
			ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, properties = EXCLUDED.properties, updated_at = CURRENT_TIMESTAMP`,
			id, env.AccountID, n.EntityType, n.Name, ext, string(props)); err != nil {
			return err
		}
	}
	for _, e := range wrap.Payload.Edges {
		id, err := uuid.Parse(e.ID)
		src, err2 := uuid.Parse(e.SourceNodeID)
		dst, err3 := uuid.Parse(e.TargetNodeID)
		if err != nil || err2 != nil || err3 != nil || e.RelationType == "" {
			return fmt.Errorf("invalid ontology edge")
		}
		if e.Weight == 0 {
			e.Weight = 1
		}
		if e.Confidence == 0 {
			e.Confidence = 1
		}
		validFrom := time.Now().UTC()
		if e.ValidFrom != "" {
			if t, err := parseOccurred(e.ValidFrom); err == nil {
				validFrom = t
			}
		}
		var until any
		if e.ValidUntil != nil && *e.ValidUntil != "" {
			until = *e.ValidUntil
		}
		var srcConv any
		if e.SourceConversationID != "" {
			srcConv = e.SourceConversationID
		} else if env.ConversationID != uuid.Nil.String() {
			srcConv = env.ConversationID
		}
		if _, err := tx.Exec(ctx, `
			UPDATE ontology_edges SET valid_until = CURRENT_TIMESTAMP
			WHERE account_id = $1 AND source_node_id = $2 AND target_node_id = $3 AND relation_type = $4
			  AND valid_until IS NULL AND id <> $5`,
			env.AccountID, src, dst, e.RelationType, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO ontology_edges (
				id, account_id, source_node_id, target_node_id, relation_type, weight,
				valid_from, valid_until, confidence, last_observed_at, source_conversation_id
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP,$10)
			ON CONFLICT (id) DO NOTHING`,
			id, env.AccountID, src, dst, e.RelationType, e.Weight, validFrom, until, e.Confidence, srcConv); err != nil {
			return err
		}
	}
	return nil
}

func insertEmbedding(ctx context.Context, tx pgx.Tx, raw []byte) error {
	env, err := Parse(raw)
	if err != nil {
		return err
	}
	var wrap struct {
		Payload struct {
			OwnerType string    `json:"owner_type"`
			OwnerID   string    `json:"owner_id"`
			Model     string    `json:"model"`
			Version   int       `json:"version"`
			Embedding []float64 `json:"embedding"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		return err
	}
	ownerID, err := uuid.Parse(wrap.Payload.OwnerID)
	if err != nil || wrap.Payload.OwnerType == "" || wrap.Payload.Model == "" {
		return fmt.Errorf("invalid embedding")
	}
	if dim := len(wrap.Payload.Embedding); dim < 1 || dim > 4000 {
		return fmt.Errorf("invalid embedding dim")
	}
	if wrap.Payload.Version < 1 {
		wrap.Payload.Version = 1
	}
	parts := make([]string, len(wrap.Payload.Embedding))
	for i, v := range wrap.Payload.Embedding {
		parts[i] = fmt.Sprintf("%g", v)
	}
	vec := "[" + strings.Join(parts, ",") + "]"
	_, err = tx.Exec(ctx, `
		INSERT INTO embeddings (id, account_id, owner_type, owner_id, model, version, embedding)
		VALUES ($1,$2,$3,$4,$5,$6,$7::halfvec)
		ON CONFLICT (account_id, owner_type, owner_id, model, version)
		DO UPDATE SET embedding = EXCLUDED.embedding`,
		env.ID, env.AccountID, wrap.Payload.OwnerType, ownerID, wrap.Payload.Model, wrap.Payload.Version, vec)
	return err
}
