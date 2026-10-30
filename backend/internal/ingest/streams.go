package ingest

import (
	"context"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

const (
	ConversationsStream     = "CONVERSATIONS_STREAM"
	TasksStream             = "TASKS_STREAM"
	IngestionDLQ            = "INGESTION_DLQ"
	ConsumerName            = "ingestion"
	SnoozeWakeConsumer      = "svc-core-snooze"
	OutboundEmailConsumer   = "gateway-email-outbound"
	OutboundKakaoConsumer   = "gateway-kakao-outbound"
	SLARoutingConsumer      = "sla-routing"
	AutomationConsumer      = "svc-automation"
	WebhookFanoutConsumer   = "svc-core-webhook-fanout"
	WebhookDeliverConsumer  = "svc-core-webhooks"
	AIReasoningConsumer     = "svc-ai-reasoning"
	AIExecuteConsumer       = "svc-ai-execute"
	AIEmbedConsumer         = "svc-ai-embed"
	OntologyExtractConsumer = "svc-ai-ontology"
	EventArchiveConsumer    = "event-archive"
	EventsFilter            = "helpdesk.events.*.*.*.message_created"
	CsatSubmittedFilter     = "helpdesk.events.*.*.*.csat_submitted"
	ToolExecutionFilter     = "helpdesk.events.*.*.*.tool_execution"
	OntologyExtractedFilter = "helpdesk.events.*.*.*.ontology_extracted"
	EmbeddingUpsertFilter   = "helpdesk.events.*.*.*.embedding_upsert"
	SnoozeWakeFilter        = "helpdesk.tasks.snooze.wake.*"
	AIReasoningSubject      = "helpdesk.tasks.ai.reasoning"
	AIExecuteSubject        = "helpdesk.tasks.ai.execute"
	AIEmbedSubject          = "helpdesk.tasks.ai.embed"
	OntologyExtractSubject  = "helpdesk.tasks.ontology.extract"
	WebhookDeliverSubject   = "helpdesk.tasks.webhooks.deliver"
	WebhookDeliverFilter    = "helpdesk.tasks.webhooks.deliver"
	DLQSubject              = "helpdesk.dlq.ingestion"
)

func OntologyExtractConsumerConfig() jetstream.ConsumerConfig {
	return jetstream.ConsumerConfig{
		Durable:       OntologyExtractConsumer,
		FilterSubject: OntologyExtractSubject,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	}
}

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
	if _, err := js.CreateOrUpdateConsumer(ctx, ConversationsStream, jetstream.ConsumerConfig{
		Durable:       SLARoutingConsumer,
		FilterSubject: EventsFilter,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	}); err != nil {
		return nil, err
	}
	if _, err := js.CreateOrUpdateConsumer(ctx, ConversationsStream, jetstream.ConsumerConfig{
		Durable:       AutomationConsumer,
		FilterSubject: EventsFilter,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	}); err != nil {
		return nil, err
	}
	if _, err := js.CreateOrUpdateConsumer(ctx, TasksStream, OntologyExtractConsumerConfig()); err != nil {
		return nil, err
	}
	if _, err := js.CreateOrUpdateConsumer(ctx, TasksStream, jetstream.ConsumerConfig{
		Durable:       AIReasoningConsumer,
		FilterSubject: AIReasoningSubject,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	}); err != nil {
		return nil, err
	}
	if _, err := js.CreateOrUpdateConsumer(ctx, TasksStream, jetstream.ConsumerConfig{
		Durable:       AIExecuteConsumer,
		FilterSubject: AIExecuteSubject,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	}); err != nil {
		return nil, err
	}
	if _, err := js.CreateOrUpdateConsumer(ctx, TasksStream, jetstream.ConsumerConfig{
		Durable:       AIEmbedConsumer,
		FilterSubject: AIEmbedSubject,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	}); err != nil {
		return nil, err
	}
	if _, err := js.CreateOrUpdateConsumer(ctx, ConversationsStream, jetstream.ConsumerConfig{
		Durable:       EventArchiveConsumer,
		FilterSubject: "helpdesk.events.>",
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	}); err != nil {
		return nil, err
	}
	return js.CreateOrUpdateConsumer(ctx, ConversationsStream, jetstream.ConsumerConfig{
		Durable:        ConsumerName,
		FilterSubjects: []string{EventsFilter, CsatSubmittedFilter, ToolExecutionFilter, OntologyExtractedFilter, EmbeddingUpsertFilter},
		AckPolicy:      jetstream.AckExplicitPolicy,
		AckWait:        30 * time.Second,
		MaxAckPending:  1000,
	})
}
