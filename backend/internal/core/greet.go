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

type GreetInput struct {
	AccountID      uuid.UUID
	ConversationID uuid.UUID
	TraceID        string
}

func (s *Service) Greet(ctx context.Context, in GreetInput) error {
	if in.AccountID == uuid.Nil || in.ConversationID == uuid.Nil {
		return ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return err
	}
	var inboxID, contactID, contactInboxID uuid.UUID
	var greeting string
	err = tx.QueryRow(ctx, `
		SELECT c.inbox_id, c.contact_id, c.contact_inbox_id, COALESCE(i.greeting_message, '')
		FROM conversations c JOIN inboxes i ON i.id = c.inbox_id
		WHERE c.id = $1`, in.ConversationID,
	).Scan(&inboxID, &contactID, &contactInboxID, &greeting)
	if err != nil {
		if err == pgx.ErrNoRows {
			return ErrNotFound
		}
		return err
	}
	greeting = strings.TrimSpace(greeting)
	if greeting == "" {
		return tx.Commit(ctx)
	}
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM messages
			WHERE conversation_id = $1 AND sender_type = 'AgentBot' AND content = $2 AND NOT private
		)`, in.ConversationID, greeting).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return tx.Commit(ctx)
	}
	msgID, err := uuid.NewV7()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO messages (
			id, account_id, inbox_id, conversation_id,
			message_type, content, private, status, content_type, sender_type, sender_id
		) VALUES ($1,$2,$3,$4,1,$5,false,'sent','text','AgentBot',$6)`,
		msgID, in.AccountID, inboxID, in.ConversationID, greeting, inboxID); err != nil {
		return err
	}
	env, err := json.Marshal(contracts.MessageCreated{
		ID: msgID.String(), SchemaVersion: 1, Type: "message_created",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		AccountID:  in.AccountID.String(), InboxID: inboxID.String(),
		ConversationID: in.ConversationID.String(), TraceID: in.TraceID, HopCount: 0,
		Payload: contracts.MessageCreatedPayload{
			Content: greeting, MessageType: 1, Private: false, Status: "sent",
			ContentType: "text", SenderType: "AgentBot", SenderID: inboxID.String(),
			ContactID: contactID.String(), ContactInboxID: contactInboxID.String(),
			Attachments: []any{},
		},
	})
	if err != nil {
		return err
	}
	subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.message_created", in.AccountID, inboxID, in.ConversationID)
	if _, err := tx.Exec(ctx, `
		INSERT INTO event_outbox (id, account_id, subject, payload) VALUES ($1,$2,$3,$4::jsonb)`,
		msgID, in.AccountID, subject, string(env)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.publishOutbox(ctx, in.AccountID, msgID, subject, env)
	return nil
}
