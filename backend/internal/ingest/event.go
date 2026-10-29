package ingest

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/contracts"
)

func Parse(raw []byte) (contracts.MessageCreated, error) {
	var env contracts.MessageCreated
	if err := json.Unmarshal(raw, &env); err != nil {
		return contracts.MessageCreated{}, fmt.Errorf("invalid json: %w", err)
	}
	if env.SchemaVersion != 1 || env.Type == "" || env.TraceID == "" {
		return contracts.MessageCreated{}, fmt.Errorf("invalid envelope")
	}
	if _, err := uuid.Parse(env.ID); err != nil {
		return contracts.MessageCreated{}, fmt.Errorf("invalid envelope ids")
	}
	if _, err := uuid.Parse(env.AccountID); err != nil {
		return contracts.MessageCreated{}, fmt.Errorf("invalid envelope ids")
	}
	if _, err := uuid.Parse(env.InboxID); err != nil {
		return contracts.MessageCreated{}, fmt.Errorf("invalid envelope ids")
	}
	if _, err := uuid.Parse(env.ConversationID); err != nil {
		return contracts.MessageCreated{}, fmt.Errorf("invalid envelope ids")
	}
	return env, nil
}

func MessagePayload(e contracts.MessageCreated) (contracts.MessageCreatedPayload, error) {
	if e.Type != "message_created" {
		return contracts.MessageCreatedPayload{}, fmt.Errorf("type %s", e.Type)
	}
	p := e.Payload
	if p.SenderType == "" || p.SenderID == "" || p.ContactID == "" || p.ContactInboxID == "" {
		return contracts.MessageCreatedPayload{}, fmt.Errorf("invalid message payload")
	}
	if _, err := uuid.Parse(p.SenderID); err != nil {
		return contracts.MessageCreatedPayload{}, fmt.Errorf("invalid message payload")
	}
	if _, err := uuid.Parse(p.ContactID); err != nil {
		return contracts.MessageCreatedPayload{}, fmt.Errorf("invalid message payload")
	}
	if _, err := uuid.Parse(p.ContactInboxID); err != nil {
		return contracts.MessageCreatedPayload{}, fmt.Errorf("invalid message payload")
	}
	if p.Status == "" {
		p.Status = "sent"
	}
	if p.ContentType == "" {
		p.ContentType = "text"
	}
	return p, nil
}

func parseOccurred(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, s)
}
