package core

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type AssignInput struct {
	ActorUserID     uuid.UUID
	AccountID       uuid.UUID
	ConversationID  uuid.UUID
	AssigneeID      uuid.UUID
	ExpectedVersion int
	TraceID         string
}

type AssignResult struct {
	AssigneeID uuid.UUID
	Status     string
	Version    int
}

func (s *Service) Assign(ctx context.Context, in AssignInput) (AssignResult, error) {
	if in.ActorUserID == uuid.Nil || in.AccountID == uuid.Nil || in.ConversationID == uuid.Nil || in.AssigneeID == uuid.Nil || in.ExpectedVersion < 1 {
		return AssignResult{}, ErrNotFound
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return AssignResult{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return AssignResult{}, err
	}

	var status string
	var version int
	var inboxID uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT status, version, inbox_id FROM conversations WHERE id = $1`, in.ConversationID,
	).Scan(&status, &version, &inboxID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return AssignResult{}, ErrNotFound
		}
		return AssignResult{}, err
	}
	if version != in.ExpectedVersion {
		return AssignResult{}, ErrConflict
	}
	if err := requireAssignActor(ctx, tx, in.AccountID, inboxID, in.ActorUserID); err != nil {
		return AssignResult{}, err
	}
	var member bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM inbox_members WHERE inbox_id = $1 AND user_id = $2)`,
		inboxID, in.AssigneeID,
	).Scan(&member); err != nil {
		return AssignResult{}, err
	}
	if !member {
		return AssignResult{}, ErrDenied
	}

	newStatus := status
	if status == StatusUnassigned {
		newStatus = StatusOpen
	}
	tag, err := tx.Exec(ctx, `
		UPDATE conversations
		SET assignee_id = $1, status = $2, version = version + 1, updated_at = CURRENT_TIMESTAMP
		WHERE id = $3 AND version = $4`,
		in.AssigneeID, newStatus, in.ConversationID, in.ExpectedVersion)
	if err != nil {
		return AssignResult{}, err
	}
	if tag.RowsAffected() != 1 {
		return AssignResult{}, ErrConflict
	}

	if err := s.writeAssignedOutbox(ctx, tx, in, inboxID, newStatus, status); err != nil {
		return AssignResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AssignResult{}, err
	}
	return AssignResult{AssigneeID: in.AssigneeID, Status: newStatus, Version: in.ExpectedVersion + 1}, nil
}

func requireAssignActor(ctx context.Context, tx pgx.Tx, accountID, inboxID, actor uuid.UUID) error {
	var role string
	err := tx.QueryRow(ctx, `
		SELECT role FROM account_users WHERE account_id = $1 AND user_id = $2`, accountID, actor,
	).Scan(&role)
	if err != nil {
		if err == pgx.ErrNoRows {
			return ErrDenied
		}
		return err
	}
	if role == "administrator" {
		return nil
	}
	var member bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM inbox_members WHERE inbox_id = $1 AND user_id = $2)`,
		inboxID, actor,
	).Scan(&member); err != nil {
		return err
	}
	if !member {
		return ErrDenied
	}
	return nil
}

func (s *Service) writeAssignedOutbox(ctx context.Context, tx pgx.Tx, in AssignInput, inboxID uuid.UUID, newStatus, oldStatus string) error {
	eventID, err := uuid.NewV7()
	if err != nil {
		return err
	}
	occurred := time.Now().UTC()
	payload, err := json.Marshal(map[string]any{"assignee_id": in.AssigneeID.String()})
	if err != nil {
		return err
	}
	env, err := json.Marshal(map[string]any{
		"id":              eventID.String(),
		"schema_version":  1,
		"type":            "assigned",
		"occurred_at":     occurred.Format(time.RFC3339Nano),
		"account_id":      in.AccountID.String(),
		"inbox_id":        inboxID.String(),
		"conversation_id": in.ConversationID.String(),
		"trace_id":        in.TraceID,
		"hop_count":       0,
		"payload":         json.RawMessage(payload),
	})
	if err != nil {
		return err
	}
	subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.assigned", in.AccountID, inboxID, in.ConversationID)
	if _, err := tx.Exec(ctx, `
		INSERT INTO event_outbox (id, account_id, subject, payload) VALUES ($1,$2,$3,$4::jsonb)`,
		eventID, in.AccountID, subject, string(env)); err != nil {
		return err
	}
	if newStatus != oldStatus {
		sid, err := uuid.NewV7()
		if err != nil {
			return err
		}
		spayload, err := json.Marshal(map[string]any{
			"old_status":       oldStatus,
			"new_status":       newStatus,
			"expected_version": in.ExpectedVersion,
			"actor_type":       "User",
			"actor_id":         in.ActorUserID.String(),
		})
		if err != nil {
			return err
		}
		senv, err := json.Marshal(map[string]any{
			"id":              sid.String(),
			"schema_version":  1,
			"type":            "status_changed",
			"occurred_at":     occurred.Format(time.RFC3339Nano),
			"account_id":      in.AccountID.String(),
			"inbox_id":        inboxID.String(),
			"conversation_id": in.ConversationID.String(),
			"trace_id":        in.TraceID,
			"hop_count":       0,
			"payload":         json.RawMessage(spayload),
		})
		if err != nil {
			return err
		}
		ssubject := fmt.Sprintf("helpdesk.events.%s.%s.%s.status_changed", in.AccountID, inboxID, in.ConversationID)
		if _, err := tx.Exec(ctx, `
			INSERT INTO event_outbox (id, account_id, subject, payload) VALUES ($1,$2,$3,$4::jsonb)`,
			sid, in.AccountID, ssubject, string(senv)); err != nil {
			return err
		}
	}
	return nil
}
