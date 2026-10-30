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
	return r.create(ctx, accountID, inboxID, sourceID, name, traceID, false)
}

func (r *natsRPC) CreateEmail(ctx context.Context, accountID, inboxID uuid.UUID, sourceID, name, traceID string) (CreateOut, error) {
	return r.create(ctx, accountID, inboxID, sourceID, name, traceID, true)
}

func (r *natsRPC) create(ctx context.Context, accountID, inboxID uuid.UUID, sourceID, name, traceID string, reuse bool) (CreateOut, error) {
	body, err := json.Marshal(contracts.ConversationsCreate{
		AccountID:    accountID.String(),
		InboxID:      inboxID.String(),
		SourceID:     sourceID,
		Name:         name,
		TraceID:      traceID,
		ReuseContact: reuse,
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

func (r *natsRPC) ResolveSender(ctx context.Context, senderKey string) (uuid.UUID, uuid.UUID, error) {
	body, err := json.Marshal(map[string]any{"sender_key": senderKey})
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectInboxResolveKakao, body)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	var out struct {
		OK        bool   `json:"ok"`
		Error     string `json:"error"`
		AccountID string `json:"account_id"`
		InboxID   string `json:"inbox_id"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if !out.OK {
		return uuid.Nil, uuid.Nil, memberRPCErr(out.Error)
	}
	accountID, err := uuid.Parse(out.AccountID)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	inboxID, err := uuid.Parse(out.InboxID)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	return accountID, inboxID, nil
}

func (r *natsRPC) ResolveKakao(ctx context.Context, accountID, inboxID uuid.UUID, msgKey, userKey string) (CreateOut, bool, bool, error) {
	body, err := json.Marshal(map[string]any{
		"account_id": accountID.String(), "inbox_id": inboxID.String(),
		"source_id": msgKey, "user_key": userKey,
	})
	if err != nil {
		return CreateOut{}, false, false, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectResolveKakao, body)
	if err != nil {
		return CreateOut{}, false, false, err
	}
	var out struct {
		OK             bool   `json:"ok"`
		Error          string `json:"error"`
		Found          bool   `json:"found"`
		Duplicate      bool   `json:"duplicate"`
		ContactID      string `json:"contact_id"`
		ContactInboxID string `json:"contact_inbox_id"`
		ConversationID string `json:"conversation_id"`
		DisplayID      int64  `json:"display_id"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return CreateOut{}, false, false, err
	}
	if !out.OK {
		return CreateOut{}, false, false, memberRPCErr(out.Error)
	}
	if !out.Found {
		return CreateOut{}, false, out.Duplicate, nil
	}
	contactID, err := uuid.Parse(out.ContactID)
	if err != nil {
		return CreateOut{}, false, false, err
	}
	ciID, err := uuid.Parse(out.ContactInboxID)
	if err != nil {
		return CreateOut{}, false, false, err
	}
	convID, err := uuid.Parse(out.ConversationID)
	if err != nil {
		return CreateOut{}, false, false, err
	}
	return CreateOut{
		ContactID: contactID, ContactInboxID: ciID,
		ConversationID: convID, DisplayID: out.DisplayID,
	}, true, out.Duplicate, nil
}

func (r *natsRPC) CreateKakao(ctx context.Context, accountID, inboxID uuid.UUID, userKey, name, traceID string) (CreateOut, error) {
	return r.create(ctx, accountID, inboxID, userKey, name, traceID, true)
}

func (r *natsRPC) KakaoReply(ctx context.Context, actor, account, conversation uuid.UUID) (KakaoReplyOut, bool, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"conversation_id": conversation.String(),
	})
	if err != nil {
		return KakaoReplyOut{}, false, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectKakaoReply, body)
	if err != nil {
		return KakaoReplyOut{}, false, err
	}
	var out struct {
		OK          bool   `json:"ok"`
		Error       string `json:"error"`
		Skip        bool   `json:"skip"`
		From        string `json:"from"`
		To          string `json:"to"`
		Template    string `json:"template"`
		Phone       string `json:"phone"`
		SessionLive bool   `json:"session_live"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return KakaoReplyOut{}, false, err
	}
	if !out.OK {
		return KakaoReplyOut{}, false, memberRPCErr(out.Error)
	}
	return KakaoReplyOut{From: out.From, To: out.To, Template: out.Template, Phone: out.Phone, SessionLive: out.SessionLive}, out.Skip, nil
}

func (r *natsRPC) ResolveInbox(ctx context.Context, email string) (uuid.UUID, uuid.UUID, error) {
	body, err := json.Marshal(map[string]any{"email": email})
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectInboxResolveEmail, body)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	var out struct {
		OK        bool   `json:"ok"`
		Error     string `json:"error"`
		AccountID string `json:"account_id"`
		InboxID   string `json:"inbox_id"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if !out.OK {
		if out.Error == "" {
			out.Error = "rpc_failed"
		}
		return uuid.Nil, uuid.Nil, fmt.Errorf("%s", out.Error)
	}
	accountID, err := uuid.Parse(out.AccountID)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	inboxID, err := uuid.Parse(out.InboxID)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	return accountID, inboxID, nil
}

func (r *natsRPC) ResolveThread(ctx context.Context, accountID, inboxID uuid.UUID, sourceID string, replyIDs []string, displayID int64) (CreateOut, bool, bool, error) {
	body, err := json.Marshal(map[string]any{
		"account_id": accountID.String(), "inbox_id": inboxID.String(),
		"source_id": sourceID, "reply_ids": replyIDs, "display_id": displayID,
	})
	if err != nil {
		return CreateOut{}, false, false, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectResolveThread, body)
	if err != nil {
		return CreateOut{}, false, false, err
	}
	var out struct {
		OK             bool   `json:"ok"`
		Error          string `json:"error"`
		Found          bool   `json:"found"`
		Duplicate      bool   `json:"duplicate"`
		ContactID      string `json:"contact_id"`
		ContactInboxID string `json:"contact_inbox_id"`
		ConversationID string `json:"conversation_id"`
		DisplayID      int64  `json:"display_id"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return CreateOut{}, false, false, err
	}
	if !out.OK {
		if out.Error == "" {
			out.Error = "rpc_failed"
		}
		return CreateOut{}, false, false, fmt.Errorf("%s", out.Error)
	}
	if !out.Found {
		return CreateOut{}, false, out.Duplicate, nil
	}
	contactID, err := uuid.Parse(out.ContactID)
	if err != nil {
		return CreateOut{}, false, false, err
	}
	ciID, err := uuid.Parse(out.ContactInboxID)
	if err != nil {
		return CreateOut{}, false, false, err
	}
	convID, err := uuid.Parse(out.ConversationID)
	if err != nil {
		return CreateOut{}, false, false, err
	}
	return CreateOut{
		ContactID: contactID, ContactInboxID: ciID,
		ConversationID: convID, DisplayID: out.DisplayID,
	}, true, out.Duplicate, nil
}

func (r *natsRPC) EmailReply(ctx context.Context, actor, account, conversation uuid.UUID) (EmailReplyOut, bool, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"conversation_id": conversation.String(),
	})
	if err != nil {
		return EmailReplyOut{}, false, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectEmailReply, body)
	if err != nil {
		return EmailReplyOut{}, false, err
	}
	var out struct {
		OK        bool   `json:"ok"`
		Error     string `json:"error"`
		Skip      bool   `json:"skip"`
		From      string `json:"from"`
		To        string `json:"to"`
		InReplyTo string `json:"in_reply_to"`
		DisplayID int64  `json:"display_id"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return EmailReplyOut{}, false, err
	}
	if !out.OK {
		return EmailReplyOut{}, false, memberRPCErr(out.Error)
	}
	return EmailReplyOut{From: out.From, To: out.To, InReplyTo: out.InReplyTo, DisplayID: out.DisplayID}, out.Skip, nil
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
