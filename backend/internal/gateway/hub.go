package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		return u.Scheme == "http" || u.Scheme == "https"
	},
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if s.NC == nil {
		http.Error(w, "ws unavailable", http.StatusServiceUnavailable)
		return
	}
	tok, err := Parse(s.Service.Secret, r.URL.Query().Get("token"))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	var mu sync.Mutex
	write := func(v any) error {
		mu.Lock()
		defer mu.Unlock()
		return conn.WriteJSON(v)
	}
	writeRaw := func(p []byte) error {
		mu.Lock()
		defer mu.Unlock()
		return conn.WriteMessage(websocket.TextMessage, p)
	}

	sub, err := s.NC.Subscribe("helpdesk.realtime."+tok.AccountID.String()+".>", func(msg *nats.Msg) {
		var payload struct {
			Event          string `json:"event"`
			InboxID        string `json:"inbox_id"`
			ConversationID string `json:"conversation_id"`
		}
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			return
		}
		if payload.Event == "presence" {
			if tok.Kind != KindUser {
				return
			}
		} else if !CanSubscribe(tok, parseUUID(payload.InboxID), parseUUID(payload.ConversationID)) {
			return
		}
		if HidePrivateFromContact(tok, msg.Data) {
			return
		}
		_ = writeRaw(msg.Data)
	})
	if err != nil {
		return
	}
	defer sub.Unsubscribe()
	s.setPresence(tok, "online")
	defer s.setPresence(tok, "offline")
	_ = write(map[string]string{"type": "ready"})

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		s.handleClientFrame(tok, data)
	}
}

func (s *Server) setPresence(tok Token, status string) {
	if tok.Kind != KindUser || s.Service == nil || s.Service.Presence == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.Service.Presence.SetPresence(ctx, tok.UserID, tok.AccountID, status)
}

func (s *Server) handleClientFrame(tok Token, data []byte) {
	if s.NC == nil || len(data) == 0 {
		return
	}
	var frame struct {
		Type           string `json:"type"`
		ConversationID string `json:"conversation_id"`
		InboxID        string `json:"inbox_id"`
		IsTyping       bool   `json:"is_typing"`
	}
	if err := json.Unmarshal(data, &frame); err != nil || frame.Type != "typing" {
		return
	}
	inboxID := parseUUID(frame.InboxID)
	convID := parseUUID(frame.ConversationID)
	userType := "Contact"
	userID := tok.ContactID
	if tok.Kind == KindUser {
		userType = "User"
		userID = tok.UserID
	} else {
		if tok.InboxID != uuid.Nil {
			inboxID = tok.InboxID
		}
		if tok.ConversationID != uuid.Nil {
			convID = tok.ConversationID
		}
	}
	if !CanSubscribe(tok, inboxID, convID) {
		return
	}
	body, err := json.Marshal(map[string]any{
		"type": "event", "event": "typing",
		"account_id": tok.AccountID.String(), "inbox_id": inboxID.String(),
		"conversation_id": convID.String(), "user_type": userType,
		"user_id": userID.String(), "is_typing": frame.IsTyping,
	})
	if err != nil {
		return
	}
	_ = s.NC.Publish(fmt.Sprintf("helpdesk.realtime.%s.%s.typing", tok.AccountID, convID), body)
}
