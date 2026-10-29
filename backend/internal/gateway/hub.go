package gateway

import (
	"encoding/json"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
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
			InboxID        string `json:"inbox_id"`
			ConversationID string `json:"conversation_id"`
		}
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			return
		}
		if !CanSubscribe(tok, parseUUID(payload.InboxID), parseUUID(payload.ConversationID)) {
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
	_ = write(map[string]string{"type": "ready"})

	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
