package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

type InboxPatch struct {
	Name                 *string
	ChannelType          *string
	EmailAddress         *string
	KakaoSenderKey       *string
	GreetingMessage      *string
	BusinessHoursEnabled *bool
	BusinessHours        json.RawMessage
}

type Inboxes interface {
	GetInbox(ctx context.Context, actor, account, inbox uuid.UUID) (InboxHMAC, error)
	RotateHMAC(ctx context.Context, actor, account, inbox uuid.UUID) (InboxHMAC, error)
	UpdateInbox(ctx context.Context, actor, account, inbox uuid.UUID, patch InboxPatch) (InboxHMAC, error)
	ListInboxes(ctx context.Context, actor, account uuid.UUID) ([]InboxHMAC, error)
	CreateInbox(ctx context.Context, actor, account uuid.UUID, name, channel, email, kakao string) (InboxHMAC, error)
	DeleteInbox(ctx context.Context, actor, account, inbox uuid.UUID) error
}

type InboxHMAC struct {
	ID                   uuid.UUID
	Name                 string
	ChannelType          string
	HMACSecret           string
	GreetingMessage      string
	BusinessHoursEnabled bool
	BusinessHours        json.RawMessage
	EmailAddress         string
	KakaoSenderKey       string
}

var defaultChannelTypes = []string{"web", "email", "kakao"}

func EnabledChannelTypes(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return append([]string{}, defaultChannelTypes...)
	}
	seen := map[string]bool{}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		t := strings.ToLower(strings.TrimSpace(part))
		if t != "web" && t != "email" && t != "kakao" {
			continue
		}
		if seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	if len(out) == 0 {
		return append([]string{}, defaultChannelTypes...)
	}
	return out
}

func (s *Server) channelTypes() []string {
	if len(s.EnabledChannels) > 0 {
		return s.EnabledChannels
	}
	return EnabledChannelTypes(os.Getenv("AURA_ENABLED_CHANNELS"))
}

func (s *Server) channelEnabled(channel string) bool {
	for _, t := range s.channelTypes() {
		if t == channel {
			return true
		}
	}
	return false
}

func (s *Server) handleChannels(w http.ResponseWriter, r *http.Request) {
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
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"channel_types": s.channelTypes()})
}

func (s *Server) handleInboxCollection(w http.ResponseWriter, r *http.Request) {
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
	switch r.Method {
	case http.MethodGet:
		list, err := s.Service.Inboxes.ListInboxes(r.Context(), tok.UserID, accountID)
		if err != nil {
			s.writeMemberErr(w, err)
			return
		}
		rows := make([]map[string]any, 0, len(list))
		for _, row := range list {
			rows = append(rows, inboxJSON(row, false))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"inboxes": rows})
	case http.MethodPost:
		var body struct {
			Name           string `json:"name"`
			ChannelType    string `json:"channel_type"`
			EmailAddress   string `json:"email_address"`
			KakaoSenderKey string `json:"kakao_sender_key"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if !s.channelEnabled(strings.ToLower(strings.TrimSpace(body.ChannelType))) {
			http.Error(w, "invalid", http.StatusBadRequest)
			return
		}
		got, err := s.Service.Inboxes.CreateInbox(r.Context(), tok.UserID, accountID,
			body.Name, body.ChannelType, body.EmailAddress, body.KakaoSenderKey)
		if err != nil {
			s.writeMemberErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(inboxJSON(got, true))
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
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
	case http.MethodDelete:
		if err := s.Service.Inboxes.DeleteInbox(r.Context(), tok.UserID, accountID, inboxID); err != nil {
			s.writeMemberErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodPatch:
		var body struct {
			Name                 *string         `json:"name"`
			ChannelType          *string         `json:"channel_type"`
			EmailAddress         *string         `json:"email_address"`
			KakaoSenderKey       *string         `json:"kakao_sender_key"`
			GreetingMessage      *string         `json:"greeting_message"`
			BusinessHoursEnabled *bool           `json:"business_hours_enabled"`
			BusinessHours        json.RawMessage `json:"business_hours"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if body.ChannelType != nil && !s.channelEnabled(strings.ToLower(strings.TrimSpace(*body.ChannelType))) {
			http.Error(w, "invalid", http.StatusBadRequest)
			return
		}
		got, err = s.Service.Inboxes.UpdateInbox(r.Context(), tok.UserID, accountID, inboxID, InboxPatch{
			Name: body.Name, ChannelType: body.ChannelType, EmailAddress: body.EmailAddress,
			KakaoSenderKey: body.KakaoSenderKey, GreetingMessage: body.GreetingMessage,
			BusinessHoursEnabled: body.BusinessHoursEnabled, BusinessHours: body.BusinessHours,
		})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	if err != nil {
		s.writeMemberErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(inboxJSON(got, true))
}

func inboxJSON(got InboxHMAC, secret bool) map[string]any {
	hours := got.BusinessHours
	if len(hours) == 0 {
		hours = json.RawMessage(`{}`)
	}
	out := map[string]any{
		"id": got.ID.String(), "name": got.Name, "channel_type": got.ChannelType,
		"greeting_message": got.GreetingMessage, "business_hours_enabled": got.BusinessHoursEnabled,
		"business_hours": hours, "email_address": got.EmailAddress, "kakao_sender_key": got.KakaoSenderKey,
	}
	if secret {
		out["hmac_secret"] = got.HMACSecret
	}
	return out
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

func (r *natsRPC) UpdateInbox(ctx context.Context, actor, account, inbox uuid.UUID, patch InboxPatch) (InboxHMAC, error) {
	payload := map[string]any{
		"actor_user_id": actor.String(),
		"account_id":    account.String(),
		"inbox_id":      inbox.String(),
	}
	if patch.Name != nil {
		payload["name"] = *patch.Name
	}
	if patch.ChannelType != nil {
		payload["channel_type"] = *patch.ChannelType
	}
	if patch.EmailAddress != nil {
		payload["email_address"] = *patch.EmailAddress
	}
	if patch.KakaoSenderKey != nil {
		payload["kakao_sender_key"] = *patch.KakaoSenderKey
	}
	if patch.GreetingMessage != nil {
		payload["greeting_message"] = *patch.GreetingMessage
	}
	if patch.BusinessHoursEnabled != nil {
		payload["business_hours_enabled"] = *patch.BusinessHoursEnabled
	}
	if len(patch.BusinessHours) > 0 {
		payload["business_hours"] = patch.BusinessHours
	}
	return r.inboxHMAC(ctx, core.SubjectInboxUpdate, payload)
}

func (r *natsRPC) ListInboxes(ctx context.Context, actor, account uuid.UUID) ([]InboxHMAC, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(),
		"account_id":    account.String(),
	})
	if err != nil {
		return nil, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectInboxList, body)
	if err != nil {
		return nil, err
	}
	var out struct {
		OK      bool   `json:"ok"`
		Error   string `json:"error"`
		Inboxes []struct {
			ID                   string          `json:"id"`
			Name                 string          `json:"name"`
			ChannelType          string          `json:"channel_type"`
			GreetingMessage      string          `json:"greeting_message"`
			BusinessHoursEnabled bool            `json:"business_hours_enabled"`
			BusinessHours        json.RawMessage `json:"business_hours"`
			EmailAddress         string          `json:"email_address"`
			KakaoSenderKey       string          `json:"kakao_sender_key"`
		} `json:"inboxes"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, memberRPCErr(out.Error)
	}
	list := make([]InboxHMAC, 0, len(out.Inboxes))
	for _, row := range out.Inboxes {
		id, err := uuid.Parse(row.ID)
		if err != nil {
			return nil, err
		}
		list = append(list, InboxHMAC{
			ID: id, Name: row.Name, ChannelType: row.ChannelType,
			GreetingMessage: row.GreetingMessage, BusinessHoursEnabled: row.BusinessHoursEnabled,
			BusinessHours: row.BusinessHours, EmailAddress: row.EmailAddress, KakaoSenderKey: row.KakaoSenderKey,
		})
	}
	return list, nil
}

func (r *natsRPC) CreateInbox(ctx context.Context, actor, account uuid.UUID, name, channel, email, kakao string) (InboxHMAC, error) {
	return r.inboxHMAC(ctx, core.SubjectInboxCreate, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"name": name, "channel_type": channel, "email_address": email, "kakao_sender_key": kakao,
	})
}

func (r *natsRPC) DeleteInbox(ctx context.Context, actor, account, inbox uuid.UUID) error {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(),
		"account_id":    account.String(),
		"inbox_id":      inbox.String(),
	})
	if err != nil {
		return err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectInboxDelete, body)
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
		return memberRPCErr(out.Error)
	}
	return nil
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
		EmailAddress         string          `json:"email_address"`
		KakaoSenderKey       string          `json:"kakao_sender_key"`
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
		BusinessHours: out.BusinessHours, EmailAddress: out.EmailAddress, KakaoSenderKey: out.KakaoSenderKey,
	}, nil
}
