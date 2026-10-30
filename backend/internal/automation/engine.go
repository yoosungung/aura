package automation

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/contracts"
	"github.com/yoosungung/aura/internal/ingest"
)

const MaxHop = 5

type DB interface {
	Begin(context.Context) (pgx.Tx, error)
}

type Service struct {
	DB DB
	JS jetstream.JetStream
}

type fact struct {
	Status  string
	InboxID uuid.UUID
	Content string
}

type condition struct {
	AttributeKey   string   `json:"attribute_key"`
	FilterOperator string   `json:"filter_operator"`
	Values         []string `json:"values"`
}

type action struct {
	ActionName   string   `json:"action_name"`
	ActionParams []string `json:"action_params"`
}

func (s *Service) Handle(ctx context.Context, env contracts.MessageCreated) error {
	if env.HopCount > MaxHop {
		return nil
	}
	if env.Type != "message_created" {
		return nil
	}
	accountID, err := uuid.Parse(env.AccountID)
	if err != nil {
		return nil
	}
	conversationID, err := uuid.Parse(env.ConversationID)
	if err != nil {
		return nil
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, accountID.String()); err != nil {
		return err
	}
	var f fact
	err = tx.QueryRow(ctx, `SELECT status, inbox_id FROM conversations WHERE id = $1`, conversationID).Scan(&f.Status, &f.InboxID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil
		}
		return err
	}
	f.Content = env.Payload.Content
	rows, err := tx.Query(ctx, `
		SELECT conditions, actions FROM automation_rules
		WHERE account_id = $1 AND enabled AND event_name = $2`,
		accountID, env.Type)
	if err != nil {
		return err
	}
	type rule struct {
		conditions []byte
		actions    []byte
	}
	var rules []rule
	for rows.Next() {
		var r rule
		if err := rows.Scan(&r.conditions, &r.actions); err != nil {
			rows.Close()
			return err
		}
		rules = append(rules, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, r := range rules {
		if !match(r.conditions, f) {
			continue
		}
		if err := s.applyActions(ctx, tx, accountID, conversationID, r.actions, env); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func match(raw []byte, f fact) bool {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == "[]" {
		return true
	}
	var conds []condition
	if err := json.Unmarshal(raw, &conds); err != nil || len(conds) == 0 {
		return true
	}
	for _, c := range conds {
		got := ""
		switch c.AttributeKey {
		case "status":
			got = f.Status
		case "inbox_id":
			got = f.InboxID.String()
		case "content":
			got = f.Content
		default:
			return false
		}
		op := strings.ToLower(c.FilterOperator)
		ok := false
		for _, v := range c.Values {
			switch op {
			case "contains":
				if strings.Contains(got, v) {
					ok = true
				}
			case "not_equal_to":
				if got != v {
					ok = true
				}
			default: // equal_to
				if got == v {
					ok = true
				}
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

func (s *Service) applyActions(ctx context.Context, tx pgx.Tx, accountID, conversationID uuid.UUID, raw []byte, env contracts.MessageCreated) error {
	var acts []action
	if err := json.Unmarshal(raw, &acts); err != nil {
		return nil
	}
	for _, a := range acts {
		switch a.ActionName {
		case "add_label":
			for _, name := range a.ActionParams {
				name = strings.TrimSpace(name)
				if name == "" {
					continue
				}
				if _, err := tx.Exec(ctx, `
					INSERT INTO conversation_labels (account_id, conversation_id, label_id)
					SELECT $1, $2, id FROM labels WHERE account_id = $1 AND name = $3
					ON CONFLICT (conversation_id, label_id) DO NOTHING`,
					accountID, conversationID, name); err != nil {
					return err
				}
			}
		case "change_priority":
			if len(a.ActionParams) == 0 {
				continue
			}
			p := a.ActionParams[0]
			switch p {
			case "low", "medium", "high", "urgent":
				if _, err := tx.Exec(ctx, `UPDATE conversations SET priority = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
					conversationID, p); err != nil {
					return err
				}
			}
		case "send_webhook":
			if s.JS == nil || len(a.ActionParams) == 0 {
				continue
			}
			webhookID := strings.TrimSpace(a.ActionParams[0])
			if webhookID == "" {
				continue
			}
			body, err := json.Marshal(map[string]any{
				"webhook_id": webhookID,
				"account_id": accountID.String(),
				"event":      env,
			})
			if err != nil {
				return err
			}
			if _, err := s.JS.Publish(ctx, ingest.WebhookDeliverSubject, body); err != nil {
				return err
			}
		}
	}
	return nil
}
