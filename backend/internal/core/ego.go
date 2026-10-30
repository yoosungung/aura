package core

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type EgoInput struct {
	ActorUserID uuid.UUID
	AccountID   uuid.UUID
	ContactID   uuid.UUID
}

type EgoNode struct {
	ID           uuid.UUID
	EntityType   string
	Name         string
	Properties   map[string]any
	RelationType string
	Hop          int
}

const egoSQL = `
WITH center AS (
  SELECT id FROM ontology_nodes
  WHERE account_id = current_setting('app.current_account_id')::uuid
    AND entity_type = 'Customer'
    AND external_ref_id = $1
),
hop1 AS (
  SELECT e.target_node_id AS node_id, e.relation_type, e.weight, 1 AS hop
  FROM ontology_edges e
  JOIN center c ON e.source_node_id = c.id
  WHERE e.account_id = current_setting('app.current_account_id')::uuid
    AND e.valid_from <= CURRENT_TIMESTAMP
    AND (e.valid_until IS NULL OR e.valid_until > CURRENT_TIMESTAMP)
  UNION ALL
  SELECT e.source_node_id, e.relation_type, e.weight, 1
  FROM ontology_edges e
  JOIN center c ON e.target_node_id = c.id
  WHERE e.account_id = current_setting('app.current_account_id')::uuid
    AND e.valid_from <= CURRENT_TIMESTAMP
    AND (e.valid_until IS NULL OR e.valid_until > CURRENT_TIMESTAMP)
),
hop2 AS (
  SELECT e.target_node_id AS node_id, e.relation_type, e.weight, 2 AS hop
  FROM ontology_edges e
  JOIN hop1 h ON e.source_node_id = h.node_id
  JOIN ontology_nodes n ON n.id = e.target_node_id
  WHERE e.account_id = current_setting('app.current_account_id')::uuid
    AND h.hop = 1
    AND n.entity_type <> 'Customer'
    AND e.valid_from <= CURRENT_TIMESTAMP
    AND (e.valid_until IS NULL OR e.valid_until > CURRENT_TIMESTAMP)
)
SELECT n.id, n.entity_type, n.name, n.properties, x.relation_type, x.hop
FROM (
  SELECT * FROM hop1
  UNION
  SELECT * FROM hop2
) x
JOIN ontology_nodes n ON n.id = x.node_id
ORDER BY x.hop ASC, x.weight DESC, n.updated_at DESC
LIMIT 50`

func (s *Service) EgoGraph(ctx context.Context, in EgoInput) ([]EgoNode, error) {
	if in.ContactID == uuid.Nil {
		return nil, ErrInvalid
	}
	var out []EgoNode
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, false, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, egoSQL, in.ContactID.String())
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var n EgoNode
			var props []byte
			if err := rows.Scan(&n.ID, &n.EntityType, &n.Name, &props, &n.RelationType, &n.Hop); err != nil {
				return err
			}
			_ = json.Unmarshal(props, &n.Properties)
			if n.Properties == nil {
				n.Properties = map[string]any{}
			}
			out = append(out, n)
		}
		return rows.Err()
	})
	if out == nil {
		out = []EgoNode{}
	}
	return out, err
}
