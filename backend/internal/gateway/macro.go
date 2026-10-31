package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

type MacroStore interface {
	ListMacros(ctx context.Context, actor, account uuid.UUID) ([]MacroOut, error)
	CreateMacro(ctx context.Context, actor, account uuid.UUID, name, visibility string, actions []core.MacroAction) (MacroOut, error)
	UpdateMacro(ctx context.Context, actor, account, macroID uuid.UUID, name, visibility string, actions []core.MacroAction) (MacroOut, error)
	DeleteMacro(ctx context.Context, actor, account, macroID uuid.UUID) error
	ExecuteMacro(ctx context.Context, actor, account, conversation, macroID uuid.UUID) (ExecuteOut, error)
}

type MacroOut struct {
	ID         uuid.UUID
	Name       string
	Actions    []core.MacroAction
	Visibility string
	CreatedBy  uuid.UUID
}

type ExecuteOut struct {
	Status       string
	Version      int
	Labels       []LabelOut
	Messages     []NoteOut
	SnoozedUntil string
	AssigneeID   uuid.UUID
}

func (s *Server) handleMacros(w http.ResponseWriter, r *http.Request) {
	if s.Service.Macros == nil {
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
		list, err := s.Service.Macros.ListMacros(r.Context(), tok.UserID, accountID)
		if err != nil {
			writeMacroErr(w, err)
			return
		}
		rows := make([]map[string]any, 0, len(list))
		for _, m := range list {
			rows = append(rows, map[string]any{
				"id": m.ID.String(), "name": m.Name, "actions": m.Actions,
				"visibility": m.Visibility, "created_by": m.CreatedBy.String(),
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"macros": rows})
	case http.MethodPost:
		var body struct {
			Name       string             `json:"name"`
			Visibility string             `json:"visibility"`
			Actions    []core.MacroAction `json:"actions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		out, err := s.Service.Macros.CreateMacro(r.Context(), tok.UserID, accountID, body.Name, body.Visibility, body.Actions)
		if err != nil {
			writeMacroErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": out.ID.String(), "name": out.Name, "actions": out.Actions,
			"visibility": out.Visibility, "created_by": out.CreatedBy.String(),
		})
	case http.MethodPatch:
		id, err := uuid.Parse(r.PathValue("macro_id"))
		if err != nil {
			http.Error(w, "invalid macro", http.StatusBadRequest)
			return
		}
		var body struct {
			Name       string             `json:"name"`
			Visibility string             `json:"visibility"`
			Actions    []core.MacroAction `json:"actions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		out, err := s.Service.Macros.UpdateMacro(r.Context(), tok.UserID, accountID, id, body.Name, body.Visibility, body.Actions)
		if err != nil {
			writeMacroErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": out.ID.String(), "name": out.Name, "actions": out.Actions,
			"visibility": out.Visibility, "created_by": out.CreatedBy.String(),
		})
	case http.MethodDelete:
		id, err := uuid.Parse(r.PathValue("macro_id"))
		if err != nil {
			http.Error(w, "invalid macro", http.StatusBadRequest)
			return
		}
		if err := s.Service.Macros.DeleteMacro(r.Context(), tok.UserID, accountID, id); err != nil {
			writeMacroErr(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleMacroExecute(w http.ResponseWriter, r *http.Request) {
	if s.Service.Macros == nil {
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
	macroID, err := uuid.Parse(r.PathValue("macro_id"))
	if err != nil {
		http.Error(w, "invalid macro", http.StatusBadRequest)
		return
	}
	out, err := s.Service.Macros.ExecuteMacro(r.Context(), tok.UserID, accountID, conversationID, macroID)
	if err != nil {
		writeMacroErr(w, err)
		return
	}
	if s.Service.Bus != nil {
		for _, msg := range out.Messages {
			_ = s.publishNoteRealtime(accountID, msg)
		}
		if out.SnoozedUntil != "" {
			until, err := time.Parse(time.RFC3339, out.SnoozedUntil)
			if err == nil {
				_ = s.Service.Bus.ScheduleSnoozeWake(r.Context(), accountID, conversationID, until)
			}
		}
	}
	labels := make([]map[string]string, 0, len(out.Labels))
	for _, l := range out.Labels {
		labels = append(labels, map[string]string{"id": l.ID.String(), "name": l.Name, "color": l.Color})
	}
	messages := make([]map[string]any, 0, len(out.Messages))
	for _, m := range out.Messages {
		messages = append(messages, map[string]any{
			"message_id": m.MessageID.String(), "content": m.Content, "private": m.Private,
			"inbox_id": m.InboxID.String(), "contact_id": m.ContactID.String(),
			"contact_inbox_id": m.ContactInboxID.String(),
		})
	}
	body := map[string]any{"status": out.Status, "version": out.Version, "labels": labels, "messages": messages}
	if out.AssigneeID != uuid.Nil {
		body["assignee_id"] = out.AssigneeID.String()
	}
	if out.SnoozedUntil != "" {
		body["snoozed_until"] = out.SnoozedUntil
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func writeMacroErr(w http.ResponseWriter, err error) {
	code := http.StatusBadGateway
	if errors.Is(err, core.ErrDenied) || err.Error() == "forbidden" {
		code = http.StatusForbidden
	} else if errors.Is(err, core.ErrInvalid) || err.Error() == "invalid" {
		code = http.StatusBadRequest
	} else if errors.Is(err, core.ErrNotFound) || err.Error() == "not_found" {
		code = http.StatusNotFound
	} else if errors.Is(err, core.ErrConflict) || err.Error() == "conflict" {
		code = http.StatusConflict
	} else if errors.Is(err, core.ErrForbidden) {
		code = http.StatusForbidden
	}
	http.Error(w, err.Error(), code)
}

func (r *natsRPC) ListMacros(ctx context.Context, actor, account uuid.UUID) ([]MacroOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
	})
	if err != nil {
		return nil, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectMacroList, body)
	if err != nil {
		return nil, err
	}
	var out struct {
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Macros []struct {
			ID         string             `json:"id"`
			Name       string             `json:"name"`
			Actions    []core.MacroAction `json:"actions"`
			Visibility string             `json:"visibility"`
			CreatedBy  string             `json:"created_by"`
		} `json:"macros"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, macroRPCErr(out.Error)
	}
	list := make([]MacroOut, 0, len(out.Macros))
	for _, m := range out.Macros {
		id, err := uuid.Parse(m.ID)
		if err != nil {
			return nil, err
		}
		list = append(list, MacroOut{
			ID: id, Name: m.Name, Actions: m.Actions, Visibility: m.Visibility, CreatedBy: parseUUID(m.CreatedBy),
		})
	}
	return list, nil
}

func (r *natsRPC) CreateMacro(ctx context.Context, actor, account uuid.UUID, name, visibility string, actions []core.MacroAction) (MacroOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"name": name, "visibility": visibility, "actions": actions,
	})
	if err != nil {
		return MacroOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectMacroCreate, body)
	if err != nil {
		return MacroOut{}, err
	}
	var out struct {
		OK         bool               `json:"ok"`
		Error      string             `json:"error"`
		ID         string             `json:"id"`
		Name       string             `json:"name"`
		Actions    []core.MacroAction `json:"actions"`
		Visibility string             `json:"visibility"`
		CreatedBy  string             `json:"created_by"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return MacroOut{}, err
	}
	if !out.OK {
		return MacroOut{}, macroRPCErr(out.Error)
	}
	id, err := uuid.Parse(out.ID)
	if err != nil {
		return MacroOut{}, err
	}
	return MacroOut{
		ID: id, Name: out.Name, Actions: out.Actions, Visibility: out.Visibility, CreatedBy: parseUUID(out.CreatedBy),
	}, nil
}

func (r *natsRPC) UpdateMacro(ctx context.Context, actor, account, macroID uuid.UUID, name, visibility string, actions []core.MacroAction) (MacroOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "macro_id": macroID.String(),
		"name": name, "visibility": visibility, "actions": actions,
	})
	if err != nil {
		return MacroOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectMacroUpdate, body)
	if err != nil {
		return MacroOut{}, err
	}
	var out struct {
		OK         bool               `json:"ok"`
		Error      string             `json:"error"`
		ID         string             `json:"id"`
		Name       string             `json:"name"`
		Actions    []core.MacroAction `json:"actions"`
		Visibility string             `json:"visibility"`
		CreatedBy  string             `json:"created_by"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return MacroOut{}, err
	}
	if !out.OK {
		return MacroOut{}, macroRPCErr(out.Error)
	}
	id, err := uuid.Parse(out.ID)
	if err != nil {
		return MacroOut{}, err
	}
	return MacroOut{
		ID: id, Name: out.Name, Actions: out.Actions, Visibility: out.Visibility, CreatedBy: parseUUID(out.CreatedBy),
	}, nil
}

func (r *natsRPC) DeleteMacro(ctx context.Context, actor, account, macroID uuid.UUID) error {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "macro_id": macroID.String(),
	})
	if err != nil {
		return err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectMacroDelete, body)
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
		return macroRPCErr(out.Error)
	}
	return nil
}

func (r *natsRPC) ExecuteMacro(ctx context.Context, actor, account, conversation, macroID uuid.UUID) (ExecuteOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"conversation_id": conversation.String(), "macro_id": macroID.String(),
	})
	if err != nil {
		return ExecuteOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectMacroExecute, body)
	if err != nil {
		return ExecuteOut{}, err
	}
	var out struct {
		OK           bool   `json:"ok"`
		Error        string `json:"error"`
		Status       string `json:"status"`
		Version      int    `json:"version"`
		SnoozedUntil string `json:"snoozed_until"`
		AssigneeID   string `json:"assignee_id"`
		Labels       []struct {
			ID    string `json:"id"`
			Name  string `json:"name"`
			Color string `json:"color"`
		} `json:"labels"`
		Messages []struct {
			MessageID      string `json:"message_id"`
			InboxID        string `json:"inbox_id"`
			ConversationID string `json:"conversation_id"`
			ContactID      string `json:"contact_id"`
			ContactInboxID string `json:"contact_inbox_id"`
			SenderID       string `json:"sender_id"`
			Content        string `json:"content"`
			Private        bool   `json:"private"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return ExecuteOut{}, err
	}
	if !out.OK {
		return ExecuteOut{}, macroRPCErr(out.Error)
	}
	exec := ExecuteOut{Status: out.Status, Version: out.Version, SnoozedUntil: out.SnoozedUntil, AssigneeID: parseUUID(out.AssigneeID)}
	for _, l := range out.Labels {
		exec.Labels = append(exec.Labels, LabelOut{ID: parseUUID(l.ID), Name: l.Name, Color: l.Color})
	}
	for _, m := range out.Messages {
		exec.Messages = append(exec.Messages, NoteOut{
			MessageID: parseUUID(m.MessageID), InboxID: parseUUID(m.InboxID),
			ConversationID: parseUUID(m.ConversationID), ContactID: parseUUID(m.ContactID),
			ContactInboxID: parseUUID(m.ContactInboxID), SenderID: parseUUID(m.SenderID),
			Content: m.Content, Private: m.Private,
		})
	}
	return exec, nil
}

func macroRPCErr(code string) error {
	switch code {
	case core.ErrDenied.Error():
		return core.ErrDenied
	case core.ErrInvalid.Error():
		return core.ErrInvalid
	case core.ErrNotFound.Error():
		return core.ErrNotFound
	case core.ErrConflict.Error():
		return core.ErrConflict
	case core.ErrForbidden.Error():
		return core.ErrForbidden
	case "":
		return fmt.Errorf("rpc_failed")
	default:
		return fmt.Errorf("%s", code)
	}
}
