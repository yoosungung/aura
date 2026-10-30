package core

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ReportInput struct {
	ActorUserID uuid.UUID
	AccountID   uuid.UUID
}

type ReportConversations struct {
	Total      int `json:"total"`
	Unassigned int `json:"unassigned"`
	Open       int `json:"open"`
	Pending    int `json:"pending"`
	Snoozed    int `json:"snoozed"`
	Resolved   int `json:"resolved"`
}

type ReportAgent struct {
	UserID        uuid.UUID `json:"user_id"`
	Name          string    `json:"name"`
	OpenCount     int       `json:"open_count"`
	ResolvedCount int       `json:"resolved_count"`
}

type ReportInbox struct {
	InboxID           uuid.UUID `json:"inbox_id"`
	Name              string    `json:"name"`
	ConversationCount int       `json:"conversation_count"`
}

type Report struct {
	Conversations ReportConversations `json:"conversations"`
	Agents        []ReportAgent       `json:"agents"`
	Inboxes       []ReportInbox       `json:"inboxes"`
	CSATPercent   float64             `json:"csat_percent"`
	SLAHitRate    float64             `json:"sla_hit_rate"`
}

func (s *Service) Report(ctx context.Context, in ReportInput) (Report, error) {
	var out Report
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, `SELECT status, count(*) FROM conversations GROUP BY status`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var status string
			var n int
			if err := rows.Scan(&status, &n); err != nil {
				rows.Close()
				return err
			}
			out.Conversations.Total += n
			switch status {
			case StatusUnassigned:
				out.Conversations.Unassigned = n
			case StatusOpen:
				out.Conversations.Open = n
			case StatusPending:
				out.Conversations.Pending = n
			case StatusSnoozed:
				out.Conversations.Snoozed = n
			case StatusResolved:
				out.Conversations.Resolved = n
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		agentRows, err := tx.Query(ctx, `
			SELECT u.id, u.name,
				count(c.id) FILTER (WHERE c.status = 'open'),
				count(c.id) FILTER (WHERE c.status = 'resolved')
			FROM account_users au
			JOIN users u ON u.id = au.user_id
			LEFT JOIN conversations c ON c.assignee_id = u.id
			GROUP BY u.id, u.name
			ORDER BY u.name`)
		if err != nil {
			return err
		}
		for agentRows.Next() {
			var a ReportAgent
			if err := agentRows.Scan(&a.UserID, &a.Name, &a.OpenCount, &a.ResolvedCount); err != nil {
				agentRows.Close()
				return err
			}
			out.Agents = append(out.Agents, a)
		}
		if err := agentRows.Err(); err != nil {
			agentRows.Close()
			return err
		}
		agentRows.Close()

		inboxRows, err := tx.Query(ctx, `
			SELECT i.id, i.name, count(c.id)
			FROM inboxes i
			LEFT JOIN conversations c ON c.inbox_id = i.id
			GROUP BY i.id, i.name
			ORDER BY i.name`)
		if err != nil {
			return err
		}
		for inboxRows.Next() {
			var i ReportInbox
			if err := inboxRows.Scan(&i.InboxID, &i.Name, &i.ConversationCount); err != nil {
				inboxRows.Close()
				return err
			}
			out.Inboxes = append(out.Inboxes, i)
		}
		if err := inboxRows.Err(); err != nil {
			inboxRows.Close()
			return err
		}
		inboxRows.Close()

		var csat *float64
		if err := tx.QueryRow(ctx, `
			SELECT 100.0 * count(*) FILTER (WHERE rating >= 4) / NULLIF(count(*), 0)
			FROM csat_survey_responses`).Scan(&csat); err != nil {
			return err
		}
		if csat != nil {
			out.CSATPercent = *csat
		}
		var sla *float64
		if err := tx.QueryRow(ctx, `
			SELECT 100.0 * count(*) FILTER (
				WHERE NOT is_frt_breached AND NOT is_nrt_breached AND NOT is_rt_breached
			) / NULLIF(count(*), 0)
			FROM applied_slas`).Scan(&sla); err != nil {
			return err
		}
		if sla != nil {
			out.SLAHitRate = *sla
		}
		return nil
	})
	if out.Agents == nil {
		out.Agents = []ReportAgent{}
	}
	if out.Inboxes == nil {
		out.Inboxes = []ReportInbox{}
	}
	return out, err
}
