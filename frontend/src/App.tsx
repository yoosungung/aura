import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import type { EgoNode } from "./components/LivingProfile.jsx";
import type { HelpdeskClient, StopHandle } from "./gateway.js";
import type { Attachment, Conversation, Message, Session, WorkspaceState } from "./store.js";
import { ApprovalCard } from "./components/ApprovalCard.jsx";
import { AssignTicket } from "./components/AssignTicket.jsx";
import { ArticleSettings } from "./components/ArticleSettings.jsx";
import { CatalogSettings } from "./components/CatalogSettings.jsx";
import { InboxHmac } from "./components/InboxHmac.jsx";
import { InboxMembers } from "./components/InboxMembers.jsx";
import { ReportSettings } from "./components/ReportSettings.jsx";
import { MCPSettings } from "./components/MCPSettings.jsx";
import { SettingsNav } from "./components/SettingsNav.jsx";
import { SkillSettings } from "./components/SkillSettings.jsx";
import { WebhookSettings } from "./components/WebhookSettings.jsx";
import { LivingProfile } from "./components/LivingProfile.jsx";
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
import {
  channelLabel,
  conversationsFromAPI,
  emptyState,
  formatClock,
  kakaoSessionLabel,
  messagesFromAPI,
  reduce,
  relativeTime,
  slaRemain,
  visibleInQueue,
} from "./store.js";

type CannedItem = { id?: string; short_code?: string; content?: string };

type AppProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
  initialState?: WorkspaceState;
  viewportWidth?: number;
};

export function App({ session: initialSession, client, initialState = emptyState, viewportWidth = undefined }: AppProps) {
  const [session, setSession] = useState<Session>(initialSession);
  const [canned, setCanned] = useState<CannedItem[]>([]);
  const [ego, setEgo] = useState<EgoNode[]>([]);
  const [view, setView] = useState("inbox");
  const [composeMode, setComposeMode] = useState("reply");
  const [contextOpen, setContextOpen] = useState(false);
  const [composerFocus, setComposerFocus] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("members");
  const [width, setWidth] = useState(() =>
    viewportWidth != null ? viewportWidth : typeof window !== "undefined" ? window.innerWidth : 1280,
  );
  const layout = layoutFor(width);
  const [booting, setBooting] = useState(
    !initialSession.token && !initialSession.fixture && typeof client.refresh === "function",
  );
  const [state, dispatch] = useReducer(reduce, initialState);
  const [draft, setDraft] = useState("");
  const [cannedIndex, setCannedIndex] = useState(0);
  const logRef = useRef<HTMLOListElement | null>(null);
  const wsRef = useRef<StopHandle | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = state.conversations.filter((c) => visibleInQueue(c));
  const selected = queue.find((c) => c.id === state.selectedId);
  const unreadTotal = queue.reduce((n, c) => n + (c.unread || 0), 0);

  function applySession(next: any) {
    setSession((prev) => ({
      ...prev,
      token: next.token || next.access_token || prev.token,
      accountId: next.user?.account_id || next.accountId || prev.accountId,
      role: next.user?.role || next.role || prev.role,
      inboxIds: next.user?.inbox_ids || next.inboxIds || prev.inboxIds,
      userId: next.user?.id || next.userId || prev.userId,
      name: next.user?.name || next.name || prev.name,
      email: next.user?.email || next.email || prev.email,
    }));
  }

  useEffect(() => {
    bindAuth({
      refresh: client.refresh,
      onSessionUpdate: applySession,
    });
  }, [client, session.token]);

  useEffect(() => {
    if (viewportWidth != null) {
      setWidth(viewportWidth);
      return undefined;
    }
    function onResize() {
      setWidth(window.innerWidth);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [viewportWidth]);

  useEffect(() => {
    if (!booting) {
      return undefined;
    }
    let cancelled = false;
    void client.refresh?.({ gatewayUrl: initialSession.gatewayUrl })
      ?.then((data) => {
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
    const stop = client.connect(
      session,
      (event) => {
        if (event.event === "presence" && event.user_id === session.userId) {
          setSession((s) => ({ ...s, availabilityStatus: event.status }));
          return;
        }
        dispatch({ type: "realtime", event });
      },
      {
        refresh: client.refresh,
        onSessionUpdate: applySession,
      },
    );
    wsRef.current = stop;
    return () => {
      wsRef.current = null;
      stop?.();
    };
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
    if (!session.token || session.fixture || !client.listContacts) {
      return undefined;
    }
    let cancelled = false;
    client
      .listContacts({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
      })
      .then((data) => {
        if (cancelled) {
          return;
        }
        const contacts: Record<string, { name?: string; email?: string }> = {};
        for (const p of data?.contacts || []) {
          contacts[p.id] = p;
        }
        dispatch({ type: "contacts", contacts });
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
    const selectedId = state.selectedId;
    if (!selectedId || !session.token || !client.listMessages) {
      return undefined;
    }
    let cancelled = false;
    client
      .listMessages({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversationId: selectedId,
      })
      .then((data) => {
        if (!cancelled) {
          dispatch({
            type: "hydrate",
            messages: { [selectedId]: messagesFromAPI(data.messages) },
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state.selectedId, session, client]);

  useEffect(() => {
    if (!selected?.contactId || !session.token || !client.listEgo) {
      setEgo([]);
      return undefined;
    }
    let cancelled = false;
    client
      .listEgo({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        contactId: selected.contactId,
      })
      .then((data) => {
        if (!cancelled) {
          setEgo(data?.nodes || []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEgo([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.contactId, session, client]);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        !!target?.isContentEditable;
      if (e.key === "Escape") {
        for (const el of document.querySelectorAll("details.header-menu")) {
          (el as HTMLDetailsElement).open = false;
        }
        setHelpOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        const menu = document.querySelector("details.macros-menu") as HTMLDetailsElement | null;
        if (menu) {
          menu.open = true;
          queueMicrotask(() => menu.querySelector<HTMLButtonElement>("section.macros button")?.focus());
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        const form = document.querySelector(composeMode === "note" ? "form.note" : "form.composer") as HTMLFormElement | null;
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
        setComposerFocus("reply");
      }
      if (e.key === "n" || e.key === "N") {
        setComposeMode("note");
        setComposerFocus("note");
      }
      if (e.key === "e" || e.key === "E") {
        document.querySelector<HTMLButtonElement>('.resolve button:last-of-type')?.click();
      }
      if (e.key === "?") {
        setHelpOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue, state.selectedId, composeMode]);

  useEffect(() => {
    if (!composerFocus) {
      return undefined;
    }
    const sel = composerFocus === "note" ? '[aria-label="메모"]' : '[aria-label="답장"]';
    document.querySelector<HTMLElement>(sel)?.focus();
    setComposerFocus("");
    return undefined;
  }, [composerFocus, composeMode]);

  useEffect(() => {
    const el = logRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.selectedId, state.messages]);

  async function onSignOut() {
    try {
      await client.signOut?.({ gatewayUrl: session.gatewayUrl });
    } catch {
      /* still leave */
    }
    setSession({ ...session, token: "" });
  }

  async function postReply(conversation: Conversation, content: string, localId: string) {
    try {
      const data = await client.sendReply?.({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversation,
        content,
      });
      dispatch({
        type: "sent",
        conversationId: conversation.id,
        id: localId,
        messageId: data?.message_id,
      });
    } catch {
      dispatch({ type: "sendFailed", conversationId: conversation.id, id: localId });
    }
  }

  function bumpTyping() {
    if (!selected) {
      return;
    }
    wsRef.current?.send?.({
      type: "typing",
      conversation_id: selected.id,
      inbox_id: selected.inboxId,
      is_typing: true,
    });
    if (typingTimer.current) {
      clearTimeout(typingTimer.current);
    }
    typingTimer.current = setTimeout(() => {
      wsRef.current?.send?.({
        type: "typing",
        conversation_id: selected.id,
        inbox_id: selected.inboxId,
        is_typing: false,
      });
    }, 400);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !selected || !client.sendReply) {
      return;
    }
    if (typingTimer.current) {
      clearTimeout(typingTimer.current);
    }
    wsRef.current?.send?.({
      type: "typing",
      conversation_id: selected.id,
      inbox_id: selected.inboxId,
      is_typing: false,
    });
    const localId = `pending-${Date.now()}`;
    dispatch({
      type: "send",
      conversationId: selected.id,
      message: {
        id: localId,
        content,
        senderType: "User",
        status: "sending",
        createdAt: new Date().toISOString(),
      },
    });
    setDraft("");
    await postReply(selected, content, localId);
  }

  async function postNote(conversation: Conversation, content: string, localId: string) {
    try {
      const data = await client.sendNote?.({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        conversationId: conversation.id,
        content,
      });
      dispatch({
        type: "sent",
        conversationId: conversation.id,
        id: localId,
        messageId: data?.message_id,
      });
    } catch {
      dispatch({ type: "sendFailed", conversationId: conversation.id, id: localId });
    }
  }

  async function queueNote(content: string) {
    if (!selected || !client.sendNote) {
      return;
    }
    const localId = `pending-${Date.now()}`;
    dispatch({
      type: "send",
      conversationId: selected.id,
      message: {
        id: localId,
        content,
        senderType: "User",
        private: true,
        status: "sending",
        createdAt: new Date().toISOString(),
      },
    });
    await postNote(selected, content, localId);
  }

  async function retrySend(conversation: Conversation, message: Message) {
    const id = message.id;
    const content = message.content ?? "";
    if (!id) {
      return;
    }
    dispatch({ type: "retry", conversationId: conversation.id, id });
    if (message.private) {
      if (!client.sendNote) {
        return;
      }
      await postNote(conversation, content, id);
      return;
    }
    if (!client.sendReply) {
      return;
    }
    await postReply(conversation, content, id);
  }

  const slash = draft.match(/(?:^|\s)(\/[^\s]*)$/);
  const slashCode = slash ? slash[1].slice(1) : "";
  const cannedHits = slashCode
    ? canned.filter((c) => (c.short_code || "").startsWith(slashCode))
    : [];
  const activeCanned = cannedHits.length ? Math.min(cannedIndex, cannedHits.length - 1) : 0;

  useEffect(() => {
    setCannedIndex(0);
  }, [slashCode]);

  function insertCanned(item: CannedItem) {
    const idx = slash?.index ?? 0;
    const next = slash ? draft.slice(0, idx) + (idx > 0 ? " " : "") + (item.content ?? "") : (item.content ?? "");
    setDraft(next.trimStart());
  }

  function applyMacro(out: any) {
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
  const showQueue = layout !== "mobile" || !selected;
  const showThread = layout !== "mobile" || !!selected;
  const showContext = layout === "desktop" || (layout === "laptop" && contextOpen && selected);

  return (
    <div className="workspace" data-layout={layout} data-pane={selected ? "thread" : "queue"}>
      <aside className="rail" aria-label="워크스페이스">
        <div className="rail-top">
          <span
            className="rail-avatar"
            data-availability={session.availabilityStatus}
            aria-label="가용 상태"
          >
            {agentInitials(session)}
            <span className="availability" data-availability={session.availabilityStatus} />
          </span>
          <Button
            variant={view === "inbox" ? "secondary" : "ghost"}
            size="icon"
            aria-label="대기열"
            aria-current={view === "inbox" ? "page" : undefined}
            onClick={() => setView("inbox")}
          >
            큐
            {unreadTotal > 0 ? <Badge>{unreadTotal}</Badge> : null}
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
        </div>
        <div className="rail-bottom">
          <Button variant="ghost" size="icon" aria-label="단축키" onClick={() => setHelpOpen(true)}>
            ?
          </Button>
          <Button variant="ghost" size="sm" aria-label="로그아웃" onClick={onSignOut}>
            로그아웃
          </Button>
        </div>
      </aside>
      {helpOpen ? (
        <div className="shortcuts" role="dialog" aria-label="단축키">
          <p>J 다음 · K 이전 · R 답장 · N 메모 · E 해결 · ⌘Enter 전송 · ⌘K 매크로</p>
          <Button size="sm" onClick={() => setHelpOpen(false)}>
            닫기
          </Button>
        </div>
      ) : null}
      {settings ? (
        <section className="settings-pane" role="region" aria-label="워크스페이스 관리">
          <SettingsNav tab={settingsTab} onChange={setSettingsTab} />
          <div className="settings-body">
            {settingsTab === "members" ? <InboxMembers session={session} client={client} /> : null}
            {settingsTab === "hmac" ? <InboxHmac session={session} client={client} /> : null}
            {settingsTab === "catalog" ? <CatalogSettings session={session} client={client} /> : null}
            {settingsTab === "webhooks" ? <WebhookSettings session={session} client={client} /> : null}
            {settingsTab === "reports" ? <ReportSettings session={session} client={client} /> : null}
            {settingsTab === "articles" ? <ArticleSettings session={session} client={client} /> : null}
            {settingsTab === "mcp" ? <MCPSettings session={session} client={client} /> : null}
            {settingsTab === "skills" ? <SkillSettings session={session} client={client} /> : null}
          </div>
        </section>
      ) : (
        <>
          {showQueue ? (
          <nav className="queue" aria-label="대기열">
            <h1>대기열 {queue.length}</h1>
            {queue.length === 0 ? (
              <p>대기 중인 대화가 없습니다</p>
            ) : (
              <ul>
                {queue.map((c) => (
                  <li key={c.id}>
                    <Button
                      variant="ghost"
                      className={`queue-card ${c.id === state.selectedId ? "queue-card-current" : ""} ${c.slaBreached ? "queue-card-sla" : ""}`}
                      aria-current={c.id === state.selectedId ? "true" : undefined}
                      onClick={() => dispatch({ type: "select", id: c.id })}
                    >
                      <span className="queue-card-meta">
                        {c.channel ? <Badge variant="outline">{channelLabel(c.channel)}</Badge> : null}
                        {c.displayId ? <span>#{c.displayId}</span> : null}
                        {c.contactName ? <span>{c.contactName}</span> : null}
                        {c.slaBreached ? (
                          <Badge variant="destructive">SLA</Badge>
                        ) : null}
                        {c.lastActivityAt ? <span>{relativeTime(c.lastActivityAt)}</span> : null}
                      </span>
                      <span className="queue-card-preview">{c.lastContent}</span>
                      <span className="queue-card-tags">
                        {(c.labels || []).map((l) => (
                          <Badge key={l.id || l.name} variant="secondary">
                            {l.name}
                          </Badge>
                        ))}
                        {(c.unread || 0) > 0 ? <Badge>{c.unread}</Badge> : null}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          ) : null}
          {showThread ? (
          <section className="thread">
            {!selected ? (
              <p className="p-6 text-slate-500">대화를 선택하세요</p>
            ) : (
              <>
                <header className="thread-header">
                  <div className="thread-header-id">
                    {layout === "mobile" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => dispatch({ type: "select", id: null })}
                      >
                        대기열로
                      </Button>
                    ) : null}
                    {selected.displayId ? (
                      <span className="font-medium">#{selected.displayId}</span>
                    ) : null}
                    {selected.contactName ? (
                      <span className="thread-header-contact">{selected.contactName}</span>
                    ) : null}
                    {selected.channel ? (
                      <Badge variant="outline">{channelLabel(selected.channel)}</Badge>
                    ) : null}
                    {selected.status ? statusBadge(selected.status) : null}
                  </div>
                  <div className="thread-header-actions">
                    {layout === "laptop" && selected ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-expanded={!!showContext}
                        onClick={() => setContextOpen((open) => !open)}
                      >
                        고객 정보
                      </Button>
                    ) : null}
                    <details className="header-menu assign-menu" name="thread-actions" onToggle={closeOtherMenus}>
                      <summary>담당자</summary>
                      <AssignTicket
                        key={selected.id}
                        session={session}
                        conversation={selected}
                        client={client}
                        onAssigned={(next) => dispatch({ type: "assigned", ...next })}
                      />
                    </details>
                    <details className="header-menu snooze-menu" name="thread-actions" onToggle={closeOtherMenus}>
                      <summary>스누즈</summary>
                      <SnoozeTicket
                        key={`snooze-${selected.id}`}
                        session={session}
                        conversation={selected}
                        client={client}
                        onSnoozed={(next) => dispatch({ type: "snoozed", ...next })}
                      />
                    </details>
                    <details className="header-menu macros-menu" name="thread-actions" onToggle={closeOtherMenus}>
                      <summary>매크로</summary>
                      <TicketMacros
                        key={`macros-${selected.id}`}
                        session={session}
                        conversation={selected}
                        client={client}
                        onRan={applyMacro}
                        allowCreate={session.role !== "administrator"}
                      />
                    </details>
                    <ResolveTicket
                      key={`resolve-${selected.id}`}
                      session={session}
                      conversation={selected}
                      client={client}
                      onResolved={(next) => dispatch({ type: "resolved", ...next })}
                    />
                  </div>
                </header>
                <ol className="log" role="log" ref={logRef}>
                  {(state.messages[selected.id] || []).map((m) => (
                    <li
                      key={m.id}
                      data-sender={m.senderType}
                      data-private={m.private ? "true" : undefined}
                      data-status={m.status}
                      className={bubbleClass(m)}
                    >
                      {m.private ? (
                        <span className="note-caption">🔒 내부 메모 (상담원에게만 보임)</span>
                      ) : null}
                      {m.contentType === "form" ? (
                        <ApprovalCard
                          message={m}
                          onApprove={(card) => {
                            if (!client.approveTool) {
                              return;
                            }
                            client.approveTool({
                              gatewayUrl: session.gatewayUrl,
                              accountId: session.accountId,
                              token: session.token,
                              conversationId: selected.id,
                              executionId: card.execution_id,
                            });
                          }}
                        />
                      ) : (
                        m.content
                      )}
                      {(m.attachments || []).map((a) => {
                        const name = a.file_name || a.filename || fileName(a.external_url) || "첨부";
                        return (
                          <a
                            key={a.id || a.external_url}
                            className="attach-card"
                            href={a.external_url}
                          >
                            {isImageAttachment(a) ? (
                              <img className="attach-thumb" src={a.external_url} alt={name} />
                            ) : (
                              <span className="attach-icon" aria-hidden="true">
                                📄
                              </span>
                            )}
                            {name}
                            {a.file_size != null ? ` (${formatFileSize(a.file_size)})` : null}
                            {" 열기"}
                          </a>
                        );
                      })}
                      {m.status === "failed" ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => retrySend(selected, m)}>
                          재전송
                        </Button>
                      ) : null}
                      {m.createdAt || m.senderType === "User" ? (
                        <span className="bubble-meta">
                          {formatClock(m.createdAt)}
                          {m.senderType === "User"
                            ? m.status === "sending"
                              ? " · 전송 중"
                              : m.status === "failed"
                                ? " · 전송 실패"
                                : m.private
                                  ? ""
                                  : " · 전송됨"
                            : ""}
                        </span>
                      ) : null}
                    </li>
                  ))}
                  {state.typing?.[selected.id] && state.typing[selected.id].userId !== session.userId ? (
                    <li data-typing="true">입력 중</li>
                  ) : null}
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
                  {composeMode === "note" ? (
                    <InternalNote key={`note-${selected.id}`} onSend={queueNote} />
                  ) : (
                    <form className="composer" onSubmit={onSubmit}>
                      {cannedHits.length > 0 ? (
                        <ul id="canned-list" role="listbox" aria-label="저장응답" className="canned-pop">
                          {cannedHits.map((item, i) => (
                            <li
                              key={item.id || item.short_code}
                              id={cannedOptionId(item)}
                              role="option"
                              aria-selected={i === activeCanned}
                              className={`canned-opt${i === activeCanned ? " canned-opt-active" : ""}`}
                              onClick={() => insertCanned(item)}
                            >
                              /{item.short_code}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <Textarea
                        aria-label="답장"
                        placeholder="/ 를 입력해 저장응답 삽입"
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded={cannedHits.length > 0}
                        aria-controls={cannedHits.length ? "canned-list" : undefined}
                        aria-activedescendant={
                          cannedHits.length ? cannedOptionId(cannedHits[activeCanned]) : undefined
                        }
                        value={draft}
                        onChange={(e) => {
                          setDraft(e.target.value);
                          bumpTyping();
                        }}
                        onKeyDown={(e) => {
                          if (!cannedHits.length) {
                            return;
                          }
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setCannedIndex((i) => Math.min(cannedHits.length - 1, i + 1));
                            return;
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setCannedIndex((i) => Math.max(0, i - 1));
                            return;
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setDraft(draft.replace(/(^|\s)\/[^\s]*$/, "$1").trimEnd());
                            return;
                          }
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.metaKey &&
                            !e.ctrlKey
                          ) {
                            e.preventDefault();
                            insertCanned(cannedHits[activeCanned]);
                          }
                        }}
                      />
                      <Button type="submit">보내기</Button>
                    </form>
                  )}
                </div>
              </>
            )}
          </section>
          ) : null}
          {showContext ? (
          <aside
            className="context-pane"
            role={layout === "laptop" ? "dialog" : undefined}
            aria-label={layout === "laptop" ? "고객 정보" : undefined}
          >
            {selected ? (
              <>
                <section className="context-card" aria-label="고객 프로필">
                  <p>{selected.contactName || "고객"}</p>
                  {selected.contactEmail ? <p>{selected.contactEmail}</p> : null}
                </section>
                <TicketLabels
                  key={`labels-${selected.id}`}
                  session={session}
                  conversation={selected}
                  client={client}
                  onLabeled={(next) => dispatch({ type: "labeled", ...next })}
                  onUnlabeled={(next) => dispatch({ type: "unlabeled", ...next })}
                />
                <LivingProfile nodes={ego} />
                <section className="context-card" aria-label="채널 상태">
                  {selected.channel ? <p>채널 {channelLabel(selected.channel)}</p> : null}
                  {selected.channel === "email" && selected.displayId ? (
                    <p>#REQ-{selected.displayId}</p>
                  ) : null}
                  {selected.channel === "kakao"
                    ? kakaoSessionLine(state.messages[selected.id] || [])
                    : null}
                  {selected.appliedSlas?.frtDueAt ? (
                    <p>FRT {slaRemain(selected.appliedSlas.frtDueAt)}</p>
                  ) : null}
                  {selected.appliedSlas?.nrtDueAt ? (
                    <p>NRT {slaRemain(selected.appliedSlas.nrtDueAt)}</p>
                  ) : null}
                  {selected.appliedSlas?.rtDueAt ? (
                    <p>RT {slaRemain(selected.appliedSlas.rtDueAt)}</p>
                  ) : null}
                  {selected.slaBreached ? <Badge variant="destructive">SLA</Badge> : <p>SLA 충족</p>}
                </section>
              </>
            ) : null}
          </aside>
          ) : null}
        </>
      )}
    </div>
  );
}

function agentInitials(session: Session) {
  const name = (session.name || "").trim();
  if (name) {
    const parts = name.split(/\s+/);
    return ((parts[0][0] || "") + (parts[1]?.[0] || "")).toUpperCase();
  }
  const email = (session.email || "").trim();
  return email ? email[0].toUpperCase() : "A";
}

function layoutFor(width: number) {
  if (width >= 1280) {
    return "desktop";
  }
  if (width >= 1024) {
    return "laptop";
  }
  return "mobile";
}

function statusBadge(status?: string) {
  if (status === "open" || status === "unassigned") {
    return <Badge className="bg-emerald-50 text-emerald-700">{status}</Badge>;
  }
  if (status === "pending") {
    return <Badge className="bg-amber-50 text-amber-700">{status}</Badge>;
  }
  if (status === "snoozed") {
    return <Badge className="bg-slate-100 text-slate-600">{status}</Badge>;
  }
  return <Badge variant="secondary">{status}</Badge>;
}

function kakaoSessionLine(messages: Message[]) {
  const last = [...messages].reverse().find((m) => m.senderType === "Contact" && m.createdAt);
  if (!last) {
    return null;
  }
  const label = kakaoSessionLabel(last.createdAt);
  if (!label) {
    return null;
  }
  const warn = /(만료|[123]일 남음)/.test(label);
  return <Badge variant={warn ? "destructive" : "secondary"}>{label}</Badge>;
}

function closeOtherMenus(e: { currentTarget: HTMLDetailsElement }) {
  if (!e.currentTarget.open) {
    return;
  }
  const root = e.currentTarget.parentElement;
  if (!root) {
    return;
  }
  for (const el of root.querySelectorAll("details.header-menu")) {
    if (el !== e.currentTarget) {
      (el as HTMLDetailsElement).open = false;
    }
  }
}

function bubbleClass(m: Message) {
  const sending = m.status === "sending" ? " bubble-sending opacity-70" : "";
  if (m.private) {
    return `bubble bubble-note${sending}`;
  }
  if (m.senderType === "Contact") {
    return `bubble bubble-in bg-slate-100 text-slate-900${sending}`;
  }
  return `bubble bubble-out${sending}`;
}

function cannedOptionId(item: CannedItem) {
  return `canned-${item.id || item.short_code}`;
}

function formatFileSize(n: number) {
  if (n < 1024) {
    return `${n} B`;
  }
  return `${Math.round(n / 1024)} KB`;
}

function isImageAttachment(a: Attachment & { content_type?: string; filename?: string }) {
  const type = `${a.file_type || a.content_type || ""}`.toLowerCase();
  if (type.startsWith("image")) {
    return true;
  }
  const name = `${a.file_name || a.filename || a.external_url || ""}`.toLowerCase();
  return /\.(png|jpe?g|gif|webp|svg)(\?|$)/.test(name);
}

function fileName(url?: string) {
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
