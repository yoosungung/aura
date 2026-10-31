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

type fakeLabels struct {
	added []string
	out   gateway.LabelOut
	err   error
}

func (f *fakeLabels) AddConversationLabel(_ context.Context, _, _, _ uuid.UUID, name string) (gateway.LabelOut, error) {
	f.added = append(f.added, name)
	return f.out, f.err
}
func (f *fakeLabels) RemoveConversationLabel(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return nil
}
func (f *fakeLabels) ListConversationLabels(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) ([]gateway.LabelOut, error) {
	if f.out.ID == uuid.Nil {
		return []gateway.LabelOut{}, f.err
	}
	return []gateway.LabelOut{f.out}, f.err
}
func (f *fakeLabels) ListAccountLabels(context.Context, uuid.UUID, uuid.UUID) ([]gateway.LabelOut, error) {
	if f.out.ID == uuid.Nil {
		return []gateway.LabelOut{}, f.err
	}
	return []gateway.LabelOut{f.out}, f.err
}
func (f *fakeLabels) CreateAccountLabel(_ context.Context, _, _ uuid.UUID, name string) (gateway.LabelOut, error) {
	f.added = append(f.added, name)
	return f.out, f.err
}
func (f *fakeLabels) UpdateAccountLabel(_ context.Context, _, _, _ uuid.UUID, name string) (gateway.LabelOut, error) {
	f.added = append(f.added, name)
	return f.out, f.err
}
func (f *fakeLabels) DeleteAccountLabel(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return f.err
}

func TestHTTP_AttachConversationLabel(t *testing.T) {
	accountID, actorID, convID, labelID := mustV7(t), mustV7(t), mustV7(t), mustV7(t)
	lbl := &fakeLabels{out: gateway.LabelOut{ID: labelID, Name: "환불"}}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Labels: lbl},
	}).Handler())
	t.Cleanup(srv.Close)

	body, _ := json.Marshal(map[string]any{"name": "환불"})
	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/labels",
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
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.ID != labelID.String() || got.Name != "환불" || len(lbl.added) != 1 {
		t.Fatalf("%+v added=%v", got, lbl.added)
	}
}

func TestHTTP_LabelDenied(t *testing.T) {
	accountID, actorID, convID := mustV7(t), mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Labels: &fakeLabels{err: core.ErrDenied}},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]any{"name": "환불"})
	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/labels",
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

func TestHTTP_CreateAccountLabel(t *testing.T) {
	accountID, actorID, labelID := mustV7(t), mustV7(t), mustV7(t)
	lbl := &fakeLabels{out: gateway.LabelOut{ID: labelID, Name: "결제"}}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Labels: lbl},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]any{"name": "결제"})
	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/labels", bytes.NewReader(body))
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
}

func TestHTTP_UpdateAccountLabel(t *testing.T) {
	accountID, actorID, labelID := mustV7(t), mustV7(t), mustV7(t)
	lbl := &fakeLabels{out: gateway.LabelOut{ID: labelID, Name: "환불"}}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Labels: lbl},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]any{"name": "환불"})
	req, err := http.NewRequest(http.MethodPatch,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/labels/"+labelID.String(), bytes.NewReader(body))
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
}
