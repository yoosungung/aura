package archive

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/ingest"
)

var ErrNotFound = errors.New("not found")

type Store interface {
	Append(ctx context.Context, key string, line []byte) error
}

type Worker struct {
	JS    jetstream.JetStream
	Store Store
	mu    sync.Mutex
}

func (w *Worker) Consume(ctx context.Context) error {
	if w.JS == nil || w.Store == nil {
		<-ctx.Done()
		return ctx.Err()
	}
	cons, err := w.JS.CreateOrUpdateConsumer(ctx, ingest.ConversationsStream, jetstream.ConsumerConfig{
		Durable:       ingest.EventArchiveConsumer,
		FilterSubject: "helpdesk.events.>",
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	})
	if err != nil {
		return err
	}
	cc, err := cons.Consume(func(msg jetstream.Msg) {
		w.handle(msg)
	})
	if err != nil {
		return err
	}
	defer cc.Stop()
	<-ctx.Done()
	return ctx.Err()
}

func (w *Worker) Archive(ctx context.Context, raw []byte) error {
	env, err := ingest.Parse(raw)
	if err != nil {
		return err
	}
	occurred, err := time.Parse(time.RFC3339Nano, env.OccurredAt)
	if err != nil {
		occurred, err = time.Parse(time.RFC3339, env.OccurredAt)
		if err != nil {
			occurred = time.Now().UTC()
		}
	}
	day := occurred.UTC().Format("2006-01-02")
	key := fmt.Sprintf("archive/%s/%s/%s.jsonl", env.AccountID, env.ConversationID, day)
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.Store.Append(ctx, key, raw)
}

func (w *Worker) handle(msg jetstream.Msg) {
	if err := w.Archive(context.Background(), msg.Data()); err != nil {
		_ = msg.Nak()
		return
	}
	_ = msg.Ack()
}

type MemoryStore struct {
	Items map[string][]byte
}

func (m *MemoryStore) Append(_ context.Context, key string, line []byte) error {
	if m.Items == nil {
		m.Items = map[string][]byte{}
	}
	m.Items[key] = append(m.Items[key], withNewline(line)...)
	return nil
}

type FilerStore struct {
	GetFn func(ctx context.Context, key string) ([]byte, error)
	PutFn func(ctx context.Context, key string, body []byte) error
}

func (f FilerStore) Append(ctx context.Context, key string, line []byte) error {
	if f.PutFn == nil {
		return fmt.Errorf("filer missing")
	}
	var existing []byte
	if f.GetFn != nil {
		got, err := f.GetFn(ctx, key)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		if err == nil {
			existing = got
		}
	}
	return f.PutFn(ctx, key, append(existing, withNewline(line)...))
}

func withNewline(line []byte) []byte {
	if len(line) == 0 {
		return nil
	}
	out := append([]byte(nil), line...)
	if out[len(out)-1] != '\n' {
		out = append(out, '\n')
	}
	return out
}
