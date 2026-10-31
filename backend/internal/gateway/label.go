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

type Labeler interface {
	AddConversationLabel(ctx context.Context, actor, account, conversation uuid.UUID, name string) (LabelOut, error)
	RemoveConversationLabel(ctx context.Context, actor, account, conversation, labelID uuid.UUID) error
	ListConversationLabels(ctx context.Context, actor, account, conversation uuid.UUID) ([]LabelOut, error)
	ListAccountLabels(ctx context.Context, actor, account uuid.UUID) ([]LabelOut, error)
	CreateAccountLabel(ctx context.Context, actor, account uuid.UUID, name string) (LabelOut, error)
	UpdateAccountLabel(ctx context.Context, actor, account, labelID uuid.UUID, name string) (LabelOut, error)
	DeleteAccountLabel(ctx context.Context, actor, account, labelID uuid.UUID) error
}

type LabelOut struct {
	ID    uuid.UUID
	Name  string
	Color string
}

func (s *Server) handleAccountLabels(w http.ResponseWriter, r *http.Request) {
	if s.Service.Labels == nil {
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
		list, err := s.Service.Labels.ListAccountLabels(r.Context(), tok.UserID, accountID)
		s.writeLabels(w, list, err)
	case http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		out, err := s.Service.Labels.CreateAccountLabel(r.Context(), tok.UserID, accountID, body.Name)
		if err != nil {
			s.writeLabelErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": out.ID.String(), "name": out.Name, "color": out.Color,
		})
	case http.MethodPatch:
		id, err := uuid.Parse(r.PathValue("label_id"))
		if err != nil {
			http.Error(w, "invalid label", http.StatusBadRequest)
			return
		}
		var patch struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		out, err := s.Service.Labels.UpdateAccountLabel(r.Context(), tok.UserID, accountID, id, patch.Name)
		if err != nil {
			s.writeLabelErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": out.ID.String(), "name": out.Name, "color": out.Color,
		})
	case http.MethodDelete:
		id, err := uuid.Parse(r.PathValue("label_id"))
		if err != nil {
			http.Error(w, "invalid label", http.StatusBadRequest)
			return
		}
		if err := s.Service.Labels.DeleteAccountLabel(r.Context(), tok.UserID, accountID, id); err != nil {
			s.writeLabelErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleLabels(w http.ResponseWriter, r *http.Request) {
	if s.Service.Labels == nil {
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
	switch r.Method {
	case http.MethodGet:
		list, err := s.Service.Labels.ListConversationLabels(r.Context(), tok.UserID, accountID, conversationID)
		s.writeLabels(w, list, err)
	case http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		out, err := s.Service.Labels.AddConversationLabel(r.Context(), tok.UserID, accountID, conversationID, body.Name)
		if err != nil {
			s.writeLabelErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": out.ID.String(), "name": out.Name, "color": out.Color,
		})
	case http.MethodDelete:
		labelID, err := uuid.Parse(r.PathValue("label_id"))
		if err != nil {
			http.Error(w, "invalid label", http.StatusBadRequest)
			return
		}
		err = s.Service.Labels.RemoveConversationLabel(r.Context(), tok.UserID, accountID, conversationID, labelID)
		if err != nil {
			s.writeLabelErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (s *Server) writeLabels(w http.ResponseWriter, list []LabelOut, err error) {
	if err != nil {
		s.writeLabelErr(w, err)
		return
	}
	rows := make([]map[string]string, 0, len(list))
	for _, l := range list {
		rows = append(rows, map[string]string{"id": l.ID.String(), "name": l.Name, "color": l.Color})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"labels": rows})
}

func (s *Server) writeLabelErr(w http.ResponseWriter, err error) {
	code := http.StatusBadGateway
	if errors.Is(err, core.ErrDenied) || err.Error() == "forbidden" {
		code = http.StatusForbidden
	} else if errors.Is(err, core.ErrInvalid) || err.Error() == "invalid" {
		code = http.StatusBadRequest
	} else if errors.Is(err, core.ErrConflict) || err.Error() == "conflict" {
		code = http.StatusConflict
	} else if errors.Is(err, core.ErrNotFound) || err.Error() == "not_found" {
		code = http.StatusNotFound
	}
	http.Error(w, err.Error(), code)
}

func (r *natsRPC) AddConversationLabel(ctx context.Context, actor, account, conversation uuid.UUID, name string) (LabelOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"conversation_id": conversation.String(), "name": name,
	})
	if err != nil {
		return LabelOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectLabelAdd, body)
	if err != nil {
		return LabelOut{}, err
	}
	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
		ID    string `json:"id"`
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return LabelOut{}, err
	}
	if !out.OK {
		return LabelOut{}, labelRPCErr(out.Error)
	}
	id, err := uuid.Parse(out.ID)
	if err != nil {
		return LabelOut{}, err
	}
	return LabelOut{ID: id, Name: out.Name, Color: out.Color}, nil
}

func (r *natsRPC) RemoveConversationLabel(ctx context.Context, actor, account, conversation, labelID uuid.UUID) error {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"conversation_id": conversation.String(), "label_id": labelID.String(),
	})
	if err != nil {
		return err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectLabelRemove, body)
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
		return labelRPCErr(out.Error)
	}
	return nil
}

func (r *natsRPC) ListConversationLabels(ctx context.Context, actor, account, conversation uuid.UUID) ([]LabelOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"conversation_id": conversation.String(),
	})
	if err != nil {
		return nil, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectLabelList, body)
	if err != nil {
		return nil, err
	}
	return parseLabelList(msg.Data)
}

func (r *natsRPC) ListAccountLabels(ctx context.Context, actor, account uuid.UUID) ([]LabelOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
	})
	if err != nil {
		return nil, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectLabelCatalogList, body)
	if err != nil {
		return nil, err
	}
	return parseLabelList(msg.Data)
}

func (r *natsRPC) CreateAccountLabel(ctx context.Context, actor, account uuid.UUID, name string) (LabelOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "name": name,
	})
	if err != nil {
		return LabelOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectLabelCatalogCreate, body)
	if err != nil {
		return LabelOut{}, err
	}
	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
		ID    string `json:"id"`
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return LabelOut{}, err
	}
	if !out.OK {
		return LabelOut{}, labelRPCErr(out.Error)
	}
	id, err := uuid.Parse(out.ID)
	if err != nil {
		return LabelOut{}, err
	}
	return LabelOut{ID: id, Name: out.Name, Color: out.Color}, nil
}

func (r *natsRPC) UpdateAccountLabel(ctx context.Context, actor, account, labelID uuid.UUID, name string) (LabelOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "label_id": labelID.String(), "name": name,
	})
	if err != nil {
		return LabelOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectLabelCatalogUpdate, body)
	if err != nil {
		return LabelOut{}, err
	}
	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
		ID    string `json:"id"`
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return LabelOut{}, err
	}
	if !out.OK {
		return LabelOut{}, labelRPCErr(out.Error)
	}
	id, err := uuid.Parse(out.ID)
	if err != nil {
		return LabelOut{}, err
	}
	return LabelOut{ID: id, Name: out.Name, Color: out.Color}, nil
}

func (r *natsRPC) DeleteAccountLabel(ctx context.Context, actor, account, labelID uuid.UUID) error {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "label_id": labelID.String(),
	})
	if err != nil {
		return err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectLabelCatalogDelete, body)
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
		return labelRPCErr(out.Error)
	}
	return nil
}

func parseLabelList(data []byte) ([]LabelOut, error) {
	var out struct {
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Labels []struct {
			ID    string `json:"id"`
			Name  string `json:"name"`
			Color string `json:"color"`
		} `json:"labels"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, labelRPCErr(out.Error)
	}
	list := make([]LabelOut, 0, len(out.Labels))
	for _, l := range out.Labels {
		id, err := uuid.Parse(l.ID)
		if err != nil {
			return nil, err
		}
		list = append(list, LabelOut{ID: id, Name: l.Name, Color: l.Color})
	}
	return list, nil
}

func labelRPCErr(code string) error {
	switch code {
	case core.ErrDenied.Error():
		return core.ErrDenied
	case core.ErrInvalid.Error():
		return core.ErrInvalid
	case core.ErrNotFound.Error():
		return core.ErrNotFound
	case "":
		return fmt.Errorf("rpc_failed")
	default:
		return fmt.Errorf("%s", code)
	}
}
