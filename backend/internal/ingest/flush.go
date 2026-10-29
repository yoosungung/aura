package ingest

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go/jetstream"
)

type Ackable struct {
	Data []byte
	Ack  func(context.Context) error
}

type DB interface {
	Begin(context.Context) (pgx.Tx, error)
}

type Flusher struct {
	DB DB
	JS jetstream.JetStream
}

func (f *Flusher) Flush(ctx context.Context, items []Ackable) error {
	if len(items) == 0 {
		return nil
	}
	byAccount := map[string][]Ackable{}
	for _, it := range items {
		env, err := Parse(it.Data)
		if err != nil {
			if err := f.deadLetter(ctx, it.Data, err); err != nil {
				return err
			}
			if err := it.Ack(ctx); err != nil {
				return err
			}
			continue
		}
		key := env.AccountID
		byAccount[key] = append(byAccount[key], it)
	}
	for _, group := range byAccount {
		if err := f.flushAccount(ctx, group); err != nil {
			return err
		}
	}
	return nil
}

func (f *Flusher) flushAccount(ctx context.Context, items []Ackable) error {
	tx, err := f.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := applyAll(ctx, tx, items); err != nil {
		_ = tx.Rollback(ctx)
		return f.flushOneByOne(ctx, items)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for _, it := range items {
		if err := it.Ack(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (f *Flusher) flushOneByOne(ctx context.Context, items []Ackable) error {
	for _, it := range items {
		tx, err := f.DB.Begin(ctx)
		if err != nil {
			return err
		}
		if err := applyAll(ctx, tx, []Ackable{it}); err != nil {
			_ = tx.Rollback(ctx)
			if dlqErr := f.deadLetter(ctx, it.Data, err); dlqErr != nil {
				return dlqErr
			}
			if err := it.Ack(ctx); err != nil {
				return err
			}
			continue
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		if err := it.Ack(ctx); err != nil {
			return err
		}
	}
	return nil
}

func applyAll(ctx context.Context, tx pgx.Tx, items []Ackable) error {
	if len(items) == 0 {
		return nil
	}
	env, err := Parse(items[0].Data)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, env.AccountID); err != nil {
		return err
	}
	for _, it := range items {
		if err := insertMessage(ctx, tx, it.Data); err != nil {
			return err
		}
	}
	return nil
}

func insertMessage(ctx context.Context, tx pgx.Tx, raw []byte) error {
	env, err := Parse(raw)
	if err != nil {
		return err
	}
	msg, err := MessagePayload(env)
	if err != nil {
		return err
	}
	var source any
	if msg.SourceID != "" {
		source = msg.SourceID
	}
	occurred, err := parseOccurred(env.OccurredAt)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO messages (
			id, account_id, inbox_id, conversation_id,
			message_type, content, private, status, source_id,
			content_type, sender_type, sender_id, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
		ON CONFLICT (id) DO NOTHING
	`, env.ID, env.AccountID, env.InboxID, env.ConversationID,
		msg.MessageType, msg.Content, msg.Private, msg.Status, source,
		msg.ContentType, msg.SenderType, msg.SenderID, occurred)
	return err
}

func (f *Flusher) deadLetter(ctx context.Context, raw []byte, cause error) error {
	body, err := json.Marshal(map[string]any{
		"error": cause.Error(),
		"raw":   json.RawMessage(raw),
	})
	if err != nil {
		body, _ = json.Marshal(map[string]string{"error": cause.Error(), "raw": string(raw)})
	}
	_, err = f.JS.Publish(ctx, "helpdesk.dlq.ingestion", body)
	if err != nil {
		return fmt.Errorf("dlq publish: %w", err)
	}
	return nil
}
