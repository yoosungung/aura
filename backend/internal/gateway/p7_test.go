package gateway_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/gateway"
)

type fakeAI struct {
	nodes []gateway.EgoNode
	err   error
}

func (f *fakeAI) Ego(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) ([]gateway.EgoNode, error) {
	return f.nodes, f.err
}
func (f *fakeAI) ApproveTool(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return f.err
}
func (f *fakeAI) PurgeContact(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return f.err
}

func TestHTTP_EgoAndApprove(t *testing.T) {
	accountID, actorID, contactID := mustV7(t), mustV7(t), mustV7(t)
	convID, execID := mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{
			Secret: secret,
			AI: &fakeAI{nodes: []gateway.EgoNode{{
				ID: mustV7(t), EntityType: "PainPoint", Name: "결제 오류", Hop: 1,
			}}},
		},
	}).Handler())
	t.Cleanup(srv.Close)
	tok := userToken(t, accountID, actorID)
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/accounts/"+accountID.String()+"/contacts/"+contactID.String()+"/ego", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("ego %d", res.StatusCode)
	}
	var body struct {
		Nodes []struct {
			Name string `json:"name"`
		} `json:"nodes"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Nodes) != 1 || body.Nodes[0].Name != "결제 오류" {
		t.Fatalf("%+v", body)
	}
	req, _ = http.NewRequest(http.MethodPost, srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/tools/"+execID.String()+"/approve", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("approve %d", res.StatusCode)
	}
}
