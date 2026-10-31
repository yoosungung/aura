import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";
import type { HelpdeskClient } from "../gateway.js";
import type { Session } from "../store.js";

type Article = { id?: string; slug?: string; title?: string; body?: string; published?: boolean };

type ArticleSettingsProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
};

export function ArticleSettings({ session, client }: ArticleSettingsProps) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState("");
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

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !slug.trim() || !body.trim()) {
      return;
    }
    setError("");
    try {
      if (editingId && client.updateArticle) {
        const updated = await client.updateArticle({
          gatewayUrl: session.gatewayUrl,
          accountId: session.accountId,
          token: session.token,
          article_id: editingId,
          title: title.trim(),
          slug: slug.trim(),
          body: body.trim(),
          published: true,
        });
        setArticles((prev) => prev.map((a) => (a.id === editingId ? { ...a, ...updated } : a)));
        setEditingId("");
        setTitle("");
        setSlug("");
        setBody("");
        return;
      }
      if (!client.createArticle) {
        return;
      }
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
      setError(editingId ? "문서를 수정하지 못했습니다" : "문서를 만들지 못했습니다");
    }
  }

  async function onDelete(article: Article) {
    if (!client.deleteArticle || !article?.id) {
      return;
    }
    setError("");
    try {
      await client.deleteArticle({
        gatewayUrl: session.gatewayUrl,
        accountId: session.accountId,
        token: session.token,
        article_id: article.id,
      });
      setArticles((prev) => prev.filter((a) => a.id !== article.id));
      if (editingId === article.id) {
        setEditingId("");
        setTitle("");
        setSlug("");
        setBody("");
      }
    } catch {
      setError("문서를 삭제하지 못했습니다");
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
            {client.updateArticle && a.id ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingId(a.id || "");
                  setTitle(a.title || "");
                  setSlug(a.slug || "");
                  setBody(a.body || "");
                }}
              >
                수정
              </Button>
            ) : null}
            {client.deleteArticle && a.id ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => onDelete(a)}>
                삭제
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <form onSubmit={onSave} className="flex flex-col gap-2">
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
        <Button type="submit">{editingId ? "문서 저장" : "문서 게시"}</Button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
