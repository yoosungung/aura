package gateway_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yoosungung/aura/internal/gateway"
)

func TestHTTP_ContactCSATPublishes(t *testing.T) {
	accountID, inboxID, convID := mustV7(t), mustV7(t), mustV7(t)
	bus := &fakeBus{}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Bus: bus},
	}).Handler())
	t.Cleanup(srv.Close)
	tok, err := gateway.Sign(secret, gateway.Token{
		Kind: gateway.KindContact, AccountID: accountID, InboxID: inboxID,
		ConversationID: convID, Sid: mustV7(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/public/api/v1/inboxes/"+inboxID.String()+"/csat",
		strings.NewReader(`{"rating":5,"feedback":"좋았어요"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	ev, _ := bus.counts()
	if ev != 1 {
		t.Fatalf("events=%d", ev)
	}
	var env struct {
		Type    string `json:"type"`
		Payload struct {
			Rating   int    `json:"rating"`
			Feedback string `json:"feedback"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(bus.lastEvent(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "csat_submitted" || env.Payload.Rating != 5 || env.Payload.Feedback != "좋았어요" {
		t.Fatalf("%+v", env)
	}
}

func TestSubmitCSAT_RejectsBadRating(t *testing.T) {
	inboxID := mustV7(t)
	svc := &gateway.Service{Secret: secret, Bus: &fakeBus{}}
	err := svc.SubmitCSAT(context.Background(), gateway.Token{
		Kind: gateway.KindContact, InboxID: inboxID, ConversationID: mustV7(t),
	}, inboxID, 9, "")
	if err != gateway.ErrInvalid {
		t.Fatalf("got %v", err)
	}
}
