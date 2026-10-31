import { useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button.jsx";
import type { HelpdeskClient } from "../gateway.js";
import type { Session } from "../store.js";

type AccountUser = {
  id: string;
  name?: string;
  email?: string;
  role?: string;
};

type InboxChoice = { id: string; name?: string };

type InboxMembersProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
};

function userLabel(user: AccountUser) {
  return user.name || user.email || user.id;
}

function cellKey(userId: string, inboxId: string) {
  return `${userId}:${inboxId}`;
}

function rowDirty(userId: string, inboxIds: string[], draft: Set<string>, baseline: Set<string>) {
  return inboxIds.some((inboxId) => {
    const key = cellKey(userId, inboxId);
    return draft.has(key) !== baseline.has(key);
  });
}

export function InboxMembers({ session, client }: InboxMembersProps) {
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [boxes, setBoxes] = useState<InboxChoice[]>([]);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [baseline, setBaseline] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const listInboxes = client.listInboxes;
    const listInboxMembers = client.listInboxMembers;
    const listAccountUsers = client.listAccountUsers;
    if (!listInboxes && !listInboxMembers && !listAccountUsers) {
      return undefined;
    }
    let cancelled = false;
    const req = {
      gatewayUrl: session.gatewayUrl,
      accountId: session.accountId,
      token: session.token,
    };
    (async () => {
      const boxRows = listInboxes
        ? await listInboxes(req).catch(() => ({ inboxes: [] as InboxChoice[] }))
        : { inboxes: [] as InboxChoice[] };
      const nextBoxes: InboxChoice[] = (boxRows?.inboxes || [])
        .filter((row: InboxChoice) => Boolean(row.id))
        .map((row: InboxChoice) => ({ id: row.id, name: row.name }));
      const ids = [...new Set([...nextBoxes.map((box) => box.id), ...(session.inboxIds || [])].filter(Boolean))];
      const memberRows = listInboxMembers
        ? await Promise.all(
            ids.map((id) =>
              listInboxMembers({ ...req, inboxId: id })
                .then((data) => ({ id, members: data?.members || [] }))
                .catch(() => ({ id, members: [] as { user_id?: string; name?: string; email?: string }[] })),
            ),
          )
        : [];
      const nextDraft = new Set<string>();
      const directory = new Map<string, AccountUser>();
      for (const row of memberRows) {
        for (const member of row.members) {
          if (!member.user_id) {
            continue;
          }
          nextDraft.add(cellKey(member.user_id, row.id));
          if (!directory.has(member.user_id)) {
            directory.set(member.user_id, {
              id: member.user_id,
              name: member.name,
              email: member.email,
            });
          }
        }
      }
      let nextUsers: AccountUser[] = [];
      if (listAccountUsers) {
        const data = await listAccountUsers(req).catch(() => ({ users: [] as AccountUser[] }));
        nextUsers = (data?.users || []).filter((row: AccountUser) => row.id);
      }
      if (nextUsers.length === 0) {
        nextUsers = [...directory.values()];
      }
      if (cancelled) {
        return;
      }
      setBoxes(nextBoxes.length > 0 ? nextBoxes : ids.map((id) => ({ id, name: id })));
      setUsers(nextUsers);
      setDraft(nextDraft);
      setBaseline(new Set(nextDraft));
      setSelected(new Set());
    })();
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  const inboxIds = useMemo(() => boxes.map((box) => box.id), [boxes]);
  const dirtyIds = useMemo(
    () => users.filter((user) => rowDirty(user.id, inboxIds, draft, baseline)).map((user) => user.id),
    [users, inboxIds, draft, baseline],
  );
  const canSave = dirtyIds.some((id) => selected.has(id));

  function toggleMembership(userId: string, inboxId: string) {
    const key = cellKey(userId, inboxId);
    const next = new Set(draft);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setDraft(next);
    setSelected((prev) => {
      const copy = new Set(prev);
      if (rowDirty(userId, inboxIds, next, baseline)) {
        copy.add(userId);
      } else {
        copy.delete(userId);
      }
      return copy;
    });
  }

  function toggleSave(userId: string) {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (copy.has(userId)) {
        copy.delete(userId);
      } else {
        copy.add(userId);
      }
      return copy;
    });
  }

  async function onSave() {
    if (!canSave) {
      return;
    }
    setError("");
    setSaving(true);
    const ops: Promise<unknown>[] = [];
    for (const user of users) {
      if (!selected.has(user.id) || !rowDirty(user.id, inboxIds, draft, baseline)) {
        continue;
      }
      for (const inboxId of inboxIds) {
        const key = cellKey(user.id, inboxId);
        const now = draft.has(key);
        const was = baseline.has(key);
        if (now === was) {
          continue;
        }
        const req = {
          gatewayUrl: session.gatewayUrl,
          accountId: session.accountId,
          token: session.token,
          inboxId,
          userId: user.id,
        };
        if (now && client.addInboxMember) {
          ops.push(client.addInboxMember(req));
        } else if (!now && client.removeInboxMember) {
          ops.push(client.removeInboxMember(req));
        }
      }
    }
    try {
      await Promise.all(ops);
      setBaseline(new Set(draft));
      setSelected(new Set());
    } catch {
      setError("저장하지 못했습니다");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-resource members" aria-label="인박스 멤버">
      <h2>인박스 멤버</h2>
      <p className="settings-item-meta">계정 사용자를 인박스에 연결합니다. 배속을 바꾼 사용자만 이름 앞에 체크가 생기고, 체크된 사용자만 저장합니다.</p>
      {error ? <p role="alert">{error}</p> : null}
      {users.length === 0 || boxes.length === 0 ? (
        <p className="settings-item-meta">{boxes.length === 0 ? "인박스가 없습니다" : "계정 사용자가 없습니다"}</p>
      ) : (
        <div className="members-table-wrap">
          <table className="members-table">
            <thead>
              <tr>
                <th scope="col">사용자</th>
                {boxes.map((box) => (
                  <th key={box.id} scope="col">
                    {box.name || box.id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const name = userLabel(user);
                const dirty = rowDirty(user.id, inboxIds, draft, baseline);
                return (
                  <tr key={user.id}>
                    <th scope="row">
                      <span className="members-user">
                        {dirty ? (
                          <input
                            type="checkbox"
                            checked={selected.has(user.id)}
                            onChange={() => toggleSave(user.id)}
                            aria-label={`${name} 저장`}
                          />
                        ) : (
                          <span className="members-user-spacer" aria-hidden="true" />
                        )}
                        <span>
                          <span className="members-user-name">{name}</span>
                          {user.email && user.name ? <span className="settings-item-meta">{user.email}</span> : null}
                        </span>
                      </span>
                    </th>
                    {boxes.map((box) => (
                      <td key={box.id}>
                        <input
                          type="checkbox"
                          checked={draft.has(cellKey(user.id, box.id))}
                          onChange={() => toggleMembership(user.id, box.id)}
                          aria-label={`${name} · ${box.name || box.id}`}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="settings-form-actions">
        <Button type="button" size="sm" onClick={onSave} disabled={!canSave || saving}>
          저장
        </Button>
      </div>
    </section>
  );
}
