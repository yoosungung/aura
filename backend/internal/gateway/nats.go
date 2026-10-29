package gateway

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/contracts"
	"github.com/yoosungung/aura/internal/core"
)

type natsRPC struct {
	nc *nats.Conn
}

type natsBus struct {
	nc *nats.Conn
	js jetstream.JetStream
}

func NewRPC(nc *nats.Conn) *natsRPC {
	return &natsRPC{nc: nc}
}

func NewBus(nc *nats.Conn, js jetstream.JetStream) Bus {
	return &natsBus{nc: nc, js: js}
}

func (r *natsRPC) Create(ctx context.Context, accountID, inboxID uuid.UUID, sourceID, name, traceID string) (CreateOut, error) {
	body, err := json.Marshal(contracts.ConversationsCreate{
		AccountID: accountID.String(),
		InboxID:   inboxID.String(),
		SourceID:  sourceID,
		Name:      name,
		TraceID:   traceID,
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

func (r *natsRPC) Login(ctx context.Context, email, password string) (AuthOut, error) {
	return r.authRPC(ctx, core.SubjectAuthLogin, map[string]any{"email": email, "password": password})
}

func (r *natsRPC) Refresh(ctx context.Context, sessionToken string) (AuthOut, error) {
	return r.authRPC(ctx, core.SubjectAuthRefresh, map[string]any{"session_token": sessionToken})
}

func (r *natsRPC) Logout(ctx context.Context, sessionToken string) error {
	body, err := json.Marshal(map[string]any{"session_token": sessionToken})
	if err != nil {
		return err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectAuthLogout, body)
	if err != nil {
		return err
	}
	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return err
	}
	if !out.OK {
		if out.Error == "" {
			out.Error = "rpc_failed"
		}
		return fmt.Errorf("%s", out.Error)
	}
	return nil
}

func (r *natsRPC) authRPC(ctx context.Context, subject string, payload map[string]any) (AuthOut, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return AuthOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, subject, body)
	if err != nil {
		return AuthOut{}, err
	}
	var out struct {
		OK           bool   `json:"ok"`
		Error        string `json:"error"`
		UserID       string `json:"user_id"`
		Email        string `json:"email"`
		Name         string `json:"name"`
		SessionID    string `json:"session_id"`
		SessionToken string `json:"session_token"`
		Accounts     []struct {
			AccountID string   `json:"account_id"`
			Role      string   `json:"role"`
			InboxIDs  []string `json:"inbox_ids"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return AuthOut{}, err
	}
	if !out.OK {
		if out.Error == "" {
			out.Error = "rpc_failed"
		}
		return AuthOut{}, fmt.Errorf("%s", out.Error)
	}
	userID, err := uuid.Parse(out.UserID)
	if err != nil {
		return AuthOut{}, err
	}
	sessionID, err := uuid.Parse(out.SessionID)
	if err != nil {
		return AuthOut{}, err
	}
	accounts := make([]AuthAccount, 0, len(out.Accounts))
	for _, a := range out.Accounts {
		accountID, err := uuid.Parse(a.AccountID)
		if err != nil {
			return AuthOut{}, err
		}
		ids := make([]uuid.UUID, 0, len(a.InboxIDs))
		for _, s := range a.InboxIDs {
			id, err := uuid.Parse(s)
			if err != nil {
				return AuthOut{}, err
			}
			ids = append(ids, id)
		}
		accounts = append(accounts, AuthAccount{AccountID: accountID, Role: a.Role, InboxIDs: ids})
	}
	return AuthOut{
		UserID: userID, Email: out.Email, Name: out.Name,
		SessionID: sessionID, SessionToken: out.SessionToken, Accounts: accounts,
	}, nil
}

func (b *natsBus) PublishEvent(ctx context.Context, subject string, data []byte) error {
	_, err := b.js.Publish(ctx, subject, data)
	return err
}

func (b *natsBus) PublishRealtime(subject string, data []byte) error {
	return b.nc.Publish(subject, data)
}
