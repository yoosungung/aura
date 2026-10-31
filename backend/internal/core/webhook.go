package core

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/contracts"
	"github.com/yoosungung/aura/internal/ingest"
)

var (
	ErrWebhookRetry = errors.New("webhook_retry")
	webhookHTTP     = &http.Client{Timeout: 10 * time.Second}
)

type WebhookInput struct {
	ActorUserID   uuid.UUID
	AccountID     uuid.UUID
	WebhookID     uuid.UUID
	URL           string
	Subscriptions []string
}

type Webhook struct {
	ID            uuid.UUID
	URL           string
	Subscriptions []string
	Secret        string
}

type DeliverInput struct {
	WebhookID uuid.UUID
	AccountID uuid.UUID
	Event     contracts.MessageCreated
}

func (s *Service) CreateWebhook(ctx context.Context, in WebhookInput) (Webhook, error) {
	rawURL := strings.TrimSpace(in.URL)
	if err := validWebhookURL(rawURL); err != nil {
		return Webhook{}, err
	}
	subs := in.Subscriptions
	if len(subs) == 0 {
		subs = []string{"message_created"}
	}
	secret, err := randomHex(32)
	if err != nil {
		return Webhook{}, err
	}
	var out Webhook
	err = s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		id, err := uuid.NewV7()
		if err != nil {
			return err
		}
		return tx.QueryRow(ctx, `
			INSERT INTO webhooks (id, account_id, url, subscriptions, secret)
			VALUES ($1,$2,$3,$4,$5)
			RETURNING id, url, subscriptions, secret`,
			id, in.AccountID, rawURL, subs, secret,
		).Scan(&out.ID, &out.URL, &out.Subscriptions, &out.Secret)
	})
	return out, err
}

func (s *Service) ListWebhooks(ctx context.Context, in WebhookInput) ([]Webhook, error) {
	var out []Webhook
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, `SELECT id, url, subscriptions, secret FROM webhooks ORDER BY url`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var w Webhook
			if err := rows.Scan(&w.ID, &w.URL, &w.Subscriptions, &w.Secret); err != nil {
				return err
			}
			out = append(out, w)
		}
		return rows.Err()
	})
	if out == nil {
		out = []Webhook{}
	}
	return out, err
}

func (s *Service) UpdateWebhook(ctx context.Context, in WebhookInput) (Webhook, error) {
	if in.WebhookID == uuid.Nil {
		return Webhook{}, ErrNotFound
	}
	rawURL := strings.TrimSpace(in.URL)
	if err := validWebhookURL(rawURL); err != nil {
		return Webhook{}, err
	}
	subs := in.Subscriptions
	if len(subs) == 0 {
		subs = []string{"message_created"}
	}
	var out Webhook
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		err := tx.QueryRow(ctx, `
			UPDATE webhooks SET url = $2, subscriptions = $3
			WHERE id = $1
			RETURNING id, url, subscriptions, secret`,
			in.WebhookID, rawURL, subs,
		).Scan(&out.ID, &out.URL, &out.Subscriptions, &out.Secret)
		if err == pgx.ErrNoRows {
			return ErrNotFound
		}
		return err
	})
	return out, err
}

func (s *Service) DeleteWebhook(ctx context.Context, in WebhookInput) error {
	if in.WebhookID == uuid.Nil {
		return ErrNotFound
	}
	return s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		tag, err := tx.Exec(ctx, `DELETE FROM webhooks WHERE id = $1`, in.WebhookID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func (s *Service) FanoutWebhooks(ctx context.Context, env contracts.MessageCreated) error {
	if s.JS == nil || env.Type != "message_created" {
		return nil
	}
	accountID, err := uuid.Parse(env.AccountID)
	if err != nil {
		return nil
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, accountID.String()); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
		SELECT id FROM webhooks WHERE $1 = ANY(subscriptions)`, env.Type)
	if err != nil {
		return err
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for _, id := range ids {
		body, err := json.Marshal(map[string]any{
			"webhook_id": id.String(),
			"account_id": accountID.String(),
			"event":      env,
		})
		if err != nil {
			return err
		}
		if _, err := s.JS.Publish(ctx, ingest.WebhookDeliverSubject, body); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) DeliverWebhook(ctx context.Context, in DeliverInput) error {
	if in.WebhookID == uuid.Nil || in.AccountID == uuid.Nil {
		return ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return err
	}
	var hook Webhook
	err = tx.QueryRow(ctx, `SELECT id, url, subscriptions, secret FROM webhooks WHERE id = $1`, in.WebhookID).
		Scan(&hook.ID, &hook.URL, &hook.Subscriptions, &hook.Secret)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil
		}
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	body, err := json.Marshal(publicWebhook(in.Event))
	if err != nil {
		return err
	}
	ts := strconv.FormatInt(time.Now().UTC().Unix(), 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hook.URL, bytes.NewReader(body))
	if err != nil {
		return ErrWebhookRetry
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Helpdesk-Timestamp", ts)
	req.Header.Set("X-Helpdesk-Signature", signWebhook(hook.Secret, ts, body))
	res, err := s.httpClient().Do(req)
	if err != nil {
		return ErrWebhookRetry
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode >= 500 || res.StatusCode == http.StatusTooManyRequests {
		return ErrWebhookRetry
	}
	if res.StatusCode >= 400 {
		return nil
	}
	return nil
}

func (s *Service) consumeWebhookEvents(ctx context.Context) (jetstream.ConsumeContext, error) {
	if s.JS == nil {
		return noopConsume{}, nil
	}
	cons, err := s.JS.CreateOrUpdateConsumer(ctx, ingest.ConversationsStream, jetstream.ConsumerConfig{
		Durable:       ingest.WebhookFanoutConsumer,
		FilterSubject: ingest.EventsFilter,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	})
	if err != nil {
		return nil, err
	}
	return cons.Consume(func(msg jetstream.Msg) {
		env, err := ingest.Parse(msg.Data())
		if err != nil {
			_ = msg.Ack()
			return
		}
		if err := s.FanoutWebhooks(context.Background(), env); err != nil {
			_ = msg.Nak()
			return
		}
		_ = msg.Ack()
	})
}

func (s *Service) consumeWebhookDeliveries(ctx context.Context) (jetstream.ConsumeContext, error) {
	if s.JS == nil {
		return noopConsume{}, nil
	}
	cons, err := s.JS.CreateOrUpdateConsumer(ctx, ingest.TasksStream, jetstream.ConsumerConfig{
		Durable:       ingest.WebhookDeliverConsumer,
		FilterSubject: ingest.WebhookDeliverFilter,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxDeliver:    5,
		MaxAckPending: 1000,
	})
	if err != nil {
		return nil, err
	}
	return cons.Consume(func(msg jetstream.Msg) {
		var req struct {
			WebhookID string                   `json:"webhook_id"`
			AccountID string                   `json:"account_id"`
			Event     contracts.MessageCreated `json:"event"`
		}
		if err := json.Unmarshal(msg.Data(), &req); err != nil {
			_ = msg.Ack()
			return
		}
		webhookID, err1 := uuid.Parse(req.WebhookID)
		accountID, err2 := uuid.Parse(req.AccountID)
		if err1 != nil || err2 != nil {
			_ = msg.Ack()
			return
		}
		err := s.DeliverWebhook(context.Background(), DeliverInput{
			WebhookID: webhookID, AccountID: accountID, Event: req.Event,
		})
		if errors.Is(err, ErrWebhookRetry) {
			_ = msg.NakWithDelay(2 * time.Second)
			return
		}
		_ = msg.Ack()
	})
}

func (s *Service) httpClient() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return webhookHTTP
}

func publicWebhook(env contracts.MessageCreated) map[string]any {
	event := env.Type
	if event == "" {
		event = "message_created"
	}
	return map[string]any{
		"id":              env.ID,
		"event":           event,
		"occurred_at":     env.OccurredAt,
		"account_id":      env.AccountID,
		"inbox_id":        env.InboxID,
		"conversation_id": env.ConversationID,
		"trace_id":        env.TraceID,
		"payload":         env.Payload,
	}
}

func signWebhook(secret, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp))
	_, _ = mac.Write([]byte("."))
	_, _ = mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func validWebhookURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ErrInvalid
	}
	return nil
}

func encodeWebhook(w Webhook) map[string]any {
	return map[string]any{
		"id": w.ID.String(), "url": w.URL, "subscriptions": w.Subscriptions, "secret": w.Secret,
	}
}

func webhookJSON(w Webhook) []byte {
	body, _ := json.Marshal(map[string]any{"ok": true, "webhook": encodeWebhook(w)})
	return body
}
