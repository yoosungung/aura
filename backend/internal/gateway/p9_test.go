package gateway_test

import (
	"encoding/json"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/gateway"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestWS_UserPresenceOnConnectAndDisconnect(t *testing.T) {
	nc, _ := testutil.NATSConn(t)
	var mu sync.Mutex
	var statuses []string
	sub, err := nc.Subscribe(core.SubjectAuthPresence, func(msg *nats.Msg) {
		var req struct {
			Status string `json:"status"`
			UserID string `json:"user_id"`
		}
		_ = json.Unmarshal(msg.Data, &req)
		mu.Lock()
		statuses = append(statuses, req.Status)
		mu.Unlock()
		_ = msg.Respond([]byte(`{"ok":true}`))
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sub.Unsubscribe() })

	accountID, userID := mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Presence: gateway.NewRPC(nc)},
		NC:      nc,
	}).Handler())
	t.Cleanup(srv.Close)

	tok := mustSign(t, gateway.Token{
		Kind: gateway.KindUser, AccountID: accountID, UserID: userID,
		InboxIDs: []uuid.UUID{mustV7(t)},
	})
	ws := dialWS(t, srv.URL, tok)
	waitReady(t, ws)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(statuses)
		mu.Unlock()
		if n >= 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = ws.Close()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(statuses)
		mu.Unlock()
		if n >= 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	got := append([]string(nil), statuses...)
	mu.Unlock()
	if len(got) < 2 || got[0] != "online" || got[len(got)-1] != "offline" {
		t.Fatalf("%v", got)
	}
}

func TestWS_ContactDoesNotSetPresence(t *testing.T) {
	nc, _ := testutil.NATSConn(t)
	var n int
	sub, err := nc.Subscribe(core.SubjectAuthPresence, func(msg *nats.Msg) {
		n++
		_ = msg.Respond([]byte(`{"ok":true}`))
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sub.Unsubscribe() })
	accountID, inboxID := mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Presence: gateway.NewRPC(nc)},
		NC:      nc,
	}).Handler())
	t.Cleanup(srv.Close)
	tok := mustSign(t, gateway.Token{
		Kind: gateway.KindContact, AccountID: accountID, InboxID: inboxID,
		ConversationID: mustV7(t),
	})
	ws := dialWS(t, srv.URL, tok)
	waitReady(t, ws)
	time.Sleep(200 * time.Millisecond)
	_ = ws.Close()
	time.Sleep(200 * time.Millisecond)
	if n != 0 {
		t.Fatalf("presence calls %d", n)
	}
}

func TestWS_TypingRelaysToOtherUser(t *testing.T) {
	nc, _ := testutil.NATSConn(t)
	accountID, inboxID, convID := mustV7(t), mustV7(t), mustV7(t)
	userA, userB := mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret},
		NC:      nc,
	}).Handler())
	t.Cleanup(srv.Close)

	tokA := mustSign(t, gateway.Token{
		Kind: gateway.KindUser, AccountID: accountID, UserID: userA,
		InboxIDs: []uuid.UUID{inboxID},
	})
	tokB := mustSign(t, gateway.Token{
		Kind: gateway.KindUser, AccountID: accountID, UserID: userB,
		InboxIDs: []uuid.UUID{inboxID},
	})
	wsA := dialWS(t, srv.URL, tokA)
	defer wsA.Close()
	waitReady(t, wsA)
	wsB := dialWS(t, srv.URL, tokB)
	defer wsB.Close()
	waitReady(t, wsB)

	frame, _ := json.Marshal(map[string]any{
		"type": "typing", "conversation_id": convID.String(),
		"inbox_id": inboxID.String(), "is_typing": true, "user_id": "ignored",
	})
	if err := wsA.WriteMessage(websocket.TextMessage, frame); err != nil {
		t.Fatal(err)
	}
	evt := readEvent(t, wsB, 2*time.Second)
	if evt["event"] != "typing" || evt["user_id"] != userA.String() || evt["user_type"] != "User" {
		t.Fatalf("%v", evt)
	}
	if evt["is_typing"] != true {
		t.Fatalf("is_typing %v", evt["is_typing"])
	}
}

func TestWS_TypingDoesNotReachOtherConversation(t *testing.T) {
	nc, _ := testutil.NATSConn(t)
	accountID, inboxID := mustV7(t), mustV7(t)
	convA, convB := mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret},
		NC:      nc,
	}).Handler())
	t.Cleanup(srv.Close)
	tokA := mustSign(t, gateway.Token{
		Kind: gateway.KindContact, AccountID: accountID, InboxID: inboxID, ConversationID: convA,
		ContactID: mustV7(t),
	})
	tokB := mustSign(t, gateway.Token{
		Kind: gateway.KindContact, AccountID: accountID, InboxID: inboxID, ConversationID: convB,
		ContactID: mustV7(t),
	})
	wsA := dialWS(t, srv.URL, tokA)
	defer wsA.Close()
	waitReady(t, wsA)
	wsB := dialWS(t, srv.URL, tokB)
	defer wsB.Close()
	waitReady(t, wsB)
	frame, _ := json.Marshal(map[string]any{
		"type": "typing", "conversation_id": convA.String(), "is_typing": true,
	})
	if err := wsA.WriteMessage(websocket.TextMessage, frame); err != nil {
		t.Fatal(err)
	}
	wsB.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
	if _, _, err := wsB.ReadMessage(); err == nil {
		t.Fatal("other conversation received typing")
	}
}
