package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/gateway"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

var secret = []byte("test-secret")

func mustV7(t *testing.T) uuid.UUID {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func mustSign(t *testing.T, tok gateway.Token) string {
	t.Helper()
	s, err := gateway.Sign(secret, tok)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

type fakeRPC struct {
	mu    sync.Mutex
	calls int
	err   error
	out   gateway.CreateOut
}

func (f *fakeRPC) Create(_ context.Context, _, _ uuid.UUID, _, _, _ string) (gateway.CreateOut, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.out, f.err
}

func (f *fakeRPC) n() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

type fakeBus struct {
	mu        sync.Mutex
	events    []string
	payloads  [][]byte
	realtime  []string
	schedules []uuid.UUID
}

func (f *fakeBus) PublishEvent(_ context.Context, subject string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, subject)
	f.payloads = append(f.payloads, append([]byte(nil), data...))
	return nil
}

func (f *fakeBus) lastEvent() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.payloads) == 0 {
		return nil
	}
	return f.payloads[len(f.payloads)-1]
}

func (f *fakeBus) PublishRealtime(subject string, _ []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.realtime = append(f.realtime, subject)
	return nil
}

func (f *fakeBus) ScheduleSnoozeWake(_ context.Context, _, conversationID uuid.UUID, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.schedules = append(f.schedules, conversationID)
	return nil
}

func (f *fakeBus) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.events), len(f.realtime)
}

func TestSubmit_NewConversation_CreateThenPublish(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	outIDs := gateway.CreateOut{
		ContactID: mustV7(t), ContactInboxID: mustV7(t),
		ConversationID: mustV7(t), DisplayID: 1,
	}
	rpc := &fakeRPC{out: outIDs}
	bus := &fakeBus{}
	svc := &gateway.Service{Secret: secret, RPC: rpc, Bus: bus}
	tok := gateway.Token{
		Kind: gateway.KindContact, AccountID: accountID, InboxID: inboxID, SourceID: "widget-1",
	}
	got, err := svc.SubmitContact(context.Background(), tok, inboxID, gateway.SubmitRequest{Content: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	if rpc.n() != 1 {
		t.Fatalf("create calls=%d", rpc.n())
	}
	ev, rt := bus.counts()
	if ev != 1 || rt != 1 {
		t.Fatalf("events=%d realtime=%d", ev, rt)
	}
	if got.ConversationID != outIDs.ConversationID || got.MessageID == uuid.Nil {
		t.Fatalf("%+v", got)
	}
}

func TestSubmit_CreateFails_NoPublish(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	rpc := &fakeRPC{err: fmt.Errorf("not_found")}
	bus := &fakeBus{}
	svc := &gateway.Service{Secret: secret, RPC: rpc, Bus: bus}
	tok := gateway.Token{
		Kind: gateway.KindContact, AccountID: accountID, InboxID: inboxID, SourceID: "widget-1",
	}
	_, err := svc.SubmitContact(context.Background(), tok, inboxID, gateway.SubmitRequest{Content: "hi"})
	if err == nil {
		t.Fatal("expected error")
	}
	ev, rt := bus.counts()
	if ev != 0 || rt != 0 {
		t.Fatalf("events=%d realtime=%d", ev, rt)
	}
}

func TestSubmit_Existing_SkipsCreate(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	rpc := &fakeRPC{}
	bus := &fakeBus{}
	svc := &gateway.Service{Secret: secret, RPC: rpc, Bus: bus}
	tok := gateway.Token{
		Kind:           gateway.KindContact,
		AccountID:      accountID,
		InboxID:        inboxID,
		SourceID:       "widget-1",
		ContactID:      mustV7(t),
		ContactInboxID: mustV7(t),
		ConversationID: mustV7(t),
	}
	_, err := svc.SubmitContact(context.Background(), tok, inboxID, gateway.SubmitRequest{Content: "again"})
	if err != nil {
		t.Fatal(err)
	}
	if rpc.n() != 0 {
		t.Fatalf("create calls=%d", rpc.n())
	}
	ev, rt := bus.counts()
	if ev != 1 || rt != 1 {
		t.Fatalf("events=%d realtime=%d", ev, rt)
	}
}

func TestSubmit_AgentOtherInbox_Forbidden(t *testing.T) {
	accountID := mustV7(t)
	rpc := &fakeRPC{}
	bus := &fakeBus{}
	svc := &gateway.Service{Secret: secret, RPC: rpc, Bus: bus}
	tok := gateway.Token{
		Kind: gateway.KindUser, AccountID: accountID, UserID: mustV7(t),
		InboxIDs: []uuid.UUID{mustV7(t)},
	}
	_, err := svc.SubmitAgent(context.Background(), tok, accountID, mustV7(t), gateway.SubmitRequest{
		Content: "reply", InboxID: mustV7(t), ContactID: mustV7(t), ContactInboxID: mustV7(t),
	})
	if err != gateway.ErrForbidden {
		t.Fatalf("got %v", err)
	}
	ev, _ := bus.counts()
	if ev != 0 {
		t.Fatalf("events=%d", ev)
	}
}

func TestCanSubscribe_ContactOwnOnly(t *testing.T) {
	conv := mustV7(t)
	inbox := mustV7(t)
	tok := gateway.Token{
		Kind: gateway.KindContact, AccountID: mustV7(t), InboxID: inbox, ConversationID: conv,
	}
	if !gateway.CanSubscribe(tok, inbox, conv) {
		t.Fatal("own conversation")
	}
	if gateway.CanSubscribe(tok, inbox, mustV7(t)) {
		t.Fatal("other conversation")
	}
}

func TestCanSubscribe_UserInboxScope(t *testing.T) {
	inbox := mustV7(t)
	tok := gateway.Token{
		Kind: gateway.KindUser, AccountID: mustV7(t), UserID: mustV7(t),
		InboxIDs: []uuid.UUID{inbox},
	}
	if !gateway.CanSubscribe(tok, inbox, mustV7(t)) {
		t.Fatal("assigned inbox")
	}
	if gateway.CanSubscribe(tok, mustV7(t), mustV7(t)) {
		t.Fatal("other inbox")
	}
}

func TestHTTP_AndWS_RoundTrip(t *testing.T) {
	ctx := context.Background()
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := mustV7(t), mustV7(t)
	created := gateway.CreateOut{
		ContactID: mustV7(t), ContactInboxID: mustV7(t),
		ConversationID: mustV7(t), DisplayID: 7,
	}
	sub, err := nc.Subscribe(core.SubjectCreate, func(msg *nats.Msg) {
		body, _ := json.Marshal(map[string]any{
			"ok": true, "contact_id": created.ContactID.String(),
			"contact_inbox_id": created.ContactInboxID.String(),
			"conversation_id":  created.ConversationID.String(),
			"display_id":       created.DisplayID, "status": "unassigned", "version": 1,
		})
		_ = msg.Respond(body)
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sub.Unsubscribe() })

	srv := &gateway.Server{
		Service: &gateway.Service{
			Secret: secret,
			RPC:    gateway.NewRPC(nc),
			Bus:    gateway.NewBus(nc, js),
		},
		NC: nc,
	}
	httpSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(httpSrv.Close)

	agentTok := mustSign(t, gateway.Token{
		Kind: gateway.KindUser, AccountID: accountID, UserID: mustV7(t),
		InboxIDs: []uuid.UUID{inboxID},
	})
	agentWS := dialWS(t, httpSrv.URL, agentTok)
	defer agentWS.Close()
	waitReady(t, agentWS)

	contactTok := mustSign(t, gateway.Token{
		Kind: gateway.KindContact, AccountID: accountID, InboxID: inboxID, SourceID: "widget-1",
	})
	reqBody, _ := json.Marshal(map[string]string{"content": "결제 오류"})
	req, err := http.NewRequest(http.MethodPost, httpSrv.URL+"/public/api/v1/inboxes/"+inboxID.String()+"/messages", bytes.NewReader(reqBody))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+contactTok)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var posted struct {
		ConversationID string `json:"conversation_id"`
		Token          string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&posted); err != nil {
		t.Fatal(err)
	}
	if posted.ConversationID != created.ConversationID.String() {
		t.Fatalf("conversation %s", posted.ConversationID)
	}

	evt := readEvent(t, agentWS, 5*time.Second)
	if evt["event"] != "message.created" || evt["conversation_id"] != created.ConversationID.String() {
		t.Fatalf("%v", evt)
	}

	otherTok := mustSign(t, gateway.Token{
		Kind: gateway.KindContact, AccountID: accountID, InboxID: inboxID,
		ConversationID: mustV7(t),
	})
	otherWS := dialWS(t, httpSrv.URL, otherTok)
	defer otherWS.Close()
	waitReady(t, otherWS)

	contactWS := dialWS(t, httpSrv.URL, posted.Token)
	defer contactWS.Close()
	waitReady(t, contactWS)

	agentBody, _ := json.Marshal(map[string]string{
		"content": "확인했습니다", "inbox_id": inboxID.String(),
		"contact_id": created.ContactID.String(), "contact_inbox_id": created.ContactInboxID.String(),
	})
	areq, err := http.NewRequest(http.MethodPost, httpSrv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+created.ConversationID.String()+"/messages", bytes.NewReader(agentBody))
	if err != nil {
		t.Fatal(err)
	}
	areq.Header.Set("Authorization", "Bearer "+agentTok)
	areq.Header.Set("Content-Type", "application/json")
	ares, err := http.DefaultClient.Do(areq)
	if err != nil {
		t.Fatal(err)
	}
	ares.Body.Close()
	if ares.StatusCode != http.StatusOK {
		t.Fatalf("agent status %d", ares.StatusCode)
	}

	reply := readEvent(t, contactWS, 5*time.Second)
	if reply["event"] != "message.created" {
		t.Fatalf("%v", reply)
	}
	otherWS.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
	if _, _, err := otherWS.ReadMessage(); err == nil {
		t.Fatal("other contact received event")
	}
}

func dialWS(t *testing.T, httpURL, token string) *websocket.Conn {
	t.Helper()
	u := "ws" + strings.TrimPrefix(httpURL, "http") + "/ws?token=" + token
	conn, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func waitReady(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var msg map[string]any
	if err := conn.ReadJSON(&msg); err != nil {
		t.Fatal(err)
	}
	if msg["type"] != "ready" {
		t.Fatalf("got %v", msg)
	}
}

func readEvent(t *testing.T, conn *websocket.Conn, d time.Duration) map[string]any {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(d))
	var msg map[string]any
	if err := conn.ReadJSON(&msg); err != nil {
		t.Fatal(err)
	}
	if msg["type"] != "event" {
		t.Fatalf("got %v", msg)
	}
	return msg
}
