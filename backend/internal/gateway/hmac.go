package gateway

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

type Inboxes interface {
	GetInbox(ctx context.Context, actor, account, inbox uuid.UUID) (InboxHMAC, error)
	RotateHMAC(ctx context.Context, actor, account, inbox uuid.UUID) (InboxHMAC, error)
}

type InboxHMAC struct {
	ID          uuid.UUID
	Name        string
	ChannelType string
	HMACSecret  string
}

func (s *Server) handleInboxHMAC(w http.ResponseWriter, r *http.Request) {
	if s.Service.Inboxes == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	tok, err := s.bearer(r)
	if err != nil || tok.Kind != KindUser {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	accountID, err := uuid.Parse(r.PathValue("account_id"))
	if err != nil || accountID != tok.AccountID {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	inboxID, err := uuid.Parse(r.PathValue("inbox_id"))
	if err != nil {
		http.Error(w, "invalid inbox", http.StatusBadRequest)
		return
	}
	var got InboxHMAC
	switch r.Method {
	case http.MethodGet:
		got, err = s.Service.Inboxes.GetInbox(r.Context(), tok.UserID, accountID, inboxID)
	case http.MethodPost:
		got, err = s.Service.Inboxes.RotateHMAC(r.Context(), tok.UserID, accountID, inboxID)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	if err != nil {
		s.writeMemberErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id": got.ID.String(), "name": got.Name, "channel_type": got.ChannelType,
		"hmac_secret": got.HMACSecret,
	})
}

func (r *natsRPC) GetInbox(ctx context.Context, actor, account, inbox uuid.UUID) (InboxHMAC, error) {
	return r.inboxHMAC(ctx, core.SubjectInboxGet, actor, account, inbox)
}

func (r *natsRPC) RotateHMAC(ctx context.Context, actor, account, inbox uuid.UUID) (InboxHMAC, error) {
	return r.inboxHMAC(ctx, core.SubjectInboxRotateHMAC, actor, account, inbox)
}

func (r *natsRPC) inboxHMAC(ctx context.Context, subject string, actor, account, inbox uuid.UUID) (InboxHMAC, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(),
		"account_id":    account.String(),
		"inbox_id":      inbox.String(),
	})
	if err != nil {
		return InboxHMAC{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, subject, body)
	if err != nil {
		return InboxHMAC{}, err
	}
	var out struct {
		OK          bool   `json:"ok"`
		Error       string `json:"error"`
		ID          string `json:"id"`
		Name        string `json:"name"`
		ChannelType string `json:"channel_type"`
		HMACSecret  string `json:"hmac_secret"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return InboxHMAC{}, err
	}
	if !out.OK {
		return InboxHMAC{}, memberRPCErr(out.Error)
	}
	id, err := uuid.Parse(out.ID)
	if err != nil {
		return InboxHMAC{}, err
	}
	return InboxHMAC{ID: id, Name: out.Name, ChannelType: out.ChannelType, HMACSecret: out.HMACSecret}, nil
}
