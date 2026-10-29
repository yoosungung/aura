package gateway

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/core"
)

type natsRPC struct {
	nc *nats.Conn
}

type natsBus struct {
	nc *nats.Conn
	js jetstream.JetStream
}

func NewRPC(nc *nats.Conn) Creator {
	return &natsRPC{nc: nc}
}

func NewBus(nc *nats.Conn, js jetstream.JetStream) Bus {
	return &natsBus{nc: nc, js: js}
}

func (r *natsRPC) Create(ctx context.Context, accountID, inboxID uuid.UUID, sourceID, name, traceID string) (CreateOut, error) {
	body, err := json.Marshal(map[string]any{
		"account_id": accountID.String(),
		"inbox_id":   inboxID.String(),
		"source_id":  sourceID,
		"name":       name,
		"trace_id":   traceID,
	})
	if err != nil {
		return CreateOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectCreate, body)
	if err != nil {
		return CreateOut{}, err
	}
	var out struct {
		OK             bool   `json:"ok"`
		Error          string `json:"error"`
		ContactID      string `json:"contact_id"`
		ContactInboxID string `json:"contact_inbox_id"`
		ConversationID string `json:"conversation_id"`
		DisplayID      int64  `json:"display_id"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return CreateOut{}, err
	}
	if !out.OK {
		if out.Error == "" {
			out.Error = "rpc_failed"
		}
		return CreateOut{}, fmt.Errorf("%s", out.Error)
	}
	contactID, err := uuid.Parse(out.ContactID)
	if err != nil {
		return CreateOut{}, err
	}
	ciID, err := uuid.Parse(out.ContactInboxID)
	if err != nil {
		return CreateOut{}, err
	}
	convID, err := uuid.Parse(out.ConversationID)
	if err != nil {
		return CreateOut{}, err
	}
	return CreateOut{
		ContactID: contactID, ContactInboxID: ciID,
		ConversationID: convID, DisplayID: out.DisplayID,
	}, nil
}

func (b *natsBus) PublishEvent(ctx context.Context, subject string, data []byte) error {
	_, err := b.js.Publish(ctx, subject, data)
	return err
}

func (b *natsBus) PublishRealtime(subject string, data []byte) error {
	return b.nc.Publish(subject, data)
}
