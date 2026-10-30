package core

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/contracts"
)

const (
	CSATContent     = "상담은 어떠셨나요?"
	CSATMessageType = 3
)

func (s *Service) enqueueCSAT(ctx context.Context, tx pgx.Tx, in TransitionInput, inboxID, contactID, contactInboxID uuid.UUID) (uuid.UUID, string, []byte, error) {
	msgID, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, "", nil, err
	}
	senderType := "AgentBot"
	senderID := inboxID
	if in.ActorID != nil && *in.ActorID != uuid.Nil {
		senderType = "User"
		senderID = *in.ActorID
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO messages (
			id, account_id, inbox_id, conversation_id,
			message_type, content, private, status, content_type, sender_type, sender_id
		) VALUES ($1,$2,$3,$4,$5,$6,false,'sent','input_csat',$7,$8)`,
		msgID, in.AccountID, inboxID, in.ConversationID, CSATMessageType, CSATContent, senderType, senderID); err != nil {
		return uuid.Nil, "", nil, err
	}
	env, err := json.Marshal(contracts.MessageCreated{
		ID: msgID.String(), SchemaVersion: 1, Type: "message_created",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		AccountID:  in.AccountID.String(), InboxID: inboxID.String(),
		ConversationID: in.ConversationID.String(), TraceID: in.TraceID, HopCount: 0,
		Payload: contracts.MessageCreatedPayload{
			Content: CSATContent, MessageType: CSATMessageType, Private: false, Status: "sent",
			ContentType: "input_csat", SenderType: senderType, SenderID: senderID.String(),
			ContactID: contactID.String(), ContactInboxID: contactInboxID.String(),
			Attachments: []any{},
		},
	})
	if err != nil {
		return uuid.Nil, "", nil, err
	}
	subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.message_created", in.AccountID, inboxID, in.ConversationID)
	if _, err := tx.Exec(ctx, `
		INSERT INTO event_outbox (id, account_id, subject, payload) VALUES ($1,$2,$3,$4::jsonb)`,
		msgID, in.AccountID, subject, string(env)); err != nil {
		return uuid.Nil, "", nil, err
	}
	return msgID, subject, env, nil
}

func (s *Service) publishCSATRealtime(env []byte) {
	if s.NC == nil {
		return
	}
	var e contracts.MessageCreated
	if err := json.Unmarshal(env, &e); err != nil || e.Type != "message_created" || e.Payload.ContentType != "input_csat" {
		return
	}
	rt, err := json.Marshal(map[string]any{
		"type":            "event",
		"event":           "message.created",
		"account_id":      e.AccountID,
		"inbox_id":        e.InboxID,
		"conversation_id": e.ConversationID,
		"message":         json.RawMessage(env),
	})
	if err != nil {
		return
	}
	_ = s.NC.Publish(fmt.Sprintf("helpdesk.realtime.%s.%s.updated", e.AccountID, e.ConversationID), rt)
}
