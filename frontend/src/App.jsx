import { useEffect, useReducer, useState } from "react";
import { AssignTicket } from "./components/AssignTicket.jsx";
import { InboxMembers } from "./components/InboxMembers.jsx";
import { InternalNote } from "./components/InternalNote.jsx";
import { LoginForm } from "./components/LoginForm.jsx";
import { SnoozeTicket } from "./components/SnoozeTicket.jsx";
import { TicketAttachments } from "./components/TicketAttachments.jsx";
import { TicketLabels } from "./components/TicketLabels.jsx";
import { Badge } from "./components/ui/badge.jsx";
import { Button } from "./components/ui/button.jsx";
import { Textarea } from "./components/ui/textarea.jsx";
import { emptyState, reduce, visibleInQueue } from "./store.js";

export function App({ session: initialSession, client, initialState = emptyState }) {
  const [session, setSession] = useState(initialSession);
  const [booting, setBooting] = useState(
    !initialSession.token && !initialSession.fixture && typeof client.refresh === "function",
  );
  const [state, dispatch] = useReducer(reduce, initialState);
  const [draft, setDraft] = useState("");
  const queue = state.conversations.filter((c) => visibleInQueue(c));
  const selected = queue.find((c) => c.id === state.selectedId);

  useEffect(() => {
    if (!booting) {
      return undefined;
    }
    let cancelled = false;
    client
      .refresh({ gatewayUrl: initialSession.gatewayUrl })
      .then((data) => {
        if (cancelled) {
          return;
        }
        if (data?.access_token) {
          setSession({
            ...initialSession,
            token: data.access_token,
            accountId: data.user?.account_id || initialSession.accountId,
            role: data.user?.role || initialSession.role,
            inboxIds: data.user?.inbox_ids || initialSession.inboxIds,
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setBooting(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [booting, client, initialSession]);

  useEffect(() => {
    if (!session.token || !client.connect) {
      return undefined;
    }
    return client.connect(session, (event) => dispatch({ type: "realtime", event }));
  }, [session, client]);

  async function onSubmit(e) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !selected || !client.sendReply) {
      return;
    }
    await client.sendReply({
      gatewayUrl: session.gatewayUrl,
      accountId: session.accountId,
      token: session.token,
      conversation: selected,
      content,
    });
    setDraft("");
  }

  if (booting) {
    return <p className="bg-white p-6 text-neutral-900">불러오는 중</p>;
  }
  if (!session.token && !session.fixture) {
    return (
      <LoginForm
        client={client}
        gatewayUrl={session.gatewayUrl}
        onSuccess={(next) => setSession({ ...session, ...next })}
      />
    );
  }

  return (
    <div className="workspace">
      <nav className="queue" aria-label="대기열">
        <h1>대기열</h1>
        {session.role === "administrator" ? <InboxMembers session={session} client={client} /> : null}
        {queue.length === 0 ? (
          <p>대기 중인 대화가 없습니다</p>
        ) : (
          <ul>
            {queue.map((c) => (
              <li key={c.id}>
                <Button
                  variant="ghost"
                  className="w-full justify-between"
                  aria-current={c.id === state.selectedId ? "true" : undefined}
                  onClick={() => dispatch({ type: "select", id: c.id })}
                >
                  {c.lastContent}
                  {c.unread > 0 ? <Badge>{c.unread}</Badge> : null}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <section className="thread">
        {!selected ? (
          <p>대화를 선택하세요</p>
        ) : (
          <>
            <AssignTicket
              key={selected.id}
              session={session}
              conversation={selected}
              client={client}
              onAssigned={(next) => dispatch({ type: "assigned", ...next })}
            />
            <SnoozeTicket
              key={`snooze-${selected.id}`}
              session={session}
              conversation={selected}
              client={client}
              onSnoozed={(next) => dispatch({ type: "snoozed", ...next })}
            />
            <TicketLabels
              key={`labels-${selected.id}`}
              session={session}
              conversation={selected}
              client={client}
              onLabeled={(next) => dispatch({ type: "labeled", ...next })}
            />
            <ol className="log" role="log">
              {(state.messages[selected.id] || []).map((m) => (
                <li key={m.id} data-sender={m.senderType} data-private={m.private ? "true" : undefined}>
                  {m.content}
                  {(m.attachments || []).map((a) => (
                    <a key={a.id || a.external_url} href={a.external_url}>
                      {a.external_url}
                    </a>
                  ))}
                </li>
              ))}
            </ol>
            <TicketAttachments
              key={`attach-${selected.id}`}
              session={session}
              conversation={selected}
              client={client}
              onAttached={(data) =>
                dispatch({
                  type: "realtime",
                  event: {
                    event: "message.created",
                    conversation_id: selected.id,
                    inbox_id: selected.inboxId,
                    message: {
                      id: data.message_id,
                      payload: {
                        content: data.filename || "",
                        sender_type: "User",
                        attachments: data.attachments,
                        contact_id: selected.contactId,
                        contact_inbox_id: selected.contactInboxId,
                      },
                    },
                  },
                })
              }
            />
            <InternalNote
              key={`note-${selected.id}`}
              session={session}
              conversation={selected}
              client={client}
              onNoted={(data) =>
                dispatch({
                  type: "realtime",
                  event: {
                    event: "message.created",
                    conversation_id: selected.id,
                    inbox_id: selected.inboxId,
                    message: {
                      id: data.message_id,
                      payload: {
                        content: data.content,
                        sender_type: "User",
                        private: true,
                        contact_id: selected.contactId,
                        contact_inbox_id: selected.contactInboxId,
                      },
                    },
                  },
                })
              }
            />
            <form className="composer" onSubmit={onSubmit}>
              <Textarea
                aria-label="답장"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <Button type="submit">보내기</Button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
