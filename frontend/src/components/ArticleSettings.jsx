import { useEffect, useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";

export function ArticleSettings({ session, client }) {
  const [articles, setArticles] = useState([]);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!client.listArticles) {
      return undefined;
    }
    let cancelled = false;
    client
      .listArticles({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
      })
      .then((data) => {
        if (!cancelled) {
          setArticles(data?.articles || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, session]);

  async function onCreate(e) {
    e.preventDefault();
    if (!client.createArticle || !title.trim() || !slug.trim() || !body.trim()) {
      return;
    }
    setError("");
    try {
      const created = await client.createArticle({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        title: title.trim(),
        slug: slug.trim(),
        body: body.trim(),
        published: true,
      });
      setArticles((prev) => [...prev, created]);
      setTitle("");
      setSlug("");
      setBody("");
    } catch {
      setError("문서를 만들지 못했습니다");
    }
  }

  return (
    <section className="settings-resource" aria-label="도움말">
      <h2>Help Center</h2>
      <ul className="settings-list">
        {articles.map((a) => (
          <li key={a.id || a.slug}>
            <span className="settings-item-main">{a.title}</span>
            {a.slug ? <span className="settings-item-meta">{a.slug}</span> : null}
          </li>
        ))}
      </ul>
      <form onSubmit={onCreate} className="flex flex-col gap-2">
        <Label>
          문서 제목
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </Label>
        <Label>
          slug
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} required />
        </Label>
        <Label>
          본문
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} required />
        </Label>
        <Button type="submit">문서 게시</Button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
