package core

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/ingest"
)

type SnoozeInput struct {
	ActorUserID     uuid.UUID
	AccountID       uuid.UUID
	ConversationID  uuid.UUID
	Until           time.Time
	ExpectedVersion int
	TraceID         string
}

type SnoozeResult struct {
	Status       string
	Version      int
	SnoozedUntil time.Time
}

func (s *Service) Snooze(ctx context.Context, in SnoozeInput) (SnoozeResult, error) {
	if in.Until.IsZero() || !in.Until.After(time.Now().UTC()) {
		return SnoozeResult{}, ErrInvalid
	}
	return s.mutateSnooze(ctx, in, StatusSnoozed, &in.Until)
}

func SnoozeScheduleSubject(conversationID uuid.UUID) string {
	return "helpdesk.tasks.snooze.schedule." + conversationID.String()
}

func SnoozeWakeSubject(conversationID uuid.UUID) string {
	return "helpdesk.tasks.snooze.wake." + conversationID.String()
}

func (s *Service) WakeDue(ctx context.Context, accountID, conversationID uuid.UUID) (SnoozeResult, error) {
	return s.mutateSnooze(ctx, SnoozeInput{
		AccountID: accountID, ConversationID: conversationID,
	}, StatusOpen, nil)
}

func (s *Service) mutateSnooze(ctx context.Context, in SnoozeInput, newStatus string, until *time.Time) (SnoozeResult, error) {
	if in.AccountID == uuid.Nil || in.ConversationID == uuid.Nil {
		return SnoozeResult{}, ErrNotFound
	}
	if newStatus == StatusSnoozed && (in.ActorUserID == uuid.Nil || in.ExpectedVersion < 1) {
		return SnoozeResult{}, ErrNotFound
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return SnoozeResult{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return SnoozeResult{}, err
	}

	var status string
	var version int
	var inboxID uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT status, version, inbox_id FROM conversations WHERE id = $1`, in.ConversationID,
	).Scan(&status, &version, &inboxID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return SnoozeResult{}, ErrNotFound
		}
		return SnoozeResult{}, err
	}
	if newStatus == StatusSnoozed {
		if version != in.ExpectedVersion {
			return SnoozeResult{}, ErrConflict
		}
		if err := requireAssignActor(ctx, tx, in.AccountID, inboxID, in.ActorUserID); err != nil {
			return SnoozeResult{}, err
		}
		if status != StatusUnassigned && status != StatusOpen {
			return SnoozeResult{}, ErrForbidden
		}
	} else {
		if status != StatusSnoozed {
			return SnoozeResult{}, nil
		}
		in.ExpectedVersion = version
	}

	tag, err := tx.Exec(ctx, `
		UPDATE conversations
		SET status = $1, snoozed_until = $2, version = version + 1, updated_at = CURRENT_TIMESTAMP
		WHERE id = $3 AND version = $4`,
		newStatus, until, in.ConversationID, in.ExpectedVersion)
	if err != nil {
		return SnoozeResult{}, err
	}
	if tag.RowsAffected() != 1 {
		return SnoozeResult{}, ErrConflict
	}
	if err := s.writeSnoozeOutbox(ctx, tx, in, inboxID, status, newStatus); err != nil {
		return SnoozeResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SnoozeResult{}, err
	}
	out := SnoozeResult{Status: newStatus, Version: in.ExpectedVersion + 1}
	if until != nil {
		out.SnoozedUntil = until.UTC()
	}
	return out, nil
}

func (s *Service) consumeSnoozeWakes(ctx context.Context) (jetstream.ConsumeContext, error) {
	if s.JS == nil {
		return noopConsume{}, nil
	}
	cons, err := s.JS.CreateOrUpdateConsumer(ctx, ingest.TasksStream, jetstream.ConsumerConfig{
		Durable:       ingest.SnoozeWakeConsumer,
		FilterSubject: ingest.SnoozeWakeFilter,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	})
	if err != nil {
		return nil, err
	}
	return cons.Consume(func(msg jetstream.Msg) {
		s.handleSnoozeWake(msg)
	})
}

func (s *Service) handleSnoozeWake(msg jetstream.Msg) {
	defer func() { _ = msg.Ack() }()
	var req struct {
		AccountID      string `json:"account_id"`
		ConversationID string `json:"conversation_id"`
	}
	if err := json.Unmarshal(msg.Data(), &req); err != nil {
		return
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return
	}
	convID, err := uuid.Parse(req.ConversationID)
	if err != nil {
		return
	}
	_, _ = s.WakeDue(context.Background(), accountID, convID)
}

type noopConsume struct{}

func (noopConsume) Stop()  {}
func (noopConsume) Drain() {}
func (noopConsume) Closed() <-chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}

func (s *Service) writeSnoozeOutbox(ctx context.Context, tx pgx.Tx, in SnoozeInput, inboxID uuid.UUID, oldStatus, newStatus string) error {
	eventID, err := uuid.NewV7()
	if err != nil {
		return err
	}
	actorType, actorID := "System", ""
	if in.ActorUserID != uuid.Nil {
		actorType, actorID = "User", in.ActorUserID.String()
	}
	payload, err := json.Marshal(map[string]any{
		"old_status":       oldStatus,
		"new_status":       newStatus,
		"expected_version": in.ExpectedVersion,
		"actor_type":       actorType,
		"actor_id":         actorID,
	})
	if err != nil {
		return err
	}
	env, err := json.Marshal(map[string]any{
		"id":              eventID.String(),
		"schema_version":  1,
		"type":            "status_changed",
		"occurred_at":     time.Now().UTC().Format(time.RFC3339Nano),
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
	subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.status_changed", in.AccountID, inboxID, in.ConversationID)
	_, err = tx.Exec(ctx, `
		INSERT INTO event_outbox (id, account_id, subject, payload) VALUES ($1,$2,$3,$4::jsonb)`,
		eventID, in.AccountID, subject, string(env))
	return err
}
