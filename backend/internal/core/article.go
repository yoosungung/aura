package core

import (
	"context"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/ingest"
)

type ArticleInput struct {
	ActorUserID uuid.UUID
	AccountID   uuid.UUID
	ArticleID   uuid.UUID
	Title       string
	Slug        string
	Body        string
	Published   bool
}

type Article struct {
	ID        uuid.UUID
	Title     string
	Slug      string
	Body      string
	Published bool
}

func (s *Service) CreateArticle(ctx context.Context, in ArticleInput) (Article, error) {
	title := strings.TrimSpace(in.Title)
	slug := strings.TrimSpace(in.Slug)
	body := strings.TrimSpace(in.Body)
	if title == "" || slug == "" || body == "" || utf8.RuneCountInString(title) > 255 || utf8.RuneCountInString(slug) > 255 {
		return Article{}, ErrInvalid
	}
	var out Article
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		id, err := uuid.NewV7()
		if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `
			INSERT INTO articles (id, account_id, title, slug, body, published)
			VALUES ($1,$2,$3,$4,$5,$6)
			RETURNING id, title, slug, body, published`,
			id, in.AccountID, title, slug, body, in.Published,
		).Scan(&out.ID, &out.Title, &out.Slug, &out.Body, &out.Published)
		if isUniqueViolation(err) {
			return ErrConflict
		}
		return err
	})
	if err == nil {
		s.publishArticleEmbed(ctx, in.AccountID, out.ID)
	}
	return out, err
}

func (s *Service) ListArticles(ctx context.Context, in ArticleInput) ([]Article, error) {
	var out []Article
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, `SELECT id, title, slug, body, published FROM articles ORDER BY title`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var a Article
			if err := rows.Scan(&a.ID, &a.Title, &a.Slug, &a.Body, &a.Published); err != nil {
				return err
			}
			out = append(out, a)
		}
		return rows.Err()
	})
	if out == nil {
		out = []Article{}
	}
	return out, err
}

func (s *Service) UpdateArticle(ctx context.Context, in ArticleInput) (Article, error) {
	if in.ArticleID == uuid.Nil {
		return Article{}, ErrNotFound
	}
	title := strings.TrimSpace(in.Title)
	slug := strings.TrimSpace(in.Slug)
	body := strings.TrimSpace(in.Body)
	if title == "" || slug == "" || body == "" || utf8.RuneCountInString(title) > 255 || utf8.RuneCountInString(slug) > 255 {
		return Article{}, ErrInvalid
	}
	var out Article
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		err := tx.QueryRow(ctx, `
			UPDATE articles SET title = $2, slug = $3, body = $4, published = $5
			WHERE id = $1
			RETURNING id, title, slug, body, published`,
			in.ArticleID, title, slug, body, in.Published,
		).Scan(&out.ID, &out.Title, &out.Slug, &out.Body, &out.Published)
		if err == pgx.ErrNoRows {
			return ErrNotFound
		}
		if isUniqueViolation(err) {
			return ErrConflict
		}
		return err
	})
	if err == nil {
		s.publishArticleEmbed(ctx, in.AccountID, out.ID)
	}
	return out, err
}

func (s *Service) DeleteArticle(ctx context.Context, in ArticleInput) error {
	if in.ArticleID == uuid.Nil {
		return ErrNotFound
	}
	return s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		_, err := tx.Exec(ctx, `DELETE FROM embeddings WHERE owner_type = 'article' AND owner_id = $1`, in.ArticleID)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM articles WHERE id = $1`, in.ArticleID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func (s *Service) SearchArticles(ctx context.Context, inboxID uuid.UUID, query string) ([]Article, error) {
	if inboxID == uuid.Nil {
		return nil, ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT id, title, slug, body FROM public_articles_search($1, $2)`, inboxID, strings.TrimSpace(query))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Article
	for rows.Next() {
		var a Article
		if err := rows.Scan(&a.ID, &a.Title, &a.Slug, &a.Body); err != nil {
			return nil, err
		}
		a.Published = true
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if out == nil {
		out = []Article{}
	}
	return out, nil
}

func (s *Service) publishArticleEmbed(ctx context.Context, accountID, articleID uuid.UUID) {
	if s.JS == nil || articleID == uuid.Nil {
		return
	}
	body, err := json.Marshal(map[string]any{
		"account_id": accountID.String(), "owner_type": "article", "owner_id": articleID.String(),
	})
	if err != nil {
		return
	}
	_, _ = s.JS.Publish(ctx, ingest.AIEmbedSubject, body)
}
