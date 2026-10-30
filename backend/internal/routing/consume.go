package routing

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/ingest"
)

func (s *Service) Consume(ctx context.Context, js jetstream.JetStream) error {
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		return err
	}
	cons, err := js.CreateOrUpdateConsumer(ctx, ingest.ConversationsStream, jetstream.ConsumerConfig{
		Durable:       ingest.SLARoutingConsumer,
		FilterSubject: ingest.EventsFilter,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	})
	if err != nil {
		return err
	}
	cc, err := cons.Consume(func(msg jetstream.Msg) {
		s.handle(msg)
	})
	if err != nil {
		return err
	}
	defer cc.Stop()
	<-ctx.Done()
	return ctx.Err()
}

func (s *Service) handle(msg jetstream.Msg) {
	env, err := ingest.Parse(msg.Data())
	if err != nil || env.Type != "message_created" {
		_ = msg.Ack()
		return
	}
	accountID, err := uuid.Parse(env.AccountID)
	if err != nil {
		_ = msg.Ack()
		return
	}
	inboxID, err := uuid.Parse(env.InboxID)
	if err != nil {
		_ = msg.Ack()
		return
	}
	conversationID, err := uuid.Parse(env.ConversationID)
	if err != nil {
		_ = msg.Ack()
		return
	}
	if err := s.Route(context.Background(), accountID, inboxID, conversationID, env.TraceID); err != nil {
		_ = msg.Nak()
		return
	}
	_ = msg.Ack()
}
