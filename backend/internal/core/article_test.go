package core_test

import (
	"context"
	"testing"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestCreateArticle_AdminPublishes(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}
	got, err := svc.CreateArticle(ctx, core.ArticleInput{
		ActorUserID: adminID, AccountID: accountID,
		Title: "결제 오류", Slug: "pay-error", Body: "카드 한도를 확인하세요", Published: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "결제 오류" || !got.Published {
		t.Fatalf("%+v", got)
	}
	_, err = svc.CreateArticle(ctx, core.ArticleInput{
		ActorUserID: agentID, AccountID: accountID, Title: "nope", Slug: "nope", Body: "x",
	})
	if err != core.ErrDenied {
		t.Fatalf("agent got %v", err)
	}
	hits, err := svc.SearchArticles(ctx, inboxID, "결제")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].Slug != "pay-error" {
		t.Fatalf("%+v", hits)
	}
	draft, err := svc.CreateArticle(ctx, core.ArticleInput{
		ActorUserID: adminID, AccountID: accountID,
		Title: "내부", Slug: "internal", Body: "결제 초안", Published: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = draft
	hits, err = svc.SearchArticles(ctx, inboxID, "결제")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 {
		t.Fatalf("draft leaked %+v", hits)
	}
}

func TestDeleteArticle_AdminRemovesFromSearch(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}
	got, err := svc.CreateArticle(ctx, core.ArticleInput{
		ActorUserID: adminID, AccountID: accountID,
		Title: "결제 오류", Slug: "pay-error", Body: "카드 한도를 확인하세요", Published: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteArticle(ctx, core.ArticleInput{ActorUserID: agentID, AccountID: accountID, ArticleID: got.ID}); err != core.ErrDenied {
		t.Fatalf("agent got %v", err)
	}
	if err := svc.DeleteArticle(ctx, core.ArticleInput{ActorUserID: adminID, AccountID: accountID, ArticleID: got.ID}); err != nil {
		t.Fatal(err)
	}
	hits, err := svc.SearchArticles(ctx, inboxID, "결제")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 0 {
		t.Fatalf("deleted article leaked %+v", hits)
	}
}

func TestUpdateArticle_AdminEditsBody(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}
	got, err := svc.CreateArticle(ctx, core.ArticleInput{
		ActorUserID: adminID, AccountID: accountID,
		Title: "결제 오류", Slug: "pay-error", Body: "카드 한도를 확인하세요", Published: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateArticle(ctx, core.ArticleInput{
		ActorUserID: agentID, AccountID: accountID, ArticleID: got.ID,
		Title: "결제 FAQ", Slug: "pay-faq", Body: "한도를 올리세요", Published: true,
	}); err != core.ErrDenied {
		t.Fatalf("agent got %v", err)
	}
	updated, err := svc.UpdateArticle(ctx, core.ArticleInput{
		ActorUserID: adminID, AccountID: accountID, ArticleID: got.ID,
		Title: "결제 FAQ", Slug: "pay-faq", Body: "한도를 올리세요", Published: true,
	})
	if err != nil || updated.Slug != "pay-faq" || updated.Body != "한도를 올리세요" {
		t.Fatalf("%+v %v", updated, err)
	}
	hits, err := svc.SearchArticles(ctx, inboxID, "한도")
	if err != nil || len(hits) != 1 || hits[0].Slug != "pay-faq" {
		t.Fatalf("%+v %v", hits, err)
	}
}
