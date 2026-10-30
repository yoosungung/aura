package automation

import (
	"context"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/ingest"
)

func (s *Service) Consume(ctx context.Context, js jetstream.JetStream) error {
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		return err
	}
	cons, err := js.CreateOrUpdateConsumer(ctx, ingest.ConversationsStream, jetstream.ConsumerConfig{
		Durable:       ingest.AutomationConsumer,
		FilterSubject: ingest.EventsFilter,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	})
	if err != nil {
		return err
	}
	cc, err := cons.Consume(func(msg jetstream.Msg) {
		env, err := ingest.Parse(msg.Data())
		if err != nil {
			_ = msg.Ack()
			return
		}
		if err := s.Handle(context.Background(), env); err != nil {
			_ = msg.Nak()
			return
		}
		_ = msg.Ack()
	})
	if err != nil {
		return err
	}
	defer cc.Stop()
	<-ctx.Done()
	return ctx.Err()
}
