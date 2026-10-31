import { useEffect, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";

export function SkillSettings({ session, client }) {
  const [skills, setSkills] = useState([]);
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

  async function onCreate(e) {
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

  return (
    <section className="catalog" aria-label="Agent Skills">
      <h2>Agent Skills</h2>
      <ul>
        {skills.map((s) => (
          <li key={s.id || s.name}>{s.name}</li>
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
