import { useEffect, useReducer, useState } from "react";
import { AssignTicket } from "./components/AssignTicket.jsx";
import { CatalogSettings } from "./components/CatalogSettings.jsx";
import { InboxHmac } from "./components/InboxHmac.jsx";
import { InboxMembers } from "./components/InboxMembers.jsx";
import { InternalNote } from "./components/InternalNote.jsx";
import { LoginForm } from "./components/LoginForm.jsx";
import { ResolveTicket } from "./components/ResolveTicket.jsx";
import { SnoozeTicket } from "./components/SnoozeTicket.jsx";
import { TicketAttachments } from "./components/TicketAttachments.jsx";
import { TicketLabels } from "./components/TicketLabels.jsx";
import { TicketMacros } from "./components/TicketMacros.jsx";
import { Badge } from "./components/ui/badge.jsx";
import { Button } from "./components/ui/button.jsx";
import { Textarea } from "./components/ui/textarea.jsx";
import { bindAuth } from "./gateway.js";
import { conversationsFromAPI, emptyState, messagesFromAPI, reduce, visibleInQueue } from "./store.js";

export function App({ session: initialSession, client, initialState = emptyState }) {
  const [session, setSession] = useState(initialSession);
  const [canned, setCanned] = useState([]);
  const [view, setView] = useState("inbox");
  const [composeMode, setComposeMode] = useState("reply");
  const [booting, setBooting] = useState(
    !initialSession.token && !initialSession.fixture && typeof client.refresh === "function",
  );
  const [state, dispatch] = useReducer(reduce, initialState);
  const [draft, setDraft] = useState("");
  const queue = state.conversations.filter((c) => visibleInQueue(c));
  const selected = queue.find((c) => c.id === state.selectedId);

  function applySession(next) {
    setSession((prev) => ({
      ...prev,
      token: next.token || next.access_token || prev.token,
      accountId: next.user?.account_id || next.accountId || prev.accountId,
      role: next.user?.role || next.role || prev.role,
      inboxIds: next.user?.inbox_ids || next.inboxIds || prev.inboxIds,
      userId: next.user?.id || next.userId || prev.userId,
    }));
  }

  useEffect(() => {
    bindAuth({
      refresh: client.refresh,
      onSessionUpdate: applySession,
    });
  }, [client, session.token]);

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
          applySession({
            ...data,
            token: data.access_token,
            accountId: data.user?.account_id || initialSession.accountId,
            role: data.user?.role || initialSession.role,
            inboxIds: data.user?.inbox_ids || initialSession.inboxIds,
            userId: data.user?.id || initialSession.userId,
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
    return client.connect(session, (event) => dispatch({ type: "realtime", event }), {
      refresh: client.refresh,
      onSessionUpdate: applySession,
    });
  }, [session, client]);

  useEffect(() => {
    if (!session.token || session.fixture || !client.listConversations) {
      return undefined;
    }
    let cancelled = false;
    client
      .listConversations({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
      })
      .then((data) => {
        if (!cancelled) {
          dispatch({ type: "hydrate", conversations: conversationsFromAPI(data.conversations) });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, client]);

  useEffect(() => {
    if (!session.token || !client.listCanned) {
      return undefined;
    }
    let cancelled = false;
    client
      .listCanned({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
      })
      .then((data) => {
        if (!cancelled) {
          setCanned(data?.canned_responses || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, client]);

  useEffect(() => {
    if (!state.selectedId || !session.token || !client.listMessages) {
      return undefined;
    }
    let cancelled = false;
    client
      .listMessages({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversationId: state.selectedId,
      })
      .then((data) => {
        if (!cancelled) {
          dispatch({
            type: "hydrate",
            messages: { [state.selectedId]: messagesFromAPI(data.messages) },
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state.selectedId, session, client]);

  useEffect(() => {
    function onKey(e) {
      const typing =
        e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        const form = document.querySelector(composeMode === "note" ? "form.note" : "form.composer");
        form?.requestSubmit?.();
        return;
      }
      if (typing) {
        return;
      }
      if (e.key === "j" || e.key === "J") {
        const idx = queue.findIndex((c) => c.id === state.selectedId);
        const next = queue[Math.min(queue.length - 1, (idx < 0 ? -1 : idx) + 1)];
        if (next) {
          dispatch({ type: "select", id: next.id });
        }
      }
      if (e.key === "k" || e.key === "K") {
        const idx = queue.findIndex((c) => c.id === state.selectedId);
        const prev = queue[Math.max(0, (idx < 0 ? 0 : idx) - 1)];
        if (prev) {
          dispatch({ type: "select", id: prev.id });
        }
      }
      if (e.key === "r" || e.key === "R") {
        setComposeMode("reply");
        setTimeout(() => document.querySelector('[aria-label="답장"]')?.focus(), 0);
      }
      if (e.key === "n" || e.key === "N") {
        setComposeMode("note");
        setTimeout(() => document.querySelector('[aria-label="메모"]')?.focus(), 0);
      }
      if (e.key === "e" || e.key === "E") {
        document.querySelector('.resolve button:last-of-type')?.click();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue, state.selectedId, composeMode]);

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

  const slash = draft.match(/(?:^|\s)(\/[^\s]*)$/);
  const slashCode = slash ? slash[1].slice(1) : "";
  const cannedHits = slashCode
    ? canned.filter((c) => (c.short_code || "").startsWith(slashCode))
    : [];

  function insertCanned(item) {
    const next = slash ? draft.slice(0, slash.index) + (slash.index > 0 ? " " : "") + item.content : item.content;
    setDraft(next.trimStart());
  }

  function applyMacro(out) {
    if (!selected) {
      return;
    }
    for (const label of out.labels || []) {
      dispatch({ type: "labeled", conversationId: selected.id, label });
    }
    for (const m of out.messages || []) {
      dispatch({
        type: "realtime",
        event: {
          event: "message.created",
          conversation_id: selected.id,
          inbox_id: selected.inboxId,
          message: {
            id: m.message_id,
            payload: {
              content: m.content,
              sender_type: "User",
              private: m.private,
              contact_id: selected.contactId,
              contact_inbox_id: selected.contactInboxId,
            },
          },
        },
      });
    }
    if (out.status === "resolved") {
      dispatch({
        type: "resolved",
        conversationId: selected.id,
        status: out.status,
        version: out.version,
      });
    }
    if (out.status === "snoozed") {
      dispatch({
        type: "snoozed",
        conversationId: selected.id,
        status: out.status,
        version: out.version,
        snoozedUntil: out.snoozed_until,
      });
    }
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

  const admin = session.role === "administrator";
  const settings = view === "settings" && admin;

  return (
    <div className="workspace">
      <aside className="rail" aria-label="워크스페이스">
        <Button
          variant={view === "inbox" ? "secondary" : "ghost"}
          size="icon"
          aria-label="대기열"
          aria-current={view === "inbox" ? "page" : undefined}
          onClick={() => setView("inbox")}
        >
          큐
        </Button>
        {admin ? (
          <Button
            variant={view === "settings" ? "secondary" : "ghost"}
            size="icon"
            aria-label="설정"
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => setView("settings")}
          >
            설정
          </Button>
        ) : null}
      </aside>
      {settings ? (
        <section className="settings-pane" role="region" aria-label="워크스페이스 관리">
          <InboxMembers session={session} client={client} />
          <InboxHmac session={session} client={client} />
          <CatalogSettings session={session} client={client} />
        </section>
      ) : (
        <>
          <nav className="queue" aria-label="대기열">
            <h1>대기열</h1>
            {queue.length === 0 ? (
              <p>대기 중인 대화가 없습니다</p>
            ) : (
              <ul>
                {queue.map((c) => (
                  <li key={c.id}>
                    <Button
                      variant="ghost"
                      className={`queue-card ${c.id === state.selectedId ? "queue-card-current" : ""}`}
                      aria-current={c.id === state.selectedId ? "true" : undefined}
                      onClick={() => dispatch({ type: "select", id: c.id })}
                    >
                      <span className="queue-card-meta">
                        {c.channel ? <Badge variant="outline">{c.channel}</Badge> : null}
                        {c.slaBreached ? (
                          <Badge variant="destructive">SLA</Badge>
                        ) : null}
                      </span>
                      <span className="queue-card-preview">{c.lastContent}</span>
                      <span className="queue-card-tags">
                        {(c.labels || []).map((l) => (
                          <Badge key={l.id || l.name} variant="secondary">
                            {l.name}
                          </Badge>
                        ))}
                        {c.unread > 0 ? <Badge>{c.unread}</Badge> : null}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          <section className="thread">
            {!selected ? (
              <p className="p-6 text-slate-500">대화를 선택하세요</p>
            ) : (
              <>
                <header className="thread-header">
                  <div className="thread-header-id">
                    <span className="font-medium">{selected.lastContent}</span>
                    {selected.status ? (
                      <Badge variant="secondary">{selected.status}</Badge>
                    ) : null}
                  </div>
                  <div className="thread-header-actions">
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
                    <TicketMacros
                      key={`macros-${selected.id}`}
                      session={session}
                      conversation={selected}
                      client={client}
                      onRan={applyMacro}
                    />
                    <ResolveTicket
                      key={`resolve-${selected.id}`}
                      session={session}
                      conversation={selected}
                      client={client}
                      onResolved={(next) => dispatch({ type: "resolved", ...next })}
                    />
                  </div>
                </header>
                <ol className="log" role="log">
                  {(state.messages[selected.id] || []).map((m) => (
                    <li
                      key={m.id}
                      data-sender={m.senderType}
                      data-private={m.private ? "true" : undefined}
                      className={bubbleClass(m)}
                    >
                      {m.private ? <span className="note-caption">내부 메모</span> : null}
                      {m.content}
                      {(m.attachments || []).map((a) => (
                        <a
                          key={a.id || a.external_url}
                          className="attach-card"
                          href={a.external_url}
                        >
                          {a.file_name || a.filename || fileName(a.external_url)}
                          {a.file_size != null ? ` (${a.file_size} B)` : null} {a.external_url}
                        </a>
                      ))}
                    </li>
                  ))}
                </ol>
                <div className={`composer-dock ${composeMode === "note" ? "composer-note" : ""}`}>
                  <div className="composer-tabs">
                    <Button
                      type="button"
                      variant={composeMode === "reply" ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => setComposeMode("reply")}
                    >
                      답장
                    </Button>
                    <Button
                      type="button"
                      variant={composeMode === "note" ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => setComposeMode("note")}
                    >
                      내부 메모
                    </Button>
                  </div>
                  {composeMode === "note" ? (
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
                  ) : (
                    <form className="composer" onSubmit={onSubmit}>
                      {cannedHits.length > 0 ? (
                        <ul role="listbox" aria-label="저장응답" className="canned-pop">
                          {cannedHits.map((item) => (
                            <li key={item.id || item.short_code}>
                              <Button type="button" variant="ghost" onClick={() => insertCanned(item)}>
                                /{item.short_code}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <Textarea
                        aria-label="답장"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                      <Button type="submit">보내기</Button>
                    </form>
                  )}
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
                </div>
              </>
            )}
          </section>
          <aside className="context-pane">
            {selected ? (
              <>
                <TicketLabels
                  key={`labels-${selected.id}`}
                  session={session}
                  conversation={selected}
                  client={client}
                  onLabeled={(next) => dispatch({ type: "labeled", ...next })}
                  onUnlabeled={(next) => dispatch({ type: "unlabeled", ...next })}
                />
                <section className="context-card" aria-label="채널 상태">
                  {selected.channel ? <p>채널 {selected.channel}</p> : null}
                  {selected.slaBreached ? <Badge variant="destructive">SLA</Badge> : <p>SLA 충족</p>}
                </section>
              </>
            ) : null}
          </aside>
        </>
      )}
    </div>
  );
}

function bubbleClass(m) {
  if (m.private) {
    return "bubble bubble-note";
  }
  if (m.senderType === "Contact") {
    return "bubble bubble-in";
  }
  return "bubble bubble-out";
}

function fileName(url) {
  if (!url) {
    return "첨부";
  }
  try {
    const path = new URL(url, "http://local").pathname;
    return path.split("/").pop() || url;
  } catch {
    return url;
  }
}
