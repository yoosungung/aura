package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-smtp"
	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/contracts"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/gateway"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func rfc822(s string) []byte {
	return []byte(strings.ReplaceAll(s, "\n", "\r\n"))
}

type fakeEmail struct {
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
	reply     gateway.EmailReplyOut
	replySkip bool
	replyErr  error
}

func (f *fakeEmail) ResolveInbox(_ context.Context, _ string) (uuid.UUID, uuid.UUID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.inboxErr != nil {
		return uuid.Nil, uuid.Nil, f.inboxErr
	}
	return f.account, f.inbox, nil
}

func (f *fakeEmail) ResolveThread(_ context.Context, _, _ uuid.UUID, _ string, _ []string, _ int64) (gateway.CreateOut, bool, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.threadErr != nil {
		return gateway.CreateOut{}, false, false, f.threadErr
	}
	return f.thread, f.found, f.dup, nil
}

func (f *fakeEmail) EmailReply(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (gateway.EmailReplyOut, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reply, f.replySkip, f.replyErr
}

func (f *fakeEmail) CreateEmail(_ context.Context, _, _ uuid.UUID, _, _, _ string) (gateway.CreateOut, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.creates++
	return f.createOut, f.createErr
}

func (f *fakeEmail) createCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.creates
}

type memBlob struct {
	mu      sync.Mutex
	objects map[string][]byte
}

func (m *memBlob) Put(_ context.Context, key string, r io.Reader, _ int64, _ string) (string, error) {
	b, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.objects == nil {
		m.objects = map[string][]byte{}
	}
	m.objects[key] = b
	return "http://filer/" + key, nil
}

func TestBuildOutboundMIME_ThreadsForReply(t *testing.T) {
	raw, err := gateway.BuildOutboundMIME(gateway.OutboundMail{
		From: "Support@acme.test", To: "ada@example.com", Content: "확인했습니다",
		DisplayID: 7, MessageID: "out@aura", InReplyTo: "old@x",
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := gateway.ParseMIME(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.From != "support@acme.test" || got.To != "ada@example.com" {
		t.Fatalf("addr %+v", got)
	}
	if got.DisplayID != 7 || got.MessageID != "out@aura" {
		t.Fatalf("meta %+v", got)
	}
	if len(got.ReplyIDs) == 0 || got.ReplyIDs[0] != "old@x" {
		t.Fatalf("reply %v", got.ReplyIDs)
	}
	if got.Content != "확인했습니다" {
		t.Fatalf("content %q", got.Content)
	}
}

func TestParseMIME_InReplyToAndDelimiter(t *testing.T) {
	raw := rfc822(`From: Ada Lovelace <ada@example.com>
To: Support@acme.test
Subject: Re: Hello [#REQ-7]
Message-ID: <new@x>
In-Reply-To: <old@x>
References: <older@x> <old@x>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

still broken
##- Please type your reply above this line -##
quoted history
`)
	got, err := gateway.ParseMIME(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.From != "ada@example.com" || got.FromName != "Ada Lovelace" || got.To != "support@acme.test" {
		t.Fatalf("from/to %+v", got)
	}
	if got.MessageID != "new@x" || got.DisplayID != 7 || got.Content != "still broken" {
		t.Fatalf("%+v", got)
	}
	if len(got.ReplyIDs) != 2 || got.ReplyIDs[0] != "old@x" || got.ReplyIDs[1] != "older@x" {
		t.Fatalf("reply %v", got.ReplyIDs)
	}
}

func TestAcceptEmail_CreateThenPublish(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	created := gateway.CreateOut{
		ContactID: mustV7(t), ContactInboxID: mustV7(t), ConversationID: mustV7(t), DisplayID: 1,
	}
	email := &fakeEmail{account: accountID, inbox: inboxID, createOut: created}
	bus := &fakeBus{}
	svc := &gateway.Service{Email: email, Bus: bus}
	raw := rfc822(`From: ada@example.com
To: support@acme.test
Subject: Help
Message-ID: <first@x>
Content-Type: text/plain

need help
`)
	if err := svc.AcceptEmail(context.Background(), raw, "ada@example.com", []string{"support@acme.test"}); err != nil {
		t.Fatal(err)
	}
	if email.createCount() != 1 {
		t.Fatalf("creates=%d", email.createCount())
	}
	ev, rt := bus.counts()
	if ev != 1 || rt != 1 {
		t.Fatalf("events=%d realtime=%d", ev, rt)
	}
	var env contracts.MessageCreated
	if err := json.Unmarshal(bus.lastEvent(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Payload.SourceID != "first@x" || env.Payload.Content != "need help" || env.Payload.MessageType != gateway.MessageIncoming {
		t.Fatalf("%+v", env.Payload)
	}
	if env.ConversationID != created.ConversationID.String() {
		t.Fatalf("conv %s", env.ConversationID)
	}
}

func TestAcceptEmail_ThreadHitSkipsCreate(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	thread := gateway.CreateOut{
		ContactID: mustV7(t), ContactInboxID: mustV7(t), ConversationID: mustV7(t), DisplayID: 7,
	}
	email := &fakeEmail{account: accountID, inbox: inboxID, thread: thread, found: true}
	bus := &fakeBus{}
	svc := &gateway.Service{Email: email, Bus: bus}
	raw := rfc822(`From: ada@example.com
To: support@acme.test
Subject: Re: Hello [#REQ-7]
Message-ID: <reply@x>
In-Reply-To: <old@x>
Content-Type: text/plain

follow up
`)
	if err := svc.AcceptEmail(context.Background(), raw, "", []string{"support@acme.test"}); err != nil {
		t.Fatal(err)
	}
	if email.createCount() != 0 {
		t.Fatal("create should be skipped")
	}
	var env contracts.MessageCreated
	if err := json.Unmarshal(bus.lastEvent(), &env); err != nil {
		t.Fatal(err)
	}
	if env.ConversationID != thread.ConversationID.String() || env.Payload.SourceID != "reply@x" {
		t.Fatalf("%+v", env)
	}
}

func TestAcceptEmail_DuplicateSkipsPublish(t *testing.T) {
	email := &fakeEmail{account: mustV7(t), inbox: mustV7(t), thread: gateway.CreateOut{
		ContactID: mustV7(t), ContactInboxID: mustV7(t), ConversationID: mustV7(t),
	}, found: true, dup: true}
	bus := &fakeBus{}
	svc := &gateway.Service{Email: email, Bus: bus}
	raw := rfc822(`From: ada@example.com
To: support@acme.test
Subject: Help
Message-ID: <dup@x>
Content-Type: text/plain

hi
`)
	if err := svc.AcceptEmail(context.Background(), raw, "", []string{"support@acme.test"}); err != nil {
		t.Fatal(err)
	}
	if ev, _ := bus.counts(); ev != 0 {
		t.Fatalf("published %d", ev)
	}
}

func TestAcceptEmail_UnknownInbox(t *testing.T) {
	email := &fakeEmail{inboxErr: core.ErrNotFound}
	svc := &gateway.Service{Email: email, Bus: &fakeBus{}}
	raw := rfc822(`From: ada@example.com
To: nobody@acme.test
Subject: Help
Content-Type: text/plain

hi
`)
	if err := svc.AcceptEmail(context.Background(), raw, "", []string{"nobody@acme.test"}); err != core.ErrNotFound {
		t.Fatalf("got %v", err)
	}
}

func TestAcceptEmail_LargeBodyClaimCheck(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	created := gateway.CreateOut{
		ContactID: mustV7(t), ContactInboxID: mustV7(t), ConversationID: mustV7(t), DisplayID: 1,
	}
	email := &fakeEmail{account: accountID, inbox: inboxID, createOut: created}
	bus := &fakeBus{}
	blobs := &memBlob{}
	svc := &gateway.Service{Email: email, Bus: bus, Blobs: blobs}
	body := strings.Repeat("x", 210_000)
	raw := rfc822("From: ada@example.com\nTo: support@acme.test\nSubject: huge\nMessage-ID: <big@x>\nContent-Type: text/plain\n\n" + body + "\n")
	if err := svc.AcceptEmail(context.Background(), raw, "", []string{"support@acme.test"}); err != nil {
		t.Fatal(err)
	}
	var env contracts.MessageCreated
	if err := json.Unmarshal(bus.lastEvent(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Payload.ContentRef == "" || !strings.Contains(env.Payload.ContentRef, "/mime/") {
		t.Fatalf("content_ref %q", env.Payload.ContentRef)
	}
	if len(env.Payload.Content) > 8192 {
		t.Fatalf("content len %d", len(env.Payload.Content))
	}
	if len(blobs.objects) != 1 {
		t.Fatalf("blobs %d", len(blobs.objects))
	}
}

type fakeMailer struct {
	mu   sync.Mutex
	from string
	to   []string
	raw  []byte
}

func (f *fakeMailer) Send(from string, to []string, raw []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.from = from
	f.to = append([]string(nil), to...)
	f.raw = append([]byte(nil), raw...)
	return nil
}

func TestDeliverOutbound_SendsThreadedMail(t *testing.T) {
	mailer := &fakeMailer{}
	svc := &gateway.Service{Mailer: mailer}
	if err := svc.DeliverOutbound(context.Background(), gateway.OutboundTask{
		From: "support@acme.test", To: "ada@example.com", Content: "확인했습니다",
		SourceID: "out@aura", InReplyTo: "old@x", DisplayID: 7,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := gateway.ParseMIME(mailer.raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.From != "support@acme.test" || got.To != "ada@example.com" || got.Content != "확인했습니다" || got.MessageID != "out@aura" {
		t.Fatalf("%+v", got)
	}
}

func TestConsumeOutbound_SendsThreadedMail(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	mailer := &fakeMailer{}
	svc := &gateway.Service{JS: js, Mailer: mailer}
	go func() { _ = svc.ConsumeOutbound(ctx) }()
	time.Sleep(200 * time.Millisecond)
	task, err := json.Marshal(gateway.OutboundTask{
		From: "support@acme.test", To: "ada@example.com", Content: "확인했습니다",
		SourceID: "out@aura", InReplyTo: "old@x", DisplayID: 7,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.Publish(ctx, gateway.OutboundEmailSubject, task); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mailer.mu.Lock()
		raw := mailer.raw
		mailer.mu.Unlock()
		if len(raw) > 0 {
			got, err := gateway.ParseMIME(raw)
			if err != nil {
				t.Fatal(err)
			}
			if got.From != "support@acme.test" || got.To != "ada@example.com" || got.Content != "확인했습니다" || got.MessageID != "out@aura" {
				t.Fatalf("%+v", got)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no outbound mail")
}

func TestServeSMTP_DataPublishesMessageCreated(t *testing.T) {
	accountID, inboxID := mustV7(t), mustV7(t)
	created := gateway.CreateOut{
		ContactID: mustV7(t), ContactInboxID: mustV7(t), ConversationID: mustV7(t), DisplayID: 1,
	}
	email := &fakeEmail{account: accountID, inbox: inboxID, createOut: created}
	bus := &fakeBus{}
	svc := &gateway.Service{Email: email, Bus: bus}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() { errCh <- svc.ServeSMTP(ctx, ln) }()

	raw := rfc822(`From: ada@example.com
To: support@acme.test
Subject: via smtp
Message-ID: <smtp@x>
Content-Type: text/plain

hello smtp
`)
	deadline := time.Now().Add(5 * time.Second)
	var c *smtp.Client
	for time.Now().Before(deadline) {
		c, err = smtp.Dial(ln.Addr().String())
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Mail("ada@example.com", nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Rcpt("support@acme.test", nil); err != nil {
		t.Fatal(err)
	}
	wc, err := c.Data()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(wc, bytes.NewReader(raw)); err != nil {
		t.Fatal(err)
	}
	if err := wc.Close(); err != nil {
		t.Fatal(err)
	}
	_ = c.Quit()

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if ev, _ := bus.counts(); ev == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	var env contracts.MessageCreated
	if err := json.Unmarshal(bus.lastEvent(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Payload.SourceID != "smtp@x" || env.Payload.Content != "hello smtp" {
		t.Fatalf("%+v", env.Payload)
	}
	cancel()
	select {
	case <-errCh:
	case <-time.After(2 * time.Second):
		t.Fatal("smtp server did not stop")
	}
}
