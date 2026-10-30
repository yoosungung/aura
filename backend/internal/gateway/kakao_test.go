package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/contracts"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/gateway"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
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
	reply     gateway.KakaoReplyOut
	replySkip bool
	replyErr  error
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

func (f *fakeKakao) KakaoReply(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (gateway.KakaoReplyOut, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reply, f.replySkip, f.replyErr
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

type fakeKakaoSender struct {
	mu            sync.Mutex
	consult       int
	from, to, msg string
}

func (f *fakeKakaoSender) SendConsult(_ context.Context, senderKey, userKey, message string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.consult++
	f.from, f.to, f.msg = senderKey, userKey, message
	return nil
}

func TestDeliverKakao_ConsultWhenSessionLive(t *testing.T) {
	sender := &fakeKakaoSender{}
	svc := &gateway.Service{KakaoSender: sender}
	if err := svc.DeliverKakaoOutbound(context.Background(), gateway.OutboundTask{
		From: "sender-acme", To: "user-ada", Content: "확인했습니다", SessionLive: true,
	}); err != nil {
		t.Fatal(err)
	}
	if sender.consult != 1 || sender.msg != "확인했습니다" {
		t.Fatalf("%+v", sender)
	}
}

func TestDeliverKakao_SkipsWhenExpired(t *testing.T) {
	sender := &fakeKakaoSender{}
	svc := &gateway.Service{KakaoSender: sender}
	if err := svc.DeliverKakaoOutbound(context.Background(), gateway.OutboundTask{
		From: "sender-acme", To: "user-ada", Content: "확인했습니다", SessionLive: false,
	}); err != nil {
		t.Fatal(err)
	}
	if sender.consult != 0 {
		t.Fatalf("%+v", sender)
	}
}

func TestSubmit_AgentKakaoPublishesOutbound(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	bus := &fakeBus{}
	email := &fakeEmail{replySkip: true}
	kakao := &fakeKakao{reply: gateway.KakaoReplyOut{
		From: "sender-acme", To: "user-ada", SessionLive: true,
	}}
	svc := &gateway.Service{Secret: secret, Bus: bus, Email: email, Kakao: kakao}
	tok := gateway.Token{
		Kind: gateway.KindUser, AccountID: accountID, UserID: mustV7(t),
		InboxIDs: []uuid.UUID{inboxID},
	}
	if _, err := svc.SubmitAgent(context.Background(), tok, accountID, mustV7(t), gateway.SubmitRequest{
		Content: "확인했습니다", InboxID: inboxID, ContactID: mustV7(t), ContactInboxID: mustV7(t),
	}); err != nil {
		t.Fatal(err)
	}
	bus.mu.Lock()
	defer bus.mu.Unlock()
	if len(bus.events) != 2 || bus.events[1] != gateway.OutboundKakaoSubject {
		t.Fatalf("events %v", bus.events)
	}
	var task gateway.OutboundTask
	if err := json.Unmarshal(bus.payloads[1], &task); err != nil {
		t.Fatal(err)
	}
	if task.From != "sender-acme" || task.To != "user-ada" || !task.SessionLive || task.Content != "확인했습니다" {
		t.Fatalf("%+v", task)
	}
}

func TestSubmit_AgentKakaoExpiredSkipsOutbound(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	bus := &fakeBus{}
	email := &fakeEmail{replySkip: true}
	kakao := &fakeKakao{reply: gateway.KakaoReplyOut{
		From: "sender-acme", To: "user-ada", SessionLive: false,
	}}
	svc := &gateway.Service{Secret: secret, Bus: bus, Email: email, Kakao: kakao}
	tok := gateway.Token{
		Kind: gateway.KindUser, AccountID: accountID, UserID: mustV7(t),
		InboxIDs: []uuid.UUID{inboxID},
	}
	if _, err := svc.SubmitAgent(context.Background(), tok, accountID, mustV7(t), gateway.SubmitRequest{
		Content: "확인했습니다", InboxID: inboxID, ContactID: mustV7(t), ContactInboxID: mustV7(t),
	}); err != nil {
		t.Fatal(err)
	}
	ev, _ := bus.counts()
	if ev != 1 {
		t.Fatalf("events=%d", ev)
	}
}

func TestConsumeKakaoOutbound_SendsConsult(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	sender := &fakeKakaoSender{}
	svc := &gateway.Service{JS: js, KakaoSender: sender}
	go func() { _ = svc.ConsumeKakaoOutbound(ctx) }()
	time.Sleep(200 * time.Millisecond)
	task, err := json.Marshal(gateway.OutboundTask{
		From: "sender-acme", To: "user-ada", Content: "확인했습니다", SessionLive: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.Publish(ctx, gateway.OutboundKakaoSubject, task); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		sender.mu.Lock()
		n := sender.consult
		sender.mu.Unlock()
		if n == 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no kakao send")
}
