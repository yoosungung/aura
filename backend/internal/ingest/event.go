package ingest

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type Envelope struct {
	ID             uuid.UUID       `json:"id"`
	SchemaVersion  int             `json:"schema_version"`
	Type           string          `json:"type"`
	OccurredAt     time.Time       `json:"occurred_at"`
	AccountID      uuid.UUID       `json:"account_id"`
	InboxID        uuid.UUID       `json:"inbox_id"`
	ConversationID uuid.UUID       `json:"conversation_id"`
	TraceID        string          `json:"trace_id"`
	CausationID    *uuid.UUID      `json:"causation_id"`
	HopCount       int             `json:"hop_count"`
	Payload        json.RawMessage `json:"payload"`
}

type MessageCreated struct {
	Content        string    `json:"content"`
	MessageType    int       `json:"message_type"`
	Private        bool      `json:"private"`
	Status         string    `json:"status"`
	ContentType    string    `json:"content_type"`
	SourceID       *string   `json:"source_id"`
	SenderType     string    `json:"sender_type"`
	SenderID       uuid.UUID `json:"sender_id"`
	ContactID      uuid.UUID `json:"contact_id"`
	ContactInboxID uuid.UUID `json:"contact_inbox_id"`
}

func Parse(raw []byte) (Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return Envelope{}, fmt.Errorf("invalid json: %w", err)
	}
	if env.ID == uuid.Nil || env.SchemaVersion != 1 || env.Type == "" || env.TraceID == "" {
		return Envelope{}, fmt.Errorf("invalid envelope")
	}
	if env.AccountID == uuid.Nil || env.InboxID == uuid.Nil || env.ConversationID == uuid.Nil {
		return Envelope{}, fmt.Errorf("invalid envelope ids")
	}
	return env, nil
}

func (e Envelope) MessageCreated() (MessageCreated, error) {
	if e.Type != "message_created" {
		return MessageCreated{}, fmt.Errorf("type %s", e.Type)
	}
	var p MessageCreated
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return MessageCreated{}, fmt.Errorf("payload: %w", err)
	}
	if p.SenderType == "" || p.SenderID == uuid.Nil || p.ContactID == uuid.Nil || p.ContactInboxID == uuid.Nil {
		return MessageCreated{}, fmt.Errorf("invalid message payload")
	}
	if p.Status == "" {
		p.Status = "sent"
	}
	if p.ContentType == "" {
		p.ContentType = "text"
	}
	return p, nil
}
