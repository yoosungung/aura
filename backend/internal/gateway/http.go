package gateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

type Server struct {
	Service *Service
	NC      *nats.Conn
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/sign_in", s.handleSignIn)
	mux.HandleFunc("POST /auth/refresh", s.handleRefresh)
	mux.HandleFunc("DELETE /auth/sign_out", s.handleSignOut)
	mux.HandleFunc("POST /public/api/v1/inboxes/{inbox_id}/identify", s.handleIdentify)
	mux.HandleFunc("POST /public/api/v1/inboxes/{inbox_id}/messages", s.handleContactMessage)
	mux.HandleFunc("POST /public/api/v1/inboxes/{inbox_id}/csat", s.handleContactCSAT)
	mux.HandleFunc("GET /api/v1/accounts/{account_id}/conversations", s.handleConversationList)
	mux.HandleFunc("GET /api/v1/accounts/{account_id}/conversations/{conversation_id}/messages", s.handleMessageList)
	mux.HandleFunc("PUT /api/v1/accounts/{account_id}/conversations/{conversation_id}/status", s.handleStatus)
	mux.HandleFunc("GET /api/v1/accounts/{account_id}/contacts", s.handleContactList)
	mux.HandleFunc("POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/messages", s.handleAgentMessage)
	mux.HandleFunc("POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/attachments", s.handleAttachment)
	mux.HandleFunc("PUT /api/v1/accounts/{account_id}/conversations/{conversation_id}/assignee", s.handleAssign)
	mux.HandleFunc("POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/notes", s.handleNote)
	mux.HandleFunc("PUT /api/v1/accounts/{account_id}/conversations/{conversation_id}/snooze", s.handleSnooze)
	mux.HandleFunc("GET /api/v1/accounts/{account_id}/conversations/{conversation_id}/labels", s.handleLabels)
	mux.HandleFunc("POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/labels", s.handleLabels)
	mux.HandleFunc("DELETE /api/v1/accounts/{account_id}/conversations/{conversation_id}/labels/{label_id}", s.handleLabels)
	mux.HandleFunc("GET /api/v1/accounts/{account_id}/labels", s.handleAccountLabels)
	mux.HandleFunc("POST /api/v1/accounts/{account_id}/labels", s.handleAccountLabels)
	mux.HandleFunc("GET /api/v1/accounts/{account_id}/canned_responses", s.handleCanned)
	mux.HandleFunc("POST /api/v1/accounts/{account_id}/canned_responses", s.handleCanned)
	mux.HandleFunc("GET /api/v1/accounts/{account_id}/macros", s.handleMacros)
	mux.HandleFunc("POST /api/v1/accounts/{account_id}/macros", s.handleMacros)
	mux.HandleFunc("POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/macros/{macro_id}/execute", s.handleMacroExecute)
	mux.HandleFunc("GET /api/v1/accounts/{account_id}/inboxes/{inbox_id}/members", s.handleInboxMembers)
	mux.HandleFunc("PUT /api/v1/accounts/{account_id}/inboxes/{inbox_id}/members/{user_id}", s.handleInboxMembers)
	mux.HandleFunc("DELETE /api/v1/accounts/{account_id}/inboxes/{inbox_id}/members/{user_id}", s.handleInboxMembers)
	mux.HandleFunc("GET /api/v1/accounts/{account_id}/inboxes/{inbox_id}", s.handleInboxHMAC)
	mux.HandleFunc("POST /api/v1/accounts/{account_id}/inboxes/{inbox_id}/hmac/rotate", s.handleInboxHMAC)
	mux.HandleFunc("GET /ws", s.handleWS)
	return mux
}

func (s *Server) handleContactMessage(w http.ResponseWriter, r *http.Request) {
	tok, err := s.bearer(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	inboxID, err := uuid.Parse(r.PathValue("inbox_id"))
	if err != nil {
		http.Error(w, "invalid inbox", http.StatusBadRequest)
		return
	}
	var body struct {
		Content        string `json:"content"`
		Name           string `json:"name"`
		SourceID       string `json:"source_id"`
		ConversationID string `json:"conversation_id"`
		ContactID      string `json:"contact_id"`
		ContactInboxID string `json:"contact_inbox_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	out, err := s.Service.SubmitContact(r.Context(), tok, inboxID, SubmitRequest{
		Content:        body.Content,
		Name:           body.Name,
		SourceID:       body.SourceID,
		ConversationID: parseUUID(body.ConversationID),
		ContactID:      parseUUID(body.ContactID),
		ContactInboxID: parseUUID(body.ContactInboxID),
	})
	s.writeSubmit(w, out, err)
}

func (s *Server) handleContactCSAT(w http.ResponseWriter, r *http.Request) {
	tok, err := s.bearer(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	inboxID, err := uuid.Parse(r.PathValue("inbox_id"))
	if err != nil {
		http.Error(w, "invalid inbox", http.StatusBadRequest)
		return
	}
	var body struct {
		Rating   int    `json:"rating"`
		Feedback string `json:"feedback"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.Service.SubmitCSAT(r.Context(), tok, inboxID, body.Rating, body.Feedback); err != nil {
		s.writeSubmit(w, SubmitResult{}, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (s *Server) handleAgentMessage(w http.ResponseWriter, r *http.Request) {
	tok, err := s.bearer(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	accountID, err := uuid.Parse(r.PathValue("account_id"))
	if err != nil {
		http.Error(w, "invalid account", http.StatusBadRequest)
		return
	}
	conversationID, err := uuid.Parse(r.PathValue("conversation_id"))
	if err != nil {
		http.Error(w, "invalid conversation", http.StatusBadRequest)
		return
	}
	var body struct {
		Content        string `json:"content"`
		InboxID        string `json:"inbox_id"`
		ContactID      string `json:"contact_id"`
		ContactInboxID string `json:"contact_inbox_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	out, err := s.Service.SubmitAgent(r.Context(), tok, accountID, conversationID, SubmitRequest{
		Content:        body.Content,
		InboxID:        parseUUID(body.InboxID),
		ContactID:      parseUUID(body.ContactID),
		ContactInboxID: parseUUID(body.ContactInboxID),
	})
	s.writeSubmit(w, out, err)
}

func (s *Server) handleAttachment(w http.ResponseWriter, r *http.Request) {
	tok, err := s.bearer(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	accountID, err := uuid.Parse(r.PathValue("account_id"))
	if err != nil {
		http.Error(w, "invalid account", http.StatusBadRequest)
		return
	}
	conversationID, err := uuid.Parse(r.PathValue("conversation_id"))
	if err != nil {
		http.Error(w, "invalid conversation", http.StatusBadRequest)
		return
	}
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		http.Error(w, "invalid multipart", http.StatusBadRequest)
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	defer file.Close()
	out, err := s.Service.SubmitAttachment(r.Context(), tok, accountID, conversationID, AttachRequest{
		InboxID:        parseUUID(r.FormValue("inbox_id")),
		ContactID:      parseUUID(r.FormValue("contact_id")),
		ContactInboxID: parseUUID(r.FormValue("contact_inbox_id")),
		Filename:       hdr.Filename,
		ContentType:    hdr.Header.Get("Content-Type"),
		Size:           hdr.Size,
		Body:           file,
	})
	if err != nil {
		s.writeSubmit(w, out, err)
		return
	}
	atts := make([]map[string]any, 0, len(out.Attachments))
	for _, a := range out.Attachments {
		atts = append(atts, map[string]any{
			"id": a.ID, "file_type": a.FileType, "external_url": a.ExternalURL, "file_size": a.FileSize,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"message_id":      out.MessageID.String(),
		"conversation_id": out.ConversationID.String(),
		"attachments":     atts,
	})
}

func (s *Server) writeSubmit(w http.ResponseWriter, out SubmitResult, err error) {
	if err != nil {
		code := http.StatusBadGateway
		if errors.Is(err, ErrForbidden) {
			code = http.StatusForbidden
		} else if errors.Is(err, ErrInvalid) {
			code = http.StatusBadRequest
		}
		http.Error(w, err.Error(), code)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"message_id":       out.MessageID.String(),
		"conversation_id":  out.ConversationID.String(),
		"contact_id":       out.ContactID.String(),
		"contact_inbox_id": out.ContactInboxID.String(),
		"display_id":       out.DisplayID,
		"token":            out.Token,
	})
}

func (s *Server) bearer(r *http.Request) (Token, error) {
	h := r.Header.Get("Authorization")
	raw, ok := strings.CutPrefix(h, "Bearer ")
	if !ok {
		return Token{}, fmtUnauthorized
	}
	return Parse(s.Service.Secret, raw)
}

var fmtUnauthorized = errors.New("unauthorized")
