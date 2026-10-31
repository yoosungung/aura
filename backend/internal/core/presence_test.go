package core_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestSetPresence_UpdatesAvailability(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, _, userID := seedAgent(t, admin, "s3cret")
	svc := &core.Service{DB: app}

	var status string
	if err := admin.QueryRow(ctx, `SELECT availability_status FROM users WHERE id = $1`, userID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "offline" {
		t.Fatalf("default %s", status)
	}

	if err := svc.SetPresence(ctx, core.PresenceInput{
		UserID: userID, AccountID: accountID, Status: "online",
	}); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT availability_status FROM users WHERE id = $1`, userID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "online" {
		t.Fatalf("got %s", status)
	}

	if err := svc.SetPresence(ctx, core.PresenceInput{
		UserID: userID, AccountID: accountID, Status: "offline",
	}); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT availability_status FROM users WHERE id = $1`, userID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "offline" {
		t.Fatalf("got %s", status)
	}
}

func TestRPC_Presence(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, _, userID := seedAgent(t, admin, "s3cret")
	go func() {
		_ = core.Serve(ctx, nc, js, appPool(t, app))
	}()
	time.Sleep(200 * time.Millisecond)

	req, _ := json.Marshal(map[string]string{
		"user_id": userID.String(), "account_id": accountID.String(), "status": "online",
	})
	reply, err := nc.Request(core.SubjectAuthPresence, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK {
		t.Fatalf("%s", reply.Data)
	}
	var status string
	if err := admin.QueryRow(ctx, `SELECT availability_status FROM users WHERE id = $1`, userID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "online" {
		t.Fatalf("got %s", status)
	}
}
