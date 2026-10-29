package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

type Members interface {
	AddInboxMember(ctx context.Context, actor, account, inbox, user uuid.UUID) error
	RemoveInboxMember(ctx context.Context, actor, account, inbox, user uuid.UUID) error
	ListInboxMembers(ctx context.Context, actor, account, inbox uuid.UUID) ([]MemberRow, error)
}

type MemberRow struct {
	UserID uuid.UUID
	Email  string
	Name   string
}

func (s *Server) handleInboxMembers(w http.ResponseWriter, r *http.Request) {
	if s.Service.Members == nil {
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
	switch r.Method {
	case http.MethodGet:
		list, err := s.Service.Members.ListInboxMembers(r.Context(), tok.UserID, accountID, inboxID)
		s.writeMembers(w, list, err)
	case http.MethodPut:
		userID, err := uuid.Parse(r.PathValue("user_id"))
		if err != nil {
			http.Error(w, "invalid user", http.StatusBadRequest)
			return
		}
		err = s.Service.Members.AddInboxMember(r.Context(), tok.UserID, accountID, inboxID, userID)
		s.writeMemberOK(w, err)
	case http.MethodDelete:
		userID, err := uuid.Parse(r.PathValue("user_id"))
		if err != nil {
			http.Error(w, "invalid user", http.StatusBadRequest)
			return
		}
		err = s.Service.Members.RemoveInboxMember(r.Context(), tok.UserID, accountID, inboxID, userID)
		s.writeMemberOK(w, err)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (s *Server) writeMemberOK(w http.ResponseWriter, err error) {
	if err != nil {
		s.writeMemberErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) writeMembers(w http.ResponseWriter, list []MemberRow, err error) {
	if err != nil {
		s.writeMemberErr(w, err)
		return
	}
	rows := make([]map[string]string, 0, len(list))
	for _, m := range list {
		rows = append(rows, map[string]string{
			"user_id": m.UserID.String(),
			"email":   m.Email,
			"name":    m.Name,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"members": rows})
}

func (s *Server) writeMemberErr(w http.ResponseWriter, err error) {
	code := http.StatusBadGateway
	if errors.Is(err, core.ErrDenied) || err.Error() == "forbidden" {
		code = http.StatusForbidden
	} else if errors.Is(err, core.ErrNotFound) || err.Error() == "not_found" {
		code = http.StatusNotFound
	}
	http.Error(w, err.Error(), code)
}

func (r *natsRPC) AddInboxMember(ctx context.Context, actor, account, inbox, user uuid.UUID) error {
	return r.memberMutate(ctx, core.SubjectInboxMemberAdd, actor, account, inbox, user)
}

func (r *natsRPC) RemoveInboxMember(ctx context.Context, actor, account, inbox, user uuid.UUID) error {
	return r.memberMutate(ctx, core.SubjectInboxMemberRemove, actor, account, inbox, user)
}

func (r *natsRPC) ListInboxMembers(ctx context.Context, actor, account, inbox uuid.UUID) ([]MemberRow, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(),
		"account_id":    account.String(),
		"inbox_id":      inbox.String(),
	})
	if err != nil {
		return nil, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectInboxMemberList, body)
	if err != nil {
		return nil, err
	}
	var out struct {
		OK      bool   `json:"ok"`
		Error   string `json:"error"`
		Members []struct {
			UserID string `json:"user_id"`
			Email  string `json:"email"`
			Name   string `json:"name"`
		} `json:"members"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, memberRPCErr(out.Error)
	}
	rows := make([]MemberRow, 0, len(out.Members))
	for _, m := range out.Members {
		id, err := uuid.Parse(m.UserID)
		if err != nil {
			return nil, err
		}
		rows = append(rows, MemberRow{UserID: id, Email: m.Email, Name: m.Name})
	}
	return rows, nil
}

func (r *natsRPC) memberMutate(ctx context.Context, subject string, actor, account, inbox, user uuid.UUID) error {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(),
		"account_id":    account.String(),
		"inbox_id":      inbox.String(),
		"user_id":       user.String(),
	})
	if err != nil {
		return err
	}
	msg, err := r.nc.RequestWithContext(ctx, subject, body)
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

func memberRPCErr(code string) error {
	switch code {
	case core.ErrDenied.Error():
		return core.ErrDenied
	case core.ErrNotFound.Error():
		return core.ErrNotFound
	case "":
		return fmt.Errorf("rpc_failed")
	default:
		return fmt.Errorf("%s", code)
	}
}
