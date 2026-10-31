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

type LabelInput struct {
	ActorUserID    uuid.UUID
	AccountID      uuid.UUID
	ConversationID uuid.UUID
	Name           string
	LabelID        uuid.UUID
}

type Label struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Color string    `json:"color"`
}

func (s *Service) AddConversationLabel(ctx context.Context, in LabelInput) (Label, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 255 {
		return Label{}, ErrInvalid
	}
	var out Label
	err := s.withLabelConversation(ctx, in, func(tx pgx.Tx, role string) error {
		err := tx.QueryRow(ctx, `
			SELECT id, name, COALESCE(color, '') FROM labels WHERE account_id = $1 AND name = $2`,
			in.AccountID, name,
		).Scan(&out.ID, &out.Name, &out.Color)
		if err == pgx.ErrNoRows {
			if role != "administrator" {
				return ErrNotFound
			}
			created, err := insertAccountLabel(ctx, tx, in.AccountID, name)
			if err != nil {
				return err
			}
			out = created
		} else if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO conversation_labels (account_id, conversation_id, label_id)
			VALUES ($1,$2,$3)
			ON CONFLICT (conversation_id, label_id) DO NOTHING`,
			in.AccountID, in.ConversationID, out.ID)
		return err
	})
	return out, err
}

func (s *Service) RemoveConversationLabel(ctx context.Context, in LabelInput) error {
	if in.LabelID == uuid.Nil {
		return ErrNotFound
	}
	return s.withLabelConversation(ctx, in, func(tx pgx.Tx, _ string) error {
		_, err := tx.Exec(ctx, `
			DELETE FROM conversation_labels
			WHERE account_id = $1 AND conversation_id = $2 AND label_id = $3`,
			in.AccountID, in.ConversationID, in.LabelID)
		return err
	})
}

func (s *Service) ListConversationLabels(ctx context.Context, in LabelInput) ([]Label, error) {
	var out []Label
	err := s.withLabelConversation(ctx, in, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, `
			SELECT l.id, l.name, COALESCE(l.color, '')
			FROM conversation_labels cl
			JOIN labels l ON l.id = cl.label_id
			WHERE cl.account_id = $1 AND cl.conversation_id = $2
			ORDER BY l.name`,
			in.AccountID, in.ConversationID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var l Label
			if err := rows.Scan(&l.ID, &l.Name, &l.Color); err != nil {
				return err
			}
			out = append(out, l)
		}
		return rows.Err()
	})
	if out == nil {
		out = []Label{}
	}
	return out, err
}

func (s *Service) CreateAccountLabel(ctx context.Context, in LabelInput) (Label, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 255 {
		return Label{}, ErrInvalid
	}
	var out Label
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		created, err := insertAccountLabel(ctx, tx, in.AccountID, name)
		out = created
		return err
	})
	return out, err
}

func (s *Service) ListAccountLabels(ctx context.Context, in LabelInput) ([]Label, error) {
	var out []Label
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, false, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, `
			SELECT id, name, COALESCE(color, '') FROM labels WHERE account_id = $1 ORDER BY name`, in.AccountID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var l Label
			if err := rows.Scan(&l.ID, &l.Name, &l.Color); err != nil {
				return err
			}
			out = append(out, l)
		}
		return rows.Err()
	})
	if out == nil {
		out = []Label{}
	}
	return out, err
}

func (s *Service) UpdateAccountLabel(ctx context.Context, in LabelInput) (Label, error) {
	name := strings.TrimSpace(in.Name)
	if in.LabelID == uuid.Nil {
		return Label{}, ErrNotFound
	}
	if name == "" || utf8.RuneCountInString(name) > 255 {
		return Label{}, ErrInvalid
	}
	var out Label
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		err := tx.QueryRow(ctx, `
			UPDATE labels SET name = $2 WHERE id = $1
			RETURNING id, name, COALESCE(color, '')`,
			in.LabelID, name,
		).Scan(&out.ID, &out.Name, &out.Color)
		if err == pgx.ErrNoRows {
			return ErrNotFound
		}
		if isUniqueViolation(err) {
			return ErrConflict
		}
		return err
	})
	return out, err
}

func (s *Service) DeleteAccountLabel(ctx context.Context, in LabelInput) error {
	if in.LabelID == uuid.Nil {
		return ErrNotFound
	}
	return s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		tag, err := tx.Exec(ctx, `DELETE FROM labels WHERE id = $1`, in.LabelID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func insertAccountLabel(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, name string) (Label, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return Label{}, err
	}
	var out Label
	err = tx.QueryRow(ctx, `
		INSERT INTO labels (id, account_id, name)
		VALUES ($1,$2,$3)
		ON CONFLICT (account_id, name) DO UPDATE SET name = EXCLUDED.name
		RETURNING id, name, COALESCE(color, '')`,
		id, accountID, name,
	).Scan(&out.ID, &out.Name, &out.Color)
	return out, err
}

func (s *Service) withLabelConversation(ctx context.Context, in LabelInput, fn func(pgx.Tx, string) error) error {
	if in.ActorUserID == uuid.Nil || in.AccountID == uuid.Nil || in.ConversationID == uuid.Nil {
		return ErrNotFound
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return err
	}
	var inboxID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT inbox_id FROM conversations WHERE id = $1`, in.ConversationID).Scan(&inboxID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return ErrNotFound
		}
		return err
	}
	role, err := accountRole(ctx, tx, in.AccountID, in.ActorUserID)
	if err != nil {
		return err
	}
	if err := requireAssignActor(ctx, tx, in.AccountID, inboxID, in.ActorUserID); err != nil {
		return err
	}
	if err := fn(tx, role); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) withAccountMember(ctx context.Context, actor, account uuid.UUID, adminOnly bool, fn func(pgx.Tx, string) error) error {
	if actor == uuid.Nil || account == uuid.Nil {
		return ErrDenied
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, account.String()); err != nil {
		return err
	}
	role, err := accountRole(ctx, tx, account, actor)
	if err != nil {
		return err
	}
	if adminOnly && role != "administrator" {
		return ErrDenied
	}
	if err := fn(tx, role); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func accountRole(ctx context.Context, tx pgx.Tx, accountID, actor uuid.UUID) (string, error) {
	var role string
	err := tx.QueryRow(ctx, `
		SELECT role FROM account_users WHERE account_id = $1 AND user_id = $2`, accountID, actor,
	).Scan(&role)
	if err == pgx.ErrNoRows {
		return "", ErrDenied
	}
	return role, err
}

func (s *Service) handleLabelAdd(msg *nats.Msg) {
	in, err := parseLabelInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.AddConversationLabel(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "id": out.ID.String(), "name": out.Name, "color": out.Color,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleLabelRemove(msg *nats.Msg) {
	in, err := parseLabelInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.RemoveConversationLabel(context.Background(), in); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func (s *Service) handleLabelList(msg *nats.Msg) {
	in, err := parseLabelInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListConversationLabels(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, l := range list {
		rows = append(rows, map[string]any{"id": l.ID.String(), "name": l.Name, "color": l.Color})
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "labels": rows})
	_ = msg.Respond(body)
}

func (s *Service) handleLabelCatalogList(msg *nats.Msg) {
	in, err := parseLabelInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListAccountLabels(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, l := range list {
		rows = append(rows, map[string]any{"id": l.ID.String(), "name": l.Name, "color": l.Color})
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "labels": rows})
	_ = msg.Respond(body)
}

func (s *Service) handleLabelCatalogCreate(msg *nats.Msg) {
	in, err := parseLabelInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.CreateAccountLabel(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "id": out.ID.String(), "name": out.Name, "color": out.Color,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleLabelCatalogUpdate(msg *nats.Msg) {
	in, err := parseLabelInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.UpdateAccountLabel(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "id": out.ID.String(), "name": out.Name, "color": out.Color,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleLabelCatalogDelete(msg *nats.Msg) {
	in, err := parseLabelInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.DeleteAccountLabel(context.Background(), in); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func parseLabelInput(msg *nats.Msg) (LabelInput, error) {
	var req struct {
		ActorUserID    string `json:"actor_user_id"`
		AccountID      string `json:"account_id"`
		ConversationID string `json:"conversation_id"`
		Name           string `json:"name"`
		LabelID        string `json:"label_id"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return LabelInput{}, err
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		return LabelInput{}, err
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return LabelInput{}, err
	}
	in := LabelInput{ActorUserID: actor, AccountID: accountID, Name: req.Name}
	if req.ConversationID != "" {
		convID, err := uuid.Parse(req.ConversationID)
		if err != nil {
			return LabelInput{}, err
		}
		in.ConversationID = convID
	}
	if req.LabelID != "" {
		id, err := uuid.Parse(req.LabelID)
		if err != nil {
			return LabelInput{}, err
		}
		in.LabelID = id
	}
	return in, nil
}
