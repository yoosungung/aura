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

type CannedStore interface {
	ListCanned(ctx context.Context, actor, account uuid.UUID) ([]CannedOut, error)
	CreateCanned(ctx context.Context, actor, account uuid.UUID, shortCode, content string) (CannedOut, error)
}

type CannedOut struct {
	ID        uuid.UUID
	ShortCode string
	Content   string
}

func (s *Server) handleCanned(w http.ResponseWriter, r *http.Request) {
	if s.Service.Canned == nil {
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
		list, err := s.Service.Canned.ListCanned(r.Context(), tok.UserID, accountID)
		if err != nil {
			writeCannedErr(w, err)
			return
		}
		rows := make([]map[string]string, 0, len(list))
		for _, c := range list {
			rows = append(rows, map[string]string{
				"id": c.ID.String(), "short_code": c.ShortCode, "content": c.Content,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"canned_responses": rows})
	case http.MethodPost:
		var body struct {
			ShortCode string `json:"short_code"`
			Content   string `json:"content"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		out, err := s.Service.Canned.CreateCanned(r.Context(), tok.UserID, accountID, body.ShortCode, body.Content)
		if err != nil {
			writeCannedErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": out.ID.String(), "short_code": out.ShortCode, "content": out.Content,
		})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func writeCannedErr(w http.ResponseWriter, err error) {
	code := http.StatusBadGateway
	if errors.Is(err, core.ErrDenied) || err.Error() == "forbidden" {
		code = http.StatusForbidden
	} else if errors.Is(err, core.ErrInvalid) || err.Error() == "invalid" {
		code = http.StatusBadRequest
	} else if errors.Is(err, core.ErrConflict) || err.Error() == "conflict" {
		code = http.StatusConflict
	}
	http.Error(w, err.Error(), code)
}

func (r *natsRPC) ListCanned(ctx context.Context, actor, account uuid.UUID) ([]CannedOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
	})
	if err != nil {
		return nil, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectCannedList, body)
	if err != nil {
		return nil, err
	}
	var out struct {
		OK              bool   `json:"ok"`
		Error           string `json:"error"`
		CannedResponses []struct {
			ID        string `json:"id"`
			ShortCode string `json:"short_code"`
			Content   string `json:"content"`
		} `json:"canned_responses"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, cannedRPCErr(out.Error)
	}
	list := make([]CannedOut, 0, len(out.CannedResponses))
	for _, c := range out.CannedResponses {
		id, err := uuid.Parse(c.ID)
		if err != nil {
			return nil, err
		}
		list = append(list, CannedOut{ID: id, ShortCode: c.ShortCode, Content: c.Content})
	}
	return list, nil
}

func (r *natsRPC) CreateCanned(ctx context.Context, actor, account uuid.UUID, shortCode, content string) (CannedOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"short_code": shortCode, "content": content,
	})
	if err != nil {
		return CannedOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectCannedCreate, body)
	if err != nil {
		return CannedOut{}, err
	}
	var out struct {
		OK        bool   `json:"ok"`
		Error     string `json:"error"`
		ID        string `json:"id"`
		ShortCode string `json:"short_code"`
		Content   string `json:"content"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return CannedOut{}, err
	}
	if !out.OK {
		return CannedOut{}, cannedRPCErr(out.Error)
	}
	id, err := uuid.Parse(out.ID)
	if err != nil {
		return CannedOut{}, err
	}
	return CannedOut{ID: id, ShortCode: out.ShortCode, Content: out.Content}, nil
}

func cannedRPCErr(code string) error {
	switch code {
	case core.ErrDenied.Error():
		return core.ErrDenied
	case core.ErrInvalid.Error():
		return core.ErrInvalid
	case core.ErrConflict.Error():
		return core.ErrConflict
	case "":
		return fmt.Errorf("rpc_failed")
	default:
		return fmt.Errorf("%s", code)
	}
}
