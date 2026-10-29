package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/contracts"
	"github.com/yoosungung/aura/internal/core"
)

type Noter interface {
	AddNote(ctx context.Context, actor, account, conversation uuid.UUID, content string) (NoteOut, error)
}

type NoteOut struct {
	MessageID      uuid.UUID
	InboxID        uuid.UUID
	ConversationID uuid.UUID
	ContactID      uuid.UUID
	ContactInboxID uuid.UUID
	SenderID       uuid.UUID
	Content        string
	Private        bool
}

func (s *Server) handleNote(w http.ResponseWriter, r *http.Request) {
	if s.Service.Notes == nil {
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
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	out, err := s.Service.Notes.AddNote(r.Context(), tok.UserID, accountID, conversationID, body.Content)
	if err != nil {
		code := http.StatusBadGateway
		if errors.Is(err, core.ErrDenied) || err.Error() == "forbidden" {
			code = http.StatusForbidden
		} else if errors.Is(err, core.ErrInvalid) || err.Error() == "invalid" {
			code = http.StatusBadRequest
		} else if errors.Is(err, core.ErrNotFound) || err.Error() == "not_found" {
			code = http.StatusNotFound
		}
		http.Error(w, err.Error(), code)
		return
	}
	if s.Service.Bus != nil {
		_ = s.publishNoteRealtime(accountID, out)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"message_id":       out.MessageID.String(),
		"conversation_id":  out.ConversationID.String(),
		"inbox_id":         out.InboxID.String(),
		"contact_id":       out.ContactID.String(),
		"contact_inbox_id": out.ContactInboxID.String(),
		"content":          out.Content,
		"private":          true,
	})
}

func (s *Server) publishNoteRealtime(accountID uuid.UUID, out NoteOut) error {
	env, err := json.Marshal(contracts.MessageCreated{
		ID: out.MessageID.String(), SchemaVersion: 1, Type: "message_created",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		AccountID:  accountID.String(), InboxID: out.InboxID.String(),
		ConversationID: out.ConversationID.String(), HopCount: 0,
		Payload: contracts.MessageCreatedPayload{
			Content: out.Content, MessageType: MessageOutgoing, Private: true, Status: "sent",
			ContentType: "text", SenderType: "User", SenderID: out.SenderID.String(),
			ContactID: out.ContactID.String(), ContactInboxID: out.ContactInboxID.String(),
			Attachments: []any{},
		},
	})
	if err != nil {
		return err
	}
	rt, err := json.Marshal(map[string]any{
		"type":            "event",
		"event":           "message.created",
		"account_id":      accountID.String(),
		"inbox_id":        out.InboxID.String(),
		"conversation_id": out.ConversationID.String(),
		"message":         json.RawMessage(env),
	})
	if err != nil {
		return err
	}
	subject := fmt.Sprintf("helpdesk.realtime.%s.%s.updated", accountID, out.ConversationID)
	return s.Service.Bus.PublishRealtime(subject, rt)
}

func (r *natsRPC) AddNote(ctx context.Context, actor, account, conversation uuid.UUID, content string) (NoteOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id":   actor.String(),
		"account_id":      account.String(),
		"conversation_id": conversation.String(),
		"content":         content,
	})
	if err != nil {
		return NoteOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectNote, body)
	if err != nil {
		return NoteOut{}, err
	}
	var out struct {
		OK             bool   `json:"ok"`
		Error          string `json:"error"`
		MessageID      string `json:"message_id"`
		InboxID        string `json:"inbox_id"`
		ConversationID string `json:"conversation_id"`
		ContactID      string `json:"contact_id"`
		ContactInboxID string `json:"contact_inbox_id"`
		SenderID       string `json:"sender_id"`
		Content        string `json:"content"`
		Private        bool   `json:"private"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return NoteOut{}, err
	}
	if !out.OK {
		return NoteOut{}, noteRPCErr(out.Error)
	}
	return NoteOut{
		MessageID:      parseUUID(out.MessageID),
		InboxID:        parseUUID(out.InboxID),
		ConversationID: parseUUID(out.ConversationID),
		ContactID:      parseUUID(out.ContactID),
		ContactInboxID: parseUUID(out.ContactInboxID),
		SenderID:       parseUUID(out.SenderID),
		Content:        out.Content,
		Private:        out.Private,
	}, nil
}

func noteRPCErr(code string) error {
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
