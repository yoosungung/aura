import { useEffect, useReducer, useState } from "react";
import { emptyState, reduce } from "./store.js";

export function App({ session, client, initialState = emptyState }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [draft, setDraft] = useState("");
  const selected = state.conversations.find((c) => c.id === state.selectedId);

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

  if (!session.token && !session.fixture) {
    return <p>User 토큰이 필요합니다. <code>?account_id=&amp;token=</code></p>;
  }

  return (
    <div className="workspace">
      <nav className="queue" aria-label="대기열">
        <h1>대기열</h1>
        {state.conversations.length === 0 ? (
          <p>대기 중인 대화가 없습니다</p>
        ) : (
          <ul>
            {state.conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  aria-current={c.id === state.selectedId ? "true" : undefined}
                  onClick={() => dispatch({ type: "select", id: c.id })}
                >
                  {c.lastContent}
                  {c.unread > 0 ? <span> {c.unread}</span> : null}
                </button>
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
            <ol className="log" role="log">
              {(state.messages[selected.id] || []).map((m) => (
                <li key={m.id} data-sender={m.senderType}>
                  {m.content}
                </li>
              ))}
            </ol>
            <form className="composer" onSubmit={onSubmit}>
              <input
                aria-label="답장"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button type="submit">보내기</button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
