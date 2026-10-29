package core

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go/jetstream"
)

type DB interface {
	Begin(context.Context) (pgx.Tx, error)
}

type Service struct {
	DB DB
	JS jetstream.JetStream
}

type CreateInput struct {
	AccountID uuid.UUID
	InboxID   uuid.UUID
	SourceID  string
	Name      string
	TraceID   string
}

type CreateResult struct {
	ContactID      uuid.UUID
	ContactInboxID uuid.UUID
	ConversationID uuid.UUID
	DisplayID      int64
	Status         string
	Version        int
}

type TransitionInput struct {
	AccountID       uuid.UUID
	ConversationID  uuid.UUID
	NewStatus       string
	ExpectedVersion int
	ActorType       string
	ActorID         *uuid.UUID
	TraceID         string
}

type TransitionResult struct {
	Status  string
	Version int
}

func (s *Service) Create(ctx context.Context, in CreateInput) (CreateResult, error) {
	if in.SourceID == "" || in.AccountID == uuid.Nil || in.InboxID == uuid.Nil {
		return CreateResult{}, fmt.Errorf("invalid create")
	}
	contactID, err := uuid.NewV7()
	if err != nil {
		return CreateResult{}, err
	}
	ciID, err := uuid.NewV7()
	if err != nil {
		return CreateResult{}, err
	}
	convID, err := uuid.NewV7()
	if err != nil {
		return CreateResult{}, err
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return CreateResult{}, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return CreateResult{}, err
	}
	var inboxOK bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM inboxes WHERE id = $1)`, in.InboxID).Scan(&inboxOK); err != nil {
		return CreateResult{}, err
	}
	if !inboxOK {
		return CreateResult{}, ErrNotFound
	}

	name := in.Name
	if name == "" {
		name = "Guest"
	}
	if _, err := tx.Exec(ctx, `INSERT INTO contacts (id, account_id, name) VALUES ($1,$2,$3)`, contactID, in.AccountID, name); err != nil {
		return CreateResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO contact_inboxes (id, account_id, contact_id, inbox_id, source_id, pubsub_token)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		ciID, in.AccountID, contactID, in.InboxID, in.SourceID, uuid.NewString()); err != nil {
		return CreateResult{}, err
	}

	var displayID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO account_sequences (account_id, last_conversation_display_id)
		VALUES ($1, 1)
		ON CONFLICT (account_id) DO UPDATE
		SET last_conversation_display_id = account_sequences.last_conversation_display_id + 1
		RETURNING last_conversation_display_id`, in.AccountID).Scan(&displayID); err != nil {
		return CreateResult{}, err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO conversations (
			id, account_id, inbox_id, contact_id, contact_inbox_id, status, display_id, version
		) VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
		convID, in.AccountID, in.InboxID, contactID, ciID, StatusUnassigned, displayID); err != nil {
		return CreateResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CreateResult{}, err
	}
	return CreateResult{
		ContactID:      contactID,
		ContactInboxID: ciID,
		ConversationID: convID,
		DisplayID:      displayID,
		Status:         StatusUnassigned,
		Version:        1,
	}, nil
}

func (s *Service) Transition(ctx context.Context, in TransitionInput) (TransitionResult, error) {
	if in.ExpectedVersion < 1 || in.NewStatus == "" {
		return TransitionResult{}, fmt.Errorf("invalid transition")
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return TransitionResult{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return TransitionResult{}, err
	}

	var status string
	var version int
	var inboxID uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT status, version, inbox_id FROM conversations WHERE id = $1`, in.ConversationID,
	).Scan(&status, &version, &inboxID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return TransitionResult{}, ErrNotFound
		}
		return TransitionResult{}, err
	}
	if version != in.ExpectedVersion {
		return TransitionResult{}, ErrConflict
	}
	if !CanTransition(status, in.NewStatus) {
		return TransitionResult{}, ErrForbidden
	}

	tag, err := tx.Exec(ctx, `
		UPDATE conversations
		SET status = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP
		WHERE id = $2 AND version = $3`,
		in.NewStatus, in.ConversationID, in.ExpectedVersion)
	if err != nil {
		return TransitionResult{}, err
	}
	if tag.RowsAffected() != 1 {
		return TransitionResult{}, ErrConflict
	}

	eventID, err := uuid.NewV7()
	if err != nil {
		return TransitionResult{}, err
	}
	occurred := time.Now().UTC()
	payload, err := json.Marshal(map[string]any{
		"old_status":       status,
		"new_status":       in.NewStatus,
		"expected_version": in.ExpectedVersion,
		"actor_type":       in.ActorType,
		"actor_id":         in.ActorID,
	})
	if err != nil {
		return TransitionResult{}, err
	}
	env, err := json.Marshal(map[string]any{
		"id":              eventID.String(),
		"schema_version":  1,
		"type":            "status_changed",
		"occurred_at":     occurred.Format(time.RFC3339Nano),
		"account_id":      in.AccountID.String(),
		"inbox_id":        inboxID.String(),
		"conversation_id": in.ConversationID.String(),
		"trace_id":        in.TraceID,
		"hop_count":       0,
		"payload":         json.RawMessage(payload),
	})
	if err != nil {
		return TransitionResult{}, err
	}
	subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.status_changed", in.AccountID, inboxID, in.ConversationID)
	if _, err := tx.Exec(ctx, `
		INSERT INTO event_outbox (id, account_id, subject, payload) VALUES ($1,$2,$3,$4::jsonb)`,
		eventID, in.AccountID, subject, string(env)); err != nil {
		return TransitionResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TransitionResult{}, err
	}
	s.publishOutbox(ctx, in.AccountID, eventID, subject, env)
	return TransitionResult{Status: in.NewStatus, Version: in.ExpectedVersion + 1}, nil
}

func (s *Service) publishOutbox(ctx context.Context, accountID, eventID uuid.UUID, subject string, env []byte) {
	if s.JS == nil {
		return
	}
	if _, err := s.JS.Publish(ctx, subject, env); err != nil {
		return
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	_, _ = tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, accountID.String())
	_, _ = tx.Exec(ctx, `UPDATE event_outbox SET published_at = CURRENT_TIMESTAMP WHERE id = $1`, eventID)
	_ = tx.Commit(ctx)
}
