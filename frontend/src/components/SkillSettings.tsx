import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";
import type { HelpdeskClient } from "../gateway.js";
import type { Session } from "../store.js";

type Skill = { id?: string; name?: string; description?: string; body?: string };

type SkillSettingsProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
};

export function SkillSettings({ session, client }: SkillSettingsProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!client.listSkills) {
      return undefined;
    }
    let cancelled = false;
    client
      .listSkills({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
      })
      .then((data) => {
        if (!cancelled) {
          setSkills(data?.agent_skills || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  function loadSkill(s: Skill) {
    setName(s.name || "");
    setDescription(s.description || "");
    setBody(s.body || "");
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!client.upsertSkill || !name.trim() || !body.trim()) {
      return;
    }
    setError("");
    try {
      const created = await client.upsertSkill({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        name: name.trim(),
        description: description.trim(),
        body: body.trim(),
      });
      setSkills((prev) => [...prev.filter((s) => s.name !== created.name), created]);
      setName("");
      setDescription("");
      setBody("");
    } catch {
      setError("스킬을 저장하지 못했습니다");
    }
  }

  async function onDelete(skill: Skill) {
    if (!client.deleteSkill || !skill?.id) {
      return;
    }
    setError("");
    try {
      await client.deleteSkill({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        skill_id: skill.id,
      });
      setSkills((prev) => prev.filter((s) => s.id !== skill.id));
      if (name === skill.name) {
        setName("");
        setDescription("");
        setBody("");
      }
    } catch {
      setError("스킬을 삭제하지 못했습니다");
    }
  }

  return (
    <section className="settings-resource" aria-label="Agent Skills">
      <h2>Agent Skills</h2>
      <ul className="settings-list">
        {skills.map((s) => (
          <li key={s.id || s.name}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="settings-item-main justify-start"
              onClick={() => loadSkill(s)}
            >
              {s.name}
            </Button>
            {s.description ? <span className="settings-item-meta">{s.description}</span> : null}
            {client.deleteSkill && s.id ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => onDelete(s)}>
                삭제
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <form onSubmit={onCreate} className="flex flex-col gap-2">
        <Label>
          스킬 이름
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Label>
        <Label>
          스킬 설명
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Label>
        <Label>
          스킬 본문
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} required />
        </Label>
        <Button type="submit">스킬 저장</Button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
