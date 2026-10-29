package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/gateway"
)

type fakeSnooze struct {
	gotUntil time.Time
	out      gateway.SnoozeOut
	err      error
}

func (f *fakeSnooze) Snooze(_ context.Context, _, _, _ uuid.UUID, until time.Time, _ int) (gateway.SnoozeOut, error) {
	f.gotUntil = until
	return f.out, f.err
}

func TestHTTP_SnoozeSchedulesWake(t *testing.T) {
	accountID, actorID, convID := mustV7(t), mustV7(t), mustV7(t)
	until := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	snooze := &fakeSnooze{out: gateway.SnoozeOut{Status: "snoozed", Version: 2, SnoozedUntil: until}}
	bus := &fakeBus{}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Snooze: snooze, Bus: bus},
	}).Handler())
	t.Cleanup(srv.Close)

	body, _ := json.Marshal(map[string]any{"snoozed_until": until.Format(time.RFC3339), "expected_version": 1})
	req, err := http.NewRequest(http.MethodPut,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/snooze",
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
		Status       string `json:"status"`
		Version      int    `json:"version"`
		SnoozedUntil string `json:"snoozed_until"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Status != "snoozed" || got.Version != 2 || got.SnoozedUntil != until.Format(time.RFC3339) {
		t.Fatalf("%+v", got)
	}
	if !snooze.gotUntil.Equal(until) {
		t.Fatalf("until %s", snooze.gotUntil)
	}
	if len(bus.schedules) != 1 || bus.schedules[0] != convID {
		t.Fatalf("schedule %+v", bus.schedules)
	}
}

func TestHTTP_SnoozeDenied(t *testing.T) {
	accountID, actorID, convID := mustV7(t), mustV7(t), mustV7(t)
	until := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Snooze: &fakeSnooze{err: core.ErrDenied}},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]any{"snoozed_until": until, "expected_version": 1})
	req, err := http.NewRequest(http.MethodPut,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/snooze",
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
