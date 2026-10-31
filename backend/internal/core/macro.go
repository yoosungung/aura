package core

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go"
)

const (
	MacroVisibilityAccount  = "account"
	MacroVisibilityPersonal = "personal"
	ActionSendMessage       = "send_message"
	ActionAddLabel          = "add_label"
	ActionAddPrivateNote    = "add_private_note"
	ActionAssignAgent       = "assign_agent"
	ActionSnooze            = "snooze_conversation"
	ActionResolve           = "resolve_conversation"
)

var macroActions = map[string]bool{
	ActionSendMessage:    true,
	ActionAddLabel:       true,
	ActionAddPrivateNote: true,
	ActionAssignAgent:    true,
	ActionSnooze:         true,
	ActionResolve:        true,
}

type MacroAction struct {
	ActionName   string   `json:"action_name"`
	ActionParams []string `json:"action_params"`
}

type MacroInput struct {
	ActorUserID    uuid.UUID
	AccountID      uuid.UUID
	ConversationID uuid.UUID
	MacroID        uuid.UUID
	Name           string
	Actions        []MacroAction
	Visibility     string
}

type Macro struct {
	ID         uuid.UUID
	Name       string
	Actions    []MacroAction
	Visibility string
	CreatedBy  uuid.UUID
}

type ExecuteResult struct {
	Status       string
	Version      int
	Labels       []Label
	Messages     []NoteResult
	SnoozedUntil *time.Time
	AssigneeID   uuid.UUID
}

func (s *Service) CreateMacro(ctx context.Context, in MacroInput) (Macro, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 255 || len(in.Actions) == 0 {
		return Macro{}, ErrInvalid
	}
	for _, a := range in.Actions {
		if !macroActions[a.ActionName] {
			return Macro{}, ErrInvalid
		}
	}
	var out Macro
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, false, func(tx pgx.Tx, role string) error {
		visibility := in.Visibility
		if role != "administrator" {
			visibility = MacroVisibilityPersonal
		} else if visibility == "" {
			visibility = MacroVisibilityAccount
		}
		if visibility != MacroVisibilityAccount && visibility != MacroVisibilityPersonal {
			return ErrInvalid
		}
		raw, err := json.Marshal(in.Actions)
		if err != nil {
			return err
		}
		id, err := uuid.NewV7()
		if err != nil {
			return err
		}
		var actions []byte
		if err := tx.QueryRow(ctx, `
			INSERT INTO macros (id, account_id, name, actions, visibility, created_by)
			VALUES ($1,$2,$3,$4::jsonb,$5,$6)
			RETURNING id, name, actions, visibility, created_by`,
			id, in.AccountID, name, string(raw), visibility, in.ActorUserID,
		).Scan(&out.ID, &out.Name, &actions, &out.Visibility, &out.CreatedBy); err != nil {
			return err
		}
		return json.Unmarshal(actions, &out.Actions)
	})
	return out, err
}

func (s *Service) ListMacros(ctx context.Context, in MacroInput) ([]Macro, error) {
	var out []Macro
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, false, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, `
			SELECT id, name, actions, visibility, COALESCE(created_by, '00000000-0000-0000-0000-000000000000')
			FROM macros
			WHERE account_id = $1 AND (visibility = $2 OR created_by = $3)
			ORDER BY name`,
			in.AccountID, MacroVisibilityAccount, in.ActorUserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var m Macro
			var raw []byte
			if err := rows.Scan(&m.ID, &m.Name, &raw, &m.Visibility, &m.CreatedBy); err != nil {
				return err
			}
			if err := json.Unmarshal(raw, &m.Actions); err != nil {
				return err
			}
			if m.Actions == nil {
				m.Actions = []MacroAction{}
			}
			out = append(out, m)
		}
		return rows.Err()
	})
	if out == nil {
		out = []Macro{}
	}
	return out, err
}

func (s *Service) UpdateMacro(ctx context.Context, in MacroInput) (Macro, error) {
	if in.MacroID == uuid.Nil {
		return Macro{}, ErrNotFound
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || utf8.RuneCountInString(name) > 255 || len(in.Actions) == 0 {
		return Macro{}, ErrInvalid
	}
	for _, a := range in.Actions {
		if !macroActions[a.ActionName] {
			return Macro{}, ErrInvalid
		}
	}
	var out Macro
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		visibility := in.Visibility
		if visibility == "" {
			visibility = MacroVisibilityAccount
		}
		if visibility != MacroVisibilityAccount && visibility != MacroVisibilityPersonal {
			return ErrInvalid
		}
		raw, err := json.Marshal(in.Actions)
		if err != nil {
			return err
		}
		var actions []byte
		err = tx.QueryRow(ctx, `
			UPDATE macros SET name = $2, actions = $3::jsonb, visibility = $4
			WHERE id = $1
			RETURNING id, name, actions, visibility, COALESCE(created_by, '00000000-0000-0000-0000-000000000000')`,
			in.MacroID, name, string(raw), visibility,
		).Scan(&out.ID, &out.Name, &actions, &out.Visibility, &out.CreatedBy)
		if err == pgx.ErrNoRows {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		return json.Unmarshal(actions, &out.Actions)
	})
	return out, err
}

func (s *Service) DeleteMacro(ctx context.Context, in MacroInput) error {
	if in.MacroID == uuid.Nil {
		return ErrNotFound
	}
	return s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		tag, err := tx.Exec(ctx, `DELETE FROM macros WHERE id = $1`, in.MacroID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func (s *Service) ExecuteMacro(ctx context.Context, in MacroInput) (ExecuteResult, error) {
	if in.MacroID == uuid.Nil || in.ConversationID == uuid.Nil {
		return ExecuteResult{}, ErrNotFound
	}
	var loaded Macro
	var raw []byte
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, false, func(tx pgx.Tx, _ string) error {
		err := tx.QueryRow(ctx, `
			SELECT id, name, actions, visibility, COALESCE(created_by, '00000000-0000-0000-0000-000000000000')
			FROM macros WHERE account_id = $1 AND id = $2`,
			in.AccountID, in.MacroID,
		).Scan(&loaded.ID, &loaded.Name, &raw, &loaded.Visibility, &loaded.CreatedBy)
		if err == pgx.ErrNoRows {
			return ErrNotFound
		}
		return err
	})
	if err != nil {
		return ExecuteResult{}, err
	}
	if err := json.Unmarshal(raw, &loaded.Actions); err != nil {
		return ExecuteResult{}, err
	}
	if loaded.Visibility == MacroVisibilityPersonal && loaded.CreatedBy != in.ActorUserID {
		return ExecuteResult{}, ErrDenied
	}
	var inboxID uuid.UUID
	var version int
	err = s.withAccountMember(ctx, in.ActorUserID, in.AccountID, false, func(tx pgx.Tx, _ string) error {
		if err := tx.QueryRow(ctx, `SELECT inbox_id, version FROM conversations WHERE id = $1`, in.ConversationID).Scan(&inboxID, &version); err != nil {
			if err == pgx.ErrNoRows {
				return ErrNotFound
			}
			return err
		}
		return requireAssignActor(ctx, tx, in.AccountID, inboxID, in.ActorUserID)
	})
	if err != nil {
		return ExecuteResult{}, err
	}

	out := ExecuteResult{Version: version}
	noteIn := NoteInput{ActorUserID: in.ActorUserID, AccountID: in.AccountID, ConversationID: in.ConversationID}
	for _, a := range loaded.Actions {
		params := a.ActionParams
		switch a.ActionName {
		case ActionSendMessage:
			msg, err := s.writeAgentMessage(ctx, withContent(noteIn, firstParam(params)), false)
			if err != nil {
				return out, err
			}
			out.Messages = append(out.Messages, msg)
		case ActionAddPrivateNote:
			msg, err := s.AddNote(ctx, withContent(noteIn, firstParam(params)))
			if err != nil {
				return out, err
			}
			out.Messages = append(out.Messages, msg)
		case ActionAddLabel:
			lbl, err := s.AddConversationLabel(ctx, LabelInput{
				ActorUserID: in.ActorUserID, AccountID: in.AccountID,
				ConversationID: in.ConversationID, Name: firstParam(params),
			})
			if err != nil {
				return out, err
			}
			out.Labels = append(out.Labels, lbl)
		case ActionAssignAgent:
			assignee, err := uuid.Parse(firstParam(params))
			if err != nil {
				return out, ErrInvalid
			}
			version, err = s.conversationVersion(ctx, in.AccountID, in.ConversationID)
			if err != nil {
				return out, err
			}
			res, err := s.Assign(ctx, AssignInput{
				ActorUserID: in.ActorUserID, AccountID: in.AccountID, ConversationID: in.ConversationID,
				AssigneeID: assignee, ExpectedVersion: version,
			})
			if err != nil {
				return out, err
			}
			out.AssigneeID = res.AssigneeID
			out.Status = res.Status
			out.Version = res.Version
		case ActionSnooze:
			until := time.Now().UTC().Add(24 * time.Hour)
			if firstParam(params) != "" {
				parsed, err := time.Parse(time.RFC3339, firstParam(params))
				if err != nil {
					parsed, err = time.Parse(time.RFC3339Nano, firstParam(params))
					if err != nil {
						return out, ErrInvalid
					}
				}
				until = parsed
			}
			version, err = s.conversationVersion(ctx, in.AccountID, in.ConversationID)
			if err != nil {
				return out, err
			}
			res, err := s.Snooze(ctx, SnoozeInput{
				ActorUserID: in.ActorUserID, AccountID: in.AccountID, ConversationID: in.ConversationID,
				Until: until, ExpectedVersion: version,
			})
			if err != nil {
				return out, err
			}
			out.Status = res.Status
			out.Version = res.Version
			t := res.SnoozedUntil
			out.SnoozedUntil = &t
		case ActionResolve:
			version, err = s.conversationVersion(ctx, in.AccountID, in.ConversationID)
			if err != nil {
				return out, err
			}
			actor := in.ActorUserID
			res, err := s.Transition(ctx, TransitionInput{
				AccountID: in.AccountID, ConversationID: in.ConversationID,
				NewStatus: StatusResolved, ExpectedVersion: version, ActorID: &actor,
			})
			if err != nil {
				return out, err
			}
			out.Status = res.Status
			out.Version = res.Version
		default:
			return out, ErrInvalid
		}
	}
	if out.Labels == nil {
		out.Labels = []Label{}
	}
	if out.Messages == nil {
		out.Messages = []NoteResult{}
	}
	return out, nil
}

func withContent(in NoteInput, content string) NoteInput {
	in.Content = content
	return in
}

func firstParam(params []string) string {
	if len(params) == 0 {
		return ""
	}
	return params[0]
}

func (s *Service) conversationVersion(ctx context.Context, accountID, conversationID uuid.UUID) (int, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, accountID.String()); err != nil {
		return 0, err
	}
	var version int
	if err := tx.QueryRow(ctx, `SELECT version FROM conversations WHERE id = $1`, conversationID).Scan(&version); err != nil {
		if err == pgx.ErrNoRows {
			return 0, ErrNotFound
		}
		return 0, err
	}
	return version, tx.Commit(ctx)
}

func (s *Service) handleMacroCreate(msg *nats.Msg) {
	in, err := parseMacroInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.CreateMacro(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "id": out.ID.String(), "name": out.Name,
		"actions": out.Actions, "visibility": out.Visibility, "created_by": out.CreatedBy.String(),
	})
	_ = msg.Respond(body)
}

func (s *Service) handleMacroList(msg *nats.Msg) {
	in, err := parseMacroInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListMacros(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, m := range list {
		rows = append(rows, map[string]any{
			"id": m.ID.String(), "name": m.Name, "actions": m.Actions,
			"visibility": m.Visibility, "created_by": m.CreatedBy.String(),
		})
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "macros": rows})
	_ = msg.Respond(body)
}

func (s *Service) handleMacroUpdate(msg *nats.Msg) {
	in, err := parseMacroInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.UpdateMacro(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "id": out.ID.String(), "name": out.Name,
		"actions": out.Actions, "visibility": out.Visibility, "created_by": out.CreatedBy.String(),
	})
	_ = msg.Respond(body)
}

func (s *Service) handleMacroDelete(msg *nats.Msg) {
	in, err := parseMacroInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.DeleteMacro(context.Background(), in); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func (s *Service) handleMacroExecute(msg *nats.Msg) {
	in, err := parseMacroInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.ExecuteMacro(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	labels := make([]map[string]any, 0, len(out.Labels))
	for _, l := range out.Labels {
		labels = append(labels, map[string]any{"id": l.ID.String(), "name": l.Name, "color": l.Color})
	}
	messages := make([]map[string]any, 0, len(out.Messages))
	for _, m := range out.Messages {
		messages = append(messages, map[string]any{
			"message_id": m.MessageID.String(), "inbox_id": m.InboxID.String(),
			"conversation_id": m.ConversationID.String(), "contact_id": m.ContactID.String(),
			"contact_inbox_id": m.ContactInboxID.String(), "sender_id": m.SenderID.String(),
			"content": m.Content, "private": m.Private,
		})
	}
	body := map[string]any{
		"ok": true, "status": out.Status, "version": out.Version,
		"labels": labels, "messages": messages,
	}
	if out.AssigneeID != uuid.Nil {
		body["assignee_id"] = out.AssigneeID.String()
	}
	if out.SnoozedUntil != nil {
		body["snoozed_until"] = out.SnoozedUntil.UTC().Format(time.RFC3339)
	}
	raw, _ := json.Marshal(body)
	_ = msg.Respond(raw)
}

func parseMacroInput(msg *nats.Msg) (MacroInput, error) {
	var req struct {
		ActorUserID    string        `json:"actor_user_id"`
		AccountID      string        `json:"account_id"`
		ConversationID string        `json:"conversation_id"`
		MacroID        string        `json:"macro_id"`
		Name           string        `json:"name"`
		Visibility     string        `json:"visibility"`
		Actions        []MacroAction `json:"actions"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return MacroInput{}, err
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		return MacroInput{}, err
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return MacroInput{}, err
	}
	in := MacroInput{
		ActorUserID: actor, AccountID: accountID, Name: req.Name,
		Actions: req.Actions, Visibility: req.Visibility,
	}
	if req.ConversationID != "" {
		id, err := uuid.Parse(req.ConversationID)
		if err != nil {
			return MacroInput{}, err
		}
		in.ConversationID = id
	}
	if req.MacroID != "" {
		id, err := uuid.Parse(req.MacroID)
		if err != nil {
			return MacroInput{}, err
		}
		in.MacroID = id
	}
	return in, nil
}
