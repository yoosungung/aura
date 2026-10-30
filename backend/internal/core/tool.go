package core

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/ingest"
)

type ApproveInput struct {
	ActorUserID    uuid.UUID
	AccountID      uuid.UUID
	ConversationID uuid.UUID
	ExecutionID    uuid.UUID
	TraceID        string
}

type ApproveResult struct {
	ExecutionID uuid.UUID
	ToolName    string
}

func (s *Service) ApproveTool(ctx context.Context, in ApproveInput) (ApproveResult, error) {
	if in.ExecutionID == uuid.Nil || in.ConversationID == uuid.Nil {
		return ApproveResult{}, ErrInvalid
	}
	var out ApproveResult
	var inboxID, contactID, contactInboxID uuid.UUID
	var channel string
	var inputArgs []byte
	err := s.withConversationActor(ctx, ListInput{
		ActorUserID: in.ActorUserID, AccountID: in.AccountID, ConversationID: in.ConversationID,
	}, func(tx pgx.Tx, _ string) error {
		err := tx.QueryRow(ctx, `
			SELECT inbox_id, contact_id, contact_inbox_id, channel_type
			FROM conversations c JOIN inboxes i ON i.id = c.inbox_id
			WHERE c.id = $1`, in.ConversationID,
		).Scan(&inboxID, &contactID, &contactInboxID, &channel)
		if err != nil {
			if err == pgx.ErrNoRows {
				return ErrNotFound
			}
			return err
		}
		var requires bool
		var approved any
		err = tx.QueryRow(ctx, `
			SELECT tool_name, input_args, requires_approval, approved_by
			FROM agent_tool_executions WHERE id = $1 AND conversation_id = $2`,
			in.ExecutionID, in.ConversationID,
		).Scan(&out.ToolName, &inputArgs, &requires, &approved)
		if err != nil {
			if err == pgx.ErrNoRows {
				return ErrNotFound
			}
			return err
		}
		if !requires {
			return ErrInvalid
		}
		if approved != nil {
			return ErrConflict
		}
		out.ExecutionID = in.ExecutionID
		return nil
	})
	if err != nil {
		return ApproveResult{}, err
	}
	eventID := in.ExecutionID
	payload, err := json.Marshal(map[string]any{
		"tool_name": out.ToolName, "input_args": json.RawMessage(inputArgs),
		"output_result": map[string]any{}, "is_success": false,
		"requires_approval": true, "approved_by": in.ActorUserID.String(),
	})
	if err != nil {
		return ApproveResult{}, err
	}
	env, err := json.Marshal(map[string]any{
		"id": eventID.String(), "schema_version": 1, "type": "tool_execution",
		"occurred_at": time.Now().UTC().Format(time.RFC3339Nano),
		"account_id":  in.AccountID.String(), "inbox_id": inboxID.String(),
		"conversation_id": in.ConversationID.String(), "trace_id": in.TraceID, "hop_count": 0,
		"payload": json.RawMessage(payload),
	})
	if err != nil {
		return ApproveResult{}, err
	}
	if s.JS != nil {
		subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.tool_execution", in.AccountID, inboxID, in.ConversationID)
		_, _ = s.JS.Publish(ctx, subject, env)
		task, _ := json.Marshal(map[string]any{
			"account_id": in.AccountID.String(), "inbox_id": inboxID.String(),
			"conversation_id": in.ConversationID.String(), "contact_id": contactID.String(),
			"contact_inbox_id": contactInboxID.String(), "execution_id": in.ExecutionID.String(),
			"channel_type": channel, "tool_name": out.ToolName, "input_args": json.RawMessage(inputArgs),
			"approved_by": in.ActorUserID.String(),
		})
		_, _ = s.JS.Publish(ctx, ingest.AIExecuteSubject, task)
	}
	return out, nil
}

func (s *Service) withConversationActor(ctx context.Context, in ListInput, fn func(pgx.Tx, string) error) error {
	if in.ActorUserID == uuid.Nil || in.AccountID == uuid.Nil || in.ConversationID == uuid.Nil {
		return ErrDenied
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return err
	}
	var inboxID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT inbox_id FROM conversations WHERE id = $1`, in.ConversationID).Scan(&inboxID); err != nil {
		if err == pgx.ErrNoRows {
			return ErrNotFound
		}
		return err
	}
	if err := requireAssignActor(ctx, tx, in.AccountID, inboxID, in.ActorUserID); err != nil {
		return err
	}
	role, err := accountRole(ctx, tx, in.AccountID, in.ActorUserID)
	if err != nil {
		return err
	}
	if err := fn(tx, role); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
