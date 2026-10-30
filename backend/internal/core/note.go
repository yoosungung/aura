package core

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/contracts"
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
	return s.writeAgentMessage(ctx, in, true)
}

func (s *Service) writeAgentMessage(ctx context.Context, in NoteInput, private bool) (NoteResult, error) {
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
	msgType := 0
	if private {
		msgType = 1
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO messages (
			id, account_id, inbox_id, conversation_id,
			message_type, content, private, status, content_type, sender_type, sender_id
		) VALUES ($1,$2,$3,$4,$5,$6,$7,'sent','text','User',$8)`,
		msgID, in.AccountID, inboxID, in.ConversationID, msgType, content, private, in.ActorUserID); err != nil {
		return NoteResult{}, err
	}
	env, subject, err := s.writeNoteOutbox(ctx, tx, in, msgID, inboxID, contactID, contactInboxID, content, private, msgType)
	if err != nil {
		return NoteResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return NoteResult{}, err
	}
	if !private {
		s.publishOutbox(ctx, in.AccountID, msgID, subject, env)
	}
	return NoteResult{
		MessageID: msgID, InboxID: inboxID, ConversationID: in.ConversationID,
		ContactID: contactID, ContactInboxID: contactInboxID, SenderID: in.ActorUserID,
		Content: content, Private: private,
	}, nil
}

func (s *Service) writeNoteOutbox(ctx context.Context, tx pgx.Tx, in NoteInput, msgID, inboxID, contactID, contactInboxID uuid.UUID, content string, private bool, msgType int) ([]byte, string, error) {
	env, err := json.Marshal(contracts.MessageCreated{
		ID: msgID.String(), SchemaVersion: 1, Type: "message_created",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		AccountID:  in.AccountID.String(), InboxID: inboxID.String(),
		ConversationID: in.ConversationID.String(), TraceID: in.TraceID, HopCount: 0,
		Payload: contracts.MessageCreatedPayload{
			Content: content, MessageType: msgType, Private: private, Status: "sent",
			ContentType: "text", SenderType: "User", SenderID: in.ActorUserID.String(),
			ContactID: contactID.String(), ContactInboxID: contactInboxID.String(),
			Attachments: []any{},
		},
	})
	if err != nil {
		return nil, "", err
	}
	subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.message_created", in.AccountID, inboxID, in.ConversationID)
	_, err = tx.Exec(ctx, `
		INSERT INTO event_outbox (id, account_id, subject, payload) VALUES ($1,$2,$3,$4::jsonb)`,
		msgID, in.AccountID, subject, string(env))
	return env, subject, err
}
