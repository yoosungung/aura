package ingest

import (
	"context"
	"errors"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

const (
	batchSize = 500
	batchWait = 100 * time.Millisecond
)

func DrainOnce(ctx context.Context, cons jetstream.Consumer, f *Flusher) error {
	msgs, err := cons.Fetch(batchSize, jetstream.FetchMaxWait(batchWait))
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return err
	}
	var items []Ackable
	for msg := range msgs.Messages() {
		m := msg
		data := append([]byte(nil), m.Data()...)
		items = append(items, Ackable{
			Data: data,
			Ack:  func(context.Context) error { return m.Ack() },
		})
	}
	if err := msgs.Error(); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if len(items) == 0 {
		return nil
	}
	return f.Flush(ctx, items)
}

func Run(ctx context.Context, js jetstream.JetStream, db DB) error {
	cons, err := EnsureStreams(ctx, js)
	if err != nil {
		return err
	}
	f := &Flusher{DB: db, JS: js}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := DrainOnce(ctx, cons, f); err != nil {
			if errors.Is(err, context.Canceled) {
				return err
			}
			return err
		}
	}
}
