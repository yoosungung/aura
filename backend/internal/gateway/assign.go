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

type Assigner interface {
	Assign(ctx context.Context, actor, account, conversation, assignee uuid.UUID, expectedVersion int) (AssignOut, error)
}

type AssignOut struct {
	AssigneeID uuid.UUID
	Status     string
	Version    int
}

func (s *Server) handleAssign(w http.ResponseWriter, r *http.Request) {
	if s.Service.Assign == nil {
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
	conversationID, err := uuid.Parse(r.PathValue("conversation_id"))
	if err != nil {
		http.Error(w, "invalid conversation", http.StatusBadRequest)
		return
	}
	var body struct {
		AssigneeID      string `json:"assignee_id"`
		ExpectedVersion int    `json:"expected_version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	assignee, err := uuid.Parse(body.AssigneeID)
	if err != nil {
		http.Error(w, "invalid assignee", http.StatusBadRequest)
		return
	}
	out, err := s.Service.Assign.Assign(r.Context(), tok.UserID, accountID, conversationID, assignee, body.ExpectedVersion)
	if err != nil {
		code := http.StatusBadGateway
		if errors.Is(err, core.ErrDenied) || err.Error() == "forbidden" {
			code = http.StatusForbidden
		} else if errors.Is(err, core.ErrConflict) || err.Error() == "conflict" {
			code = http.StatusConflict
		} else if errors.Is(err, core.ErrNotFound) || err.Error() == "not_found" {
			code = http.StatusNotFound
		}
		http.Error(w, err.Error(), code)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"assignee_id": out.AssigneeID.String(),
		"status":      out.Status,
		"version":     out.Version,
	})
}

func (r *natsRPC) Assign(ctx context.Context, actor, account, conversation, assignee uuid.UUID, expectedVersion int) (AssignOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id":    actor.String(),
		"account_id":       account.String(),
		"conversation_id":  conversation.String(),
		"assignee_id":      assignee.String(),
		"expected_version": expectedVersion,
	})
	if err != nil {
		return AssignOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectAssign, body)
	if err != nil {
		return AssignOut{}, err
	}
	var out struct {
		OK         bool   `json:"ok"`
		Error      string `json:"error"`
		AssigneeID string `json:"assignee_id"`
		Status     string `json:"status"`
		Version    int    `json:"version"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return AssignOut{}, err
	}
	if !out.OK {
		return AssignOut{}, assignRPCErr(out.Error)
	}
	id, err := uuid.Parse(out.AssigneeID)
	if err != nil {
		return AssignOut{}, err
	}
	return AssignOut{AssigneeID: id, Status: out.Status, Version: out.Version}, nil
}

func assignRPCErr(code string) error {
	switch code {
	case core.ErrDenied.Error():
		return core.ErrDenied
	case core.ErrConflict.Error():
		return core.ErrConflict
	case core.ErrNotFound.Error():
		return core.ErrNotFound
	case "":
		return fmt.Errorf("rpc_failed")
	default:
		return fmt.Errorf("%s", code)
	}
}
