package core

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type NoteInput struct {
	ActorUserID    uuid.UUID
	AccountID      uuid.UUID
	ConversationID uuid.UUID
	Content        string
	TraceID        string
}

type NoteResult struct {
	MessageID      uuid.UUID
	InboxID        uuid.UUID
	ConversationID uuid.UUID
	ContactID      uuid.UUID
	ContactInboxID uuid.UUID
	SenderID       uuid.UUID
	Content        string
	Private        bool
}

func (s *Service) AddNote(ctx context.Context, in NoteInput) (NoteResult, error) {
	content := strings.TrimSpace(in.Content)
	if content == "" {
		return NoteResult{}, ErrInvalid
	}
	if in.ActorUserID == uuid.Nil || in.AccountID == uuid.Nil || in.ConversationID == uuid.Nil {
		return NoteResult{}, ErrNotFound
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return NoteResult{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return NoteResult{}, err
	}

	var inboxID, contactID, contactInboxID uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT inbox_id, contact_id, contact_inbox_id FROM conversations WHERE id = $1`,
		in.ConversationID,
	).Scan(&inboxID, &contactID, &contactInboxID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return NoteResult{}, ErrNotFound
		}
		return NoteResult{}, err
	}
	if err := requireAssignActor(ctx, tx, in.AccountID, inboxID, in.ActorUserID); err != nil {
		return NoteResult{}, err
	}

	msgID, err := uuid.NewV7()
	if err != nil {
		return NoteResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO messages (
			id, account_id, inbox_id, conversation_id,
			message_type, content, private, status, content_type, sender_type, sender_id
		) VALUES ($1,$2,$3,$4,1,$5,TRUE,'sent','text','User',$6)`,
		msgID, in.AccountID, inboxID, in.ConversationID, content, in.ActorUserID); err != nil {
		return NoteResult{}, err
	}
	if err := s.writeNoteOutbox(ctx, tx, in, msgID, inboxID, contactID, contactInboxID, content); err != nil {
		return NoteResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return NoteResult{}, err
	}
	return NoteResult{
		MessageID: msgID, InboxID: inboxID, ConversationID: in.ConversationID,
		ContactID: contactID, ContactInboxID: contactInboxID, SenderID: in.ActorUserID,
		Content: content, Private: true,
	}, nil
}

func (s *Service) writeNoteOutbox(ctx context.Context, tx pgx.Tx, in NoteInput, msgID, inboxID, contactID, contactInboxID uuid.UUID, content string) error {
	payload, err := json.Marshal(map[string]any{
		"content":          content,
		"message_type":     1,
		"private":          true,
		"status":           "sent",
		"content_type":     "text",
		"sender_type":      "User",
		"sender_id":        in.ActorUserID.String(),
		"contact_id":       contactID.String(),
		"contact_inbox_id": contactInboxID.String(),
		"attachments":      []any{},
	})
	if err != nil {
		return err
	}
	env, err := json.Marshal(map[string]any{
		"id":              msgID.String(),
		"schema_version":  1,
		"type":            "message_created",
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
	subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.message_created", in.AccountID, inboxID, in.ConversationID)
	_, err = tx.Exec(ctx, `
		INSERT INTO event_outbox (id, account_id, subject, payload) VALUES ($1,$2,$3,$4::jsonb)`,
		msgID, in.AccountID, subject, string(env))
	return err
}
