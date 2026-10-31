package core

import (
	"context"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go"
)

type CannedInput struct {
	ActorUserID uuid.UUID
	AccountID   uuid.UUID
	CannedID    uuid.UUID
	ShortCode   string
	Content     string
}

type CannedResponse struct {
	ID        uuid.UUID
	ShortCode string
	Content   string
}

func (s *Service) CreateCanned(ctx context.Context, in CannedInput) (CannedResponse, error) {
	code := strings.TrimSpace(in.ShortCode)
	content := strings.TrimSpace(in.Content)
	if code == "" || content == "" || utf8.RuneCountInString(code) > 50 || strings.ContainsAny(code, " \t\n/") {
		return CannedResponse{}, ErrInvalid
	}
	var out CannedResponse
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		id, err := uuid.NewV7()
		if err != nil {
			return err
		}
		return tx.QueryRow(ctx, `
			INSERT INTO canned_responses (id, account_id, short_code, content)
			VALUES ($1,$2,$3,$4)
			RETURNING id, short_code, content`,
			id, in.AccountID, code, content,
		).Scan(&out.ID, &out.ShortCode, &out.Content)
	})
	if isUniqueViolation(err) {
		return CannedResponse{}, ErrConflict
	}
	return out, err
}

func (s *Service) ListCanned(ctx context.Context, in CannedInput) ([]CannedResponse, error) {
	var out []CannedResponse
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, false, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, `
			SELECT id, short_code, content FROM canned_responses WHERE account_id = $1 ORDER BY short_code`,
			in.AccountID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row CannedResponse
			if err := rows.Scan(&row.ID, &row.ShortCode, &row.Content); err != nil {
				return err
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if out == nil {
		out = []CannedResponse{}
	}
	return out, err
}

func (s *Service) DeleteCanned(ctx context.Context, in CannedInput) error {
	if in.CannedID == uuid.Nil {
		return ErrNotFound
	}
	return s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		tag, err := tx.Exec(ctx, `DELETE FROM canned_responses WHERE id = $1`, in.CannedID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func (s *Service) handleCannedCreate(msg *nats.Msg) {
	in, err := parseCannedInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.CreateCanned(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "id": out.ID.String(), "short_code": out.ShortCode, "content": out.Content,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleCannedList(msg *nats.Msg) {
	in, err := parseCannedInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListCanned(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, c := range list {
		rows = append(rows, map[string]any{
			"id": c.ID.String(), "short_code": c.ShortCode, "content": c.Content,
		})
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "canned_responses": rows})
	_ = msg.Respond(body)
}

func (s *Service) handleCannedDelete(msg *nats.Msg) {
	in, err := parseCannedInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.DeleteCanned(context.Background(), in); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func parseCannedInput(msg *nats.Msg) (CannedInput, error) {
	var req struct {
		ActorUserID string `json:"actor_user_id"`
		AccountID   string `json:"account_id"`
		CannedID    string `json:"canned_id"`
		ShortCode   string `json:"short_code"`
		Content     string `json:"content"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return CannedInput{}, err
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		return CannedInput{}, err
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return CannedInput{}, err
	}
	return CannedInput{
		ActorUserID: actor, AccountID: accountID, CannedID: parseUUID(req.CannedID),
		ShortCode: req.ShortCode, Content: req.Content,
	}, nil
}
