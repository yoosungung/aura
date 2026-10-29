// Code generated from contracts/*.schema.json; DO NOT EDIT.

package contracts

type ConversationsCreate struct {
	AccountID string `json:"account_id"`
	InboxID   string `json:"inbox_id"`
	SourceID  string `json:"source_id"`
	Name      string `json:"name,omitempty"`
	TraceID   string `json:"trace_id"`
}

type ConversationsTransition struct {
	AccountID       string `json:"account_id"`
	ConversationID  string `json:"conversation_id"`
	NewStatus       string `json:"new_status"`
	ExpectedVersion int    `json:"expected_version"`
	ActorType       string `json:"actor_type,omitempty"`
	ActorID         string `json:"actor_id,omitempty"`
	TraceID         string `json:"trace_id"`
}

type MessageCreatedPayload struct {
	Content        string `json:"content"`
	ContentRef     string `json:"content_ref,omitempty"`
	MessageType    int    `json:"message_type"`
	Private        bool   `json:"private"`
	Status         string `json:"status"`
	ContentType    string `json:"content_type"`
	SourceID       string `json:"source_id,omitempty"`
	SenderType     string `json:"sender_type"`
	SenderID       string `json:"sender_id"`
	ContactID      string `json:"contact_id"`
	ContactInboxID string `json:"contact_inbox_id"`
	Attachments    []any  `json:"attachments,omitempty"`
}

type MessageCreated struct {
	ID             string                `json:"id"`
	SchemaVersion  int                   `json:"schema_version"`
	Type           string                `json:"type"`
	OccurredAt     string                `json:"occurred_at"`
	AccountID      string                `json:"account_id"`
	InboxID        string                `json:"inbox_id"`
	ConversationID string                `json:"conversation_id"`
	TraceID        string                `json:"trace_id"`
	CausationID    string                `json:"causation_id,omitempty"`
	HopCount       int                   `json:"hop_count"`
	Payload        MessageCreatedPayload `json:"payload"`
}
