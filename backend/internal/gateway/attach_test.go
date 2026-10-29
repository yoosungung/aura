package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/gateway"
)

type fakeBlobs struct {
	key  string
	body []byte
	n    int
}

func (f *fakeBlobs) Put(_ context.Context, key string, r io.Reader, size int64, _ string) (string, error) {
	b, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	f.key = key
	f.body = b
	f.n++
	_ = size
	return "http://127.0.0.1:8888/" + key, nil
}

func TestHTTP_UploadConversationAttachment(t *testing.T) {
	accountID, actorID, inboxID := mustV7(t), mustV7(t), mustV7(t)
	convID, contactID, contactInboxID := mustV7(t), mustV7(t), mustV7(t)
	blobs := &fakeBlobs{}
	bus := &fakeBus{}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Bus: bus, Blobs: blobs},
	}).Handler())
	t.Cleanup(srv.Close)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", "receipt.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write([]byte("pngdata")); err != nil {
		t.Fatal(err)
	}
	_ = mw.WriteField("inbox_id", inboxID.String())
	_ = mw.WriteField("contact_id", contactID.String())
	_ = mw.WriteField("contact_inbox_id", contactInboxID.String())
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}

	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/attachments",
		&buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+mustSign(t, gateway.Token{
		Kind: gateway.KindUser, AccountID: accountID, UserID: actorID, Sid: mustV7(t),
		InboxIDs: []uuid.UUID{inboxID},
	}))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var got struct {
		MessageID   string `json:"message_id"`
		Attachments []struct {
			ID          string `json:"id"`
			FileType    string `json:"file_type"`
			ExternalURL string `json:"external_url"`
			FileSize    int    `json:"file_size"`
		} `json:"attachments"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.MessageID == "" || len(got.Attachments) != 1 {
		t.Fatalf("%+v", got)
	}
	att := got.Attachments[0]
	if att.FileType != "image" || att.FileSize != 7 || !strings.Contains(att.ExternalURL, "receipt.png") {
		t.Fatalf("%+v", att)
	}
	if blobs.n != 1 || !strings.Contains(blobs.key, accountID.String()) || !strings.HasSuffix(blobs.key, "/receipt.png") {
		t.Fatalf("blob key=%s n=%d", blobs.key, blobs.n)
	}
	if string(blobs.body) != "pngdata" {
		t.Fatalf("body %q", blobs.body)
	}
	ev, _ := bus.counts()
	if ev != 1 {
		t.Fatalf("events=%d", ev)
	}
	var env map[string]any
	if err := json.Unmarshal(bus.lastEvent(), &env); err != nil {
		t.Fatal(err)
	}
	payload := env["payload"].(map[string]any)
	atts := payload["attachments"].([]any)
	if len(atts) != 1 {
		t.Fatalf("payload attachments=%v", payload["attachments"])
	}
}

func TestHTTP_UploadAttachmentDenied(t *testing.T) {
	accountID, actorID, convID := mustV7(t), mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Bus: &fakeBus{}, Blobs: &fakeBlobs{}},
	}).Handler())
	t.Cleanup(srv.Close)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "a.txt")
	_, _ = fw.Write([]byte("x"))
	_ = mw.WriteField("inbox_id", mustV7(t).String())
	_ = mw.WriteField("contact_id", mustV7(t).String())
	_ = mw.WriteField("contact_inbox_id", mustV7(t).String())
	_ = mw.Close()

	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/attachments",
		&buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
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
