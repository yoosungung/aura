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

type Catalog interface {
	ListConversations(ctx context.Context, actor, account uuid.UUID, inboxIDs []uuid.UUID) ([]ConversationRow, error)
	ListMessages(ctx context.Context, actor, account, conversation uuid.UUID) ([]MessageRow, error)
	ListContacts(ctx context.Context, actor, account uuid.UUID, inboxIDs []uuid.UUID) ([]ContactRow, error)
	Transition(ctx context.Context, actor, account, conversation uuid.UUID, newStatus string, expectedVersion int) (TransitionOut, error)
}

type ConversationRow struct {
	ID             uuid.UUID
	InboxID        uuid.UUID
	ContactID      uuid.UUID
	ContactInboxID uuid.UUID
	AssigneeID     uuid.UUID
	Status         string
	Version        int
	SnoozedUntil   string
	DisplayID      int64
	LastContent    string
	Labels         []LabelOut
}

type MessageRow struct {
	ID          uuid.UUID
	Content     string
	SenderType  string
	Private     bool
	CreatedAt   string
	Attachments []AttachmentOut
}

type ContactRow struct {
	ID         uuid.UUID
	Name       string
	Email      string
	Identifier string
}

type TransitionOut struct {
	Status  string
	Version int
}

func (s *Server) handleConversationList(w http.ResponseWriter, r *http.Request) {
	tok, err := s.userTok(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	accountID, err := s.accountPath(r, tok)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if s.Service.Catalog == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	list, err := s.Service.Catalog.ListConversations(r.Context(), tok.UserID, accountID, tok.InboxIDs)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, c := range list {
		row := map[string]any{
			"id": c.ID.String(), "inbox_id": c.InboxID.String(), "contact_id": c.ContactID.String(),
			"contact_inbox_id": c.ContactInboxID.String(), "status": c.Status, "version": c.Version,
			"display_id": c.DisplayID, "last_content": c.LastContent,
		}
		if c.AssigneeID != uuid.Nil {
			row["assignee_id"] = c.AssigneeID.String()
		}
		if c.SnoozedUntil != "" {
			row["snoozed_until"] = c.SnoozedUntil
		}
		labels := make([]map[string]string, 0, len(c.Labels))
		for _, l := range c.Labels {
			labels = append(labels, map[string]string{"id": l.ID.String(), "name": l.Name, "color": l.Color})
		}
		row["labels"] = labels
		rows = append(rows, row)
	}
	writeJSON(w, map[string]any{"conversations": rows})
}

func (s *Server) handleMessageList(w http.ResponseWriter, r *http.Request) {
	tok, err := s.userTok(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	accountID, err := s.accountPath(r, tok)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	conversationID, err := uuid.Parse(r.PathValue("conversation_id"))
	if err != nil {
		http.Error(w, "invalid conversation", http.StatusBadRequest)
		return
	}
	if s.Service.Catalog == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	list, err := s.Service.Catalog.ListMessages(r.Context(), tok.UserID, accountID, conversationID)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, m := range list {
		atts := make([]map[string]any, 0, len(m.Attachments))
		for _, a := range m.Attachments {
			atts = append(atts, map[string]any{
				"id": a.ID, "file_type": a.FileType, "external_url": a.ExternalURL, "file_size": a.FileSize,
			})
		}
		rows = append(rows, map[string]any{
			"id": m.ID.String(), "content": m.Content, "sender_type": m.SenderType,
			"private": m.Private, "created_at": m.CreatedAt, "attachments": atts,
		})
	}
	writeJSON(w, map[string]any{"messages": rows})
}

func (s *Server) handleContactList(w http.ResponseWriter, r *http.Request) {
	tok, err := s.userTok(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	accountID, err := s.accountPath(r, tok)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if s.Service.Catalog == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	list, err := s.Service.Catalog.ListContacts(r.Context(), tok.UserID, accountID, tok.InboxIDs)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, c := range list {
		rows = append(rows, map[string]any{
			"id": c.ID.String(), "name": c.Name, "email": c.Email, "identifier": c.Identifier,
		})
	}
	writeJSON(w, map[string]any{"contacts": rows})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	tok, err := s.userTok(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	accountID, err := s.accountPath(r, tok)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	conversationID, err := uuid.Parse(r.PathValue("conversation_id"))
	if err != nil {
		http.Error(w, "invalid conversation", http.StatusBadRequest)
		return
	}
	var body struct {
		NewStatus       string `json:"new_status"`
		ExpectedVersion int    `json:"expected_version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if s.Service.Catalog == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	out, err := s.Service.Catalog.Transition(r.Context(), tok.UserID, accountID, conversationID, body.NewStatus, body.ExpectedVersion)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"status": out.Status, "version": out.Version})
}

func (s *Server) userTok(r *http.Request) (Token, error) {
	tok, err := s.bearer(r)
	if err != nil || tok.Kind != KindUser {
		return Token{}, fmtUnauthorized
	}
	return tok, nil
}

func (s *Server) accountPath(r *http.Request, tok Token) (uuid.UUID, error) {
	accountID, err := uuid.Parse(r.PathValue("account_id"))
	if err != nil || accountID != tok.AccountID {
		return uuid.Nil, fmtUnauthorized
	}
	return accountID, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeCatalogErr(w http.ResponseWriter, err error) {
	code := http.StatusBadGateway
	if errors.Is(err, core.ErrDenied) || err.Error() == "forbidden" {
		code = http.StatusForbidden
	} else if errors.Is(err, core.ErrConflict) || err.Error() == "conflict" {
		code = http.StatusConflict
	} else if errors.Is(err, core.ErrForbidden) || err.Error() == "forbidden_transition" {
		code = http.StatusConflict
	} else if errors.Is(err, core.ErrNotFound) || err.Error() == "not_found" {
		code = http.StatusNotFound
	}
	http.Error(w, err.Error(), code)
}

func (r *natsRPC) ListConversations(ctx context.Context, actor, account uuid.UUID, inboxIDs []uuid.UUID) ([]ConversationRow, error) {
	msg, err := r.listRPC(ctx, core.SubjectConversationsList, actor, account, inboxIDs, uuid.Nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		OK            bool   `json:"ok"`
		Error         string `json:"error"`
		Conversations []struct {
			ID             string `json:"id"`
			InboxID        string `json:"inbox_id"`
			ContactID      string `json:"contact_id"`
			ContactInboxID string `json:"contact_inbox_id"`
			AssigneeID     string `json:"assignee_id"`
			Status         string `json:"status"`
			Version        int    `json:"version"`
			SnoozedUntil   string `json:"snoozed_until"`
			DisplayID      int64  `json:"display_id"`
			LastContent    string `json:"last_content"`
			Labels         []struct {
				ID    string `json:"id"`
				Name  string `json:"name"`
				Color string `json:"color"`
			} `json:"labels"`
		} `json:"conversations"`
	}
	if err := json.Unmarshal(msg, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, catalogRPCErr(out.Error)
	}
	rows := make([]ConversationRow, 0, len(out.Conversations))
	for _, c := range out.Conversations {
		labels := make([]LabelOut, 0, len(c.Labels))
		for _, l := range c.Labels {
			labels = append(labels, LabelOut{ID: parseUUID(l.ID), Name: l.Name, Color: l.Color})
		}
		rows = append(rows, ConversationRow{
			ID: parseUUID(c.ID), InboxID: parseUUID(c.InboxID), ContactID: parseUUID(c.ContactID),
			ContactInboxID: parseUUID(c.ContactInboxID), AssigneeID: parseUUID(c.AssigneeID),
			Status: c.Status, Version: c.Version, SnoozedUntil: c.SnoozedUntil,
			DisplayID: c.DisplayID, LastContent: c.LastContent, Labels: labels,
		})
	}
	return rows, nil
}

func (r *natsRPC) ListMessages(ctx context.Context, actor, account, conversation uuid.UUID) ([]MessageRow, error) {
	msg, err := r.listRPC(ctx, core.SubjectMessagesList, actor, account, nil, conversation)
	if err != nil {
		return nil, err
	}
	var out struct {
		OK       bool   `json:"ok"`
		Error    string `json:"error"`
		Messages []struct {
			ID          string `json:"id"`
			Content     string `json:"content"`
			SenderType  string `json:"sender_type"`
			Private     bool   `json:"private"`
			CreatedAt   string `json:"created_at"`
			Attachments []struct {
				ID          string `json:"id"`
				FileType    string `json:"file_type"`
				ExternalURL string `json:"external_url"`
				FileSize    int    `json:"file_size"`
			} `json:"attachments"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(msg, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, catalogRPCErr(out.Error)
	}
	rows := make([]MessageRow, 0, len(out.Messages))
	for _, m := range out.Messages {
		atts := make([]AttachmentOut, 0, len(m.Attachments))
		for _, a := range m.Attachments {
			atts = append(atts, AttachmentOut{ID: a.ID, FileType: a.FileType, ExternalURL: a.ExternalURL, FileSize: a.FileSize})
		}
		rows = append(rows, MessageRow{
			ID: parseUUID(m.ID), Content: m.Content, SenderType: m.SenderType,
			Private: m.Private, CreatedAt: m.CreatedAt, Attachments: atts,
		})
	}
	return rows, nil
}

func (r *natsRPC) ListContacts(ctx context.Context, actor, account uuid.UUID, inboxIDs []uuid.UUID) ([]ContactRow, error) {
	msg, err := r.listRPC(ctx, core.SubjectContactsList, actor, account, inboxIDs, uuid.Nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		OK       bool   `json:"ok"`
		Error    string `json:"error"`
		Contacts []struct {
			ID         string `json:"id"`
			Name       string `json:"name"`
			Email      string `json:"email"`
			Identifier string `json:"identifier"`
		} `json:"contacts"`
	}
	if err := json.Unmarshal(msg, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, catalogRPCErr(out.Error)
	}
	rows := make([]ContactRow, 0, len(out.Contacts))
	for _, c := range out.Contacts {
		rows = append(rows, ContactRow{
			ID: parseUUID(c.ID), Name: c.Name, Email: c.Email, Identifier: c.Identifier,
		})
	}
	return rows, nil
}

func (r *natsRPC) Transition(ctx context.Context, actor, account, conversation uuid.UUID, newStatus string, expectedVersion int) (TransitionOut, error) {
	body, err := json.Marshal(map[string]any{
		"account_id":       account.String(),
		"conversation_id":  conversation.String(),
		"new_status":       newStatus,
		"expected_version": expectedVersion,
		"actor_type":       "User",
		"actor_id":         actor.String(),
	})
	if err != nil {
		return TransitionOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectTransition, body)
	if err != nil {
		return TransitionOut{}, err
	}
	var out struct {
		OK      bool   `json:"ok"`
		Error   string `json:"error"`
		Status  string `json:"status"`
		Version int    `json:"version"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return TransitionOut{}, err
	}
	if !out.OK {
		return TransitionOut{}, catalogRPCErr(out.Error)
	}
	return TransitionOut{Status: out.Status, Version: out.Version}, nil
}

func (r *natsRPC) listRPC(ctx context.Context, subject string, actor, account uuid.UUID, inboxIDs []uuid.UUID, conversation uuid.UUID) ([]byte, error) {
	ids := make([]string, 0, len(inboxIDs))
	for _, id := range inboxIDs {
		ids = append(ids, id.String())
	}
	payload := map[string]any{
		"actor_user_id": actor.String(),
		"account_id":    account.String(),
		"inbox_ids":     ids,
	}
	if conversation != uuid.Nil {
		payload["conversation_id"] = conversation.String()
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	msg, err := r.nc.RequestWithContext(ctx, subject, body)
	if err != nil {
		return nil, err
	}
	return msg.Data, nil
}

func catalogRPCErr(code string) error {
	switch code {
	case core.ErrDenied.Error():
		return core.ErrDenied
	case core.ErrConflict.Error():
		return core.ErrConflict
	case core.ErrForbidden.Error():
		return core.ErrForbidden
	case core.ErrNotFound.Error():
		return core.ErrNotFound
	case "":
		return fmt.Errorf("rpc_failed")
	default:
		return fmt.Errorf("%s", code)
	}
}
