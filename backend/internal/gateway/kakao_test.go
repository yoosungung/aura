package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/contracts"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/gateway"
)

type fakeKakao struct {
	mu        sync.Mutex
	account   uuid.UUID
	inbox     uuid.UUID
	thread    gateway.CreateOut
	found     bool
	dup       bool
	createOut gateway.CreateOut
	creates   int
	inboxErr  error
	threadErr error
	createErr error
}

func (f *fakeKakao) ResolveSender(_ context.Context, _ string) (uuid.UUID, uuid.UUID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.inboxErr != nil {
		return uuid.Nil, uuid.Nil, f.inboxErr
	}
	return f.account, f.inbox, nil
}

func (f *fakeKakao) ResolveKakao(_ context.Context, _, _ uuid.UUID, _, _ string) (gateway.CreateOut, bool, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.threadErr != nil {
		return gateway.CreateOut{}, false, false, f.threadErr
	}
	return f.thread, f.found, f.dup, nil
}

func (f *fakeKakao) CreateKakao(_ context.Context, _, _ uuid.UUID, _, _, _ string) (gateway.CreateOut, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.creates++
	return f.createOut, f.createErr
}

func (f *fakeKakao) createCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.creates
}

func cstalkBody(sender, user, msg, comment string) []byte {
	b, _ := json.Marshal(map[string]any{
		"msgKey": msg, "userKey": user, "senderKey": sender,
		"serviceType": "CSTALK", "msgType": "TEXT", "requestType": "message",
		"contents": []map[string]string{{"comment": comment}},
	})
	return b
}

func TestAcceptKakao_CreateThenPublish(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	created := gateway.CreateOut{
		ContactID: mustV7(t), ContactInboxID: mustV7(t), ConversationID: mustV7(t), DisplayID: 1,
	}
	kakao := &fakeKakao{account: accountID, inbox: inboxID, createOut: created}
	bus := &fakeBus{}
	svc := &gateway.Service{Kakao: kakao, Bus: bus}
	if err := svc.AcceptKakao(context.Background(), cstalkBody("sender-acme", "user-ada", "msg-1", "결제 오류")); err != nil {
		t.Fatal(err)
	}
	if kakao.createCount() != 1 {
		t.Fatalf("creates=%d", kakao.createCount())
	}
	ev, rt := bus.counts()
	if ev != 1 || rt != 1 {
		t.Fatalf("events=%d realtime=%d", ev, rt)
	}
	var env contracts.MessageCreated
	if err := json.Unmarshal(bus.lastEvent(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Payload.SourceID != "msg-1" || env.Payload.Content != "결제 오류" || env.Payload.MessageType != gateway.MessageIncoming {
		t.Fatalf("%+v", env.Payload)
	}
	if env.ConversationID != created.ConversationID.String() {
		t.Fatalf("conv %s", env.ConversationID)
	}
}

func TestAcceptKakao_ThreadHitSkipsCreate(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	thread := gateway.CreateOut{
		ContactID: mustV7(t), ContactInboxID: mustV7(t), ConversationID: mustV7(t), DisplayID: 3,
	}
	kakao := &fakeKakao{account: accountID, inbox: inboxID, thread: thread, found: true}
	bus := &fakeBus{}
	svc := &gateway.Service{Kakao: kakao, Bus: bus}
	if err := svc.AcceptKakao(context.Background(), cstalkBody("sender-acme", "user-ada", "msg-2", "이어서")); err != nil {
		t.Fatal(err)
	}
	if kakao.createCount() != 0 {
		t.Fatal("create should be skipped")
	}
	var env contracts.MessageCreated
	if err := json.Unmarshal(bus.lastEvent(), &env); err != nil {
		t.Fatal(err)
	}
	if env.ConversationID != thread.ConversationID.String() || env.Payload.SourceID != "msg-2" {
		t.Fatalf("%+v", env)
	}
}

func TestAcceptKakao_DuplicateSkipsPublish(t *testing.T) {
	kakao := &fakeKakao{account: mustV7(t), inbox: mustV7(t), thread: gateway.CreateOut{
		ContactID: mustV7(t), ContactInboxID: mustV7(t), ConversationID: mustV7(t),
	}, found: true, dup: true}
	bus := &fakeBus{}
	svc := &gateway.Service{Kakao: kakao, Bus: bus}
	if err := svc.AcceptKakao(context.Background(), cstalkBody("sender-acme", "user-ada", "msg-1", "hi")); err != nil {
		t.Fatal(err)
	}
	if ev, _ := bus.counts(); ev != 0 {
		t.Fatalf("published %d", ev)
	}
}

func TestAcceptKakao_UnknownSender(t *testing.T) {
	kakao := &fakeKakao{inboxErr: core.ErrNotFound}
	svc := &gateway.Service{Kakao: kakao, Bus: &fakeBus{}}
	if err := svc.AcceptKakao(context.Background(), cstalkBody("missing", "user-ada", "msg-1", "hi")); err != core.ErrNotFound {
		t.Fatalf("got %v", err)
	}
}

func TestHTTP_CstalkMessage_A000(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	created := gateway.CreateOut{
		ContactID: mustV7(t), ContactInboxID: mustV7(t), ConversationID: mustV7(t), DisplayID: 1,
	}
	kakao := &fakeKakao{account: accountID, inbox: inboxID, createOut: created}
	bus := &fakeBus{}
	srv := &gateway.Server{Service: &gateway.Service{Kakao: kakao, Bus: bus}}
	httpSrv := httptest.NewServer(srv.KakaoHandler())
	t.Cleanup(httpSrv.Close)
	resp, err := http.Post(httpSrv.URL+"/cstalk/message", "application/json", bytes.NewReader(cstalkBody("sender-acme", "user-ada", "msg-1", "안녕")))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var out struct {
		Code   string `json:"code"`
		Result string `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Code != "A000" || out.Result != "Success" {
		t.Fatalf("%+v", out)
	}
	if ev, _ := bus.counts(); ev != 1 {
		t.Fatalf("events=%d", ev)
	}
}
