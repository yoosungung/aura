package core_test

import (
	"context"
	"testing"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestEgoGraph_OneTwoHopExcludesExpiredAndOtherCustomers(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "other", Name: "Other", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}

	center := mustV7(t)
	pain := mustV7(t)
	product := mustV7(t)
	otherCust := mustV7(t)
	expiredPref := mustV7(t)
	livePref := mustV7(t)
	if _, err := admin.Exec(ctx, `
		INSERT INTO ontology_nodes (id, account_id, entity_type, name, external_ref_id) VALUES
		($1,$2,'Customer','Ada',$3),
		($4,$2,'PainPoint','결제 오류',NULL),
		($5,$2,'Product','프로 플랜',NULL),
		($6,$2,'Customer','Bob',$7),
		($8,$2,'Preference','이메일',NULL),
		($9,$2,'Preference','카카오',NULL)`,
		center, accountID, created.ContactID.String(),
		pain, product, otherCust, other.ContactID.String(),
		expiredPref, livePref,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO ontology_edges (id, account_id, source_node_id, target_node_id, relation_type, weight, valid_until) VALUES
		($1,$2,$3,$4,'EXPERIENCED',1,NULL),
		($5,$2,$3,$6,'PREFERS',1,NULL),
		($7,$2,$6,$8,'PREFERS',1,NULL),
		($9,$2,$3,$10,'PREFERS',1, CURRENT_TIMESTAMP - INTERVAL '1 day')`,
		mustV7(t), accountID, center, pain,
		mustV7(t), product,
		mustV7(t), otherCust,
		mustV7(t), expiredPref,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO ontology_edges (id, account_id, source_node_id, target_node_id, relation_type, weight) VALUES
		($1,$2,$3,$4,'PREFERS',2)`,
		mustV7(t), accountID, center, livePref,
	); err != nil {
		t.Fatal(err)
	}

	rows, err := svc.EgoGraph(ctx, core.EgoInput{ActorUserID: adminID, AccountID: accountID, ContactID: created.ContactID})
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]int{}
	for _, r := range rows {
		names[r.Name] = r.Hop
	}
	if names["결제 오류"] != 1 || names["프로 플랜"] != 1 || names["카카오"] != 1 {
		t.Fatalf("%+v", rows)
	}
	if _, ok := names["Bob"]; ok {
		t.Fatal("other customer leaked")
	}
	if _, ok := names["이메일"]; ok {
		t.Fatal("expired edge leaked")
	}
}
