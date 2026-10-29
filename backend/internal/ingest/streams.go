package ingest

import (
	"context"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

const (
	ConversationsStream = "CONVERSATIONS_STREAM"
	TasksStream         = "TASKS_STREAM"
	IngestionDLQ        = "INGESTION_DLQ"
	ConsumerName        = "ingestion"
	SnoozeWakeConsumer  = "svc-core-snooze"
	EventsFilter        = "helpdesk.events.*.*.*.message_created"
	SnoozeWakeFilter    = "helpdesk.tasks.snooze.wake.*"
	DLQSubject          = "helpdesk.dlq.ingestion"
)

func EnsureStreams(ctx context.Context, js jetstream.JetStream) (jetstream.Consumer, error) {
	if _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:     ConversationsStream,
		Subjects: []string{"helpdesk.events.*.*.*.*"},
		Storage:  jetstream.FileStorage,
		MaxAge:   90 * 24 * time.Hour,
		Discard:  jetstream.DiscardOld,
	}); err != nil {
		return nil, err
	}
	if _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:              TasksStream,
		Subjects:          []string{"helpdesk.tasks.>"},
		Storage:           jetstream.FileStorage,
		Retention:         jetstream.WorkQueuePolicy,
		AllowMsgSchedules: true,
		MaxAge:            7 * 24 * time.Hour,
		Discard:           jetstream.DiscardOld,
	}); err != nil {
		return nil, err
	}
	if _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:     IngestionDLQ,
		Subjects: []string{DLQSubject},
		Storage:  jetstream.FileStorage,
		MaxAge:   30 * 24 * time.Hour,
		Discard:  jetstream.DiscardOld,
	}); err != nil {
		return nil, err
	}
	return js.CreateOrUpdateConsumer(ctx, ConversationsStream, jetstream.ConsumerConfig{
		Durable:       ConsumerName,
		FilterSubject: EventsFilter,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	})
}
