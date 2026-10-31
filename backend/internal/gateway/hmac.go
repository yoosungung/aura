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
	UpdateInbox(ctx context.Context, actor, account, inbox uuid.UUID, greeting string, hoursOn bool, hours json.RawMessage) (InboxHMAC, error)
}

type InboxHMAC struct {
	ID                   uuid.UUID
	Name                 string
	ChannelType          string
	HMACSecret           string
	GreetingMessage      string
	BusinessHoursEnabled bool
	BusinessHours        json.RawMessage
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
	case http.MethodPatch:
		var body struct {
			GreetingMessage      string          `json:"greeting_message"`
			BusinessHoursEnabled bool            `json:"business_hours_enabled"`
			BusinessHours        json.RawMessage `json:"business_hours"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		got, err = s.Service.Inboxes.UpdateInbox(r.Context(), tok.UserID, accountID, inboxID,
			body.GreetingMessage, body.BusinessHoursEnabled, body.BusinessHours)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	if err != nil {
		s.writeMemberErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	hours := got.BusinessHours
	if len(hours) == 0 {
		hours = json.RawMessage(`{}`)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id": got.ID.String(), "name": got.Name, "channel_type": got.ChannelType,
		"hmac_secret": got.HMACSecret, "greeting_message": got.GreetingMessage,
		"business_hours_enabled": got.BusinessHoursEnabled, "business_hours": hours,
	})
}

func (r *natsRPC) GetInbox(ctx context.Context, actor, account, inbox uuid.UUID) (InboxHMAC, error) {
	return r.inboxHMAC(ctx, core.SubjectInboxGet, map[string]any{
		"actor_user_id": actor.String(),
		"account_id":    account.String(),
		"inbox_id":      inbox.String(),
	})
}

func (r *natsRPC) RotateHMAC(ctx context.Context, actor, account, inbox uuid.UUID) (InboxHMAC, error) {
	return r.inboxHMAC(ctx, core.SubjectInboxRotateHMAC, map[string]any{
		"actor_user_id": actor.String(),
		"account_id":    account.String(),
		"inbox_id":      inbox.String(),
	})
}

func (r *natsRPC) UpdateInbox(ctx context.Context, actor, account, inbox uuid.UUID, greeting string, hoursOn bool, hours json.RawMessage) (InboxHMAC, error) {
	if len(hours) == 0 {
		hours = []byte("{}")
	}
	return r.inboxHMAC(ctx, core.SubjectInboxUpdate, map[string]any{
		"actor_user_id": actor.String(),
		"account_id":    account.String(),
		"inbox_id":      inbox.String(),
		"greeting_message": greeting, "business_hours_enabled": hoursOn,
		"business_hours": hours,
	})
}

func (r *natsRPC) inboxHMAC(ctx context.Context, subject string, payload map[string]any) (InboxHMAC, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return InboxHMAC{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, subject, body)
	if err != nil {
		return InboxHMAC{}, err
	}
	var out struct {
		OK                   bool            `json:"ok"`
		Error                string          `json:"error"`
		ID                   string          `json:"id"`
		Name                 string          `json:"name"`
		ChannelType          string          `json:"channel_type"`
		HMACSecret           string          `json:"hmac_secret"`
		GreetingMessage      string          `json:"greeting_message"`
		BusinessHoursEnabled bool            `json:"business_hours_enabled"`
		BusinessHours        json.RawMessage `json:"business_hours"`
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
	return InboxHMAC{
		ID: id, Name: out.Name, ChannelType: out.ChannelType, HMACSecret: out.HMACSecret,
		GreetingMessage: out.GreetingMessage, BusinessHoursEnabled: out.BusinessHoursEnabled,
		BusinessHours: out.BusinessHours,
	}, nil
}
