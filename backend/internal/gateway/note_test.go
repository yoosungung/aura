package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/gateway"
)

type fakeNotes struct {
	gotActor uuid.UUID
	gotBody  string
	out      gateway.NoteOut
	err      error
}

func (f *fakeNotes) AddNote(_ context.Context, actor, _, _ uuid.UUID, content string) (gateway.NoteOut, error) {
	f.gotActor = actor
	f.gotBody = content
	return f.out, f.err
}

func TestHTTP_AddNote(t *testing.T) {
	accountID, actorID, convID, msgID := mustV7(t), mustV7(t), mustV7(t), mustV7(t)
	notes := &fakeNotes{out: gateway.NoteOut{
		MessageID: msgID, ConversationID: convID, Content: "환불 검토", Private: true,
	}}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Notes: notes},
	}).Handler())
	t.Cleanup(srv.Close)

	body, _ := json.Marshal(map[string]string{"content": "환불 검토"})
	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/notes",
		bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+userToken(t, accountID, actorID))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var got struct {
		MessageID string `json:"message_id"`
		Private   bool   `json:"private"`
		Content   string `json:"content"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.MessageID != msgID.String() || !got.Private || got.Content != "환불 검토" {
		t.Fatalf("%+v", got)
	}
	if notes.gotActor != actorID || notes.gotBody != "환불 검토" {
		t.Fatalf("rpc %+v", notes)
	}
}

func TestHTTP_AddNoteDenied(t *testing.T) {
	accountID, actorID, convID := mustV7(t), mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Notes: &fakeNotes{err: core.ErrDenied}},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]string{"content": "몰래"})
	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/notes",
		bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+userToken(t, accountID, actorID))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestHidePrivateFromContact(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{
		"event": "message.created",
		"message": map[string]any{
			"payload": map[string]any{"private": true, "content": "내부"},
		},
	})
	contact := gateway.Token{Kind: gateway.KindContact}
	if !gateway.HidePrivateFromContact(contact, raw) {
		t.Fatal("contact should not see private")
	}
	agent := gateway.Token{Kind: gateway.KindUser}
	if gateway.HidePrivateFromContact(agent, raw) {
		t.Fatal("agent should see private")
	}
}
