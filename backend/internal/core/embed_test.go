package core_test

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestEmbeddings_CosinePrefersCurrentModel(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, _ := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	near, err := svc.CreateArticle(ctx, core.ArticleInput{
		ActorUserID: adminID, AccountID: accountID, Title: "배송", Slug: "ship", Body: "영업일 2일", Published: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	far, err := svc.CreateArticle(ctx, core.ArticleInput{
		ActorUserID: adminID, AccountID: accountID, Title: "환불", Slug: "refund", Body: "7일 이내", Published: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	old, err := svc.CreateArticle(ctx, core.ArticleInput{
		ActorUserID: adminID, AccountID: accountID, Title: "구모델", Slug: "old", Body: "영업일 2일", Published: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO embeddings (id, account_id, owner_type, owner_id, model, version, embedding)
		VALUES
		($1,$2,'article',$3,'text-embedding-3-small',1,$4::halfvec),
		($5,$2,'article',$6,'text-embedding-3-small',1,$7::halfvec),
		($8,$2,'article',$9,'old-model',1,$4::halfvec)`,
		mustV7(t), accountID, near.ID, unitHalfvec(0),
		mustV7(t), far.ID, unitHalfvec(1),
		mustV7(t), old.ID,
	); err != nil {
		t.Fatal(err)
	}

	tx, err := app.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, accountID.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL hnsw.ef_search = 40`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL hnsw.iterative_scan = relaxed_order`); err != nil {
		t.Fatal(err)
	}
	var id uuid.UUID
	var title string
	if err := tx.QueryRow(ctx, `
		SELECT a.id, a.title
		FROM embeddings e
		JOIN articles a ON a.id = e.owner_id AND a.account_id = e.account_id
		WHERE e.owner_type = 'article'
		  AND e.model = $1
		  AND e.version = $2
		  AND a.published
		ORDER BY e.embedding <=> $3::halfvec
		LIMIT 1`,
		"text-embedding-3-small", 1, unitHalfvec(0),
	).Scan(&id, &title); err != nil {
		t.Fatal(err)
	}
	if id != near.ID || title != "배송" {
		t.Fatalf("got %s %s want %s 배송", id, title, near.ID)
	}
}

func unitHalfvec(on int) string {
	parts := make([]string, 1536)
	for i := range parts {
		parts[i] = "0"
	}
	if on >= 0 && on < len(parts) {
		parts[on] = "1"
	}
	return "[" + strings.Join(parts, ",") + "]"
}
