import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import { Textarea } from "./ui/textarea.jsx";
import type { HelpdeskClient } from "../gateway.js";
import { slugFromTitle } from "../lib/utils.js";
import type { Session } from "../store.js";

type Article = { id?: string; slug?: string; title?: string; body?: string; published?: boolean };

type ArticleSettingsProps = {
  session: Session;
  client: Partial<HelpdeskClient>;
};

export function ArticleSettings({ session, client }: ArticleSettingsProps) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [title, setTitle] = useState("");
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

  function resetForm() {
    setEditingId("");
    setTitle("");
    setBody("");
    setError("");
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const slug = slugFromTitle(title);
    if (!title.trim() || !slug || !body.trim()) {
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
          slug,
          body: body.trim(),
          published: true,
        });
        setArticles((prev) => prev.map((a) => (a.id === editingId ? { ...a, ...updated } : a)));
        resetForm();
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
        slug,
        body: body.trim(),
        published: true,
      });
      setArticles((prev) => [...prev, created]);
      setTitle("");
      setBody("");
    } catch {
      setError(editingId ? "문서를 수정하지 못했습니다" : "문서를 만들지 못했습니다");
    }
  }

  function selectArticle(article: Article) {
    setEditingId(article.id || "");
    setTitle(article.title || "");
    setBody(article.body || "");
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
        resetForm();
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="settings-item-main justify-start"
              aria-current={a.id && a.id === editingId ? "true" : undefined}
              onClick={() => selectArticle(a)}
            >
              {a.title}
            </Button>
            {a.slug ? <span className="settings-item-meta">{a.slug}</span> : null}
            {client.updateArticle && a.id ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => selectArticle(a)}>
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
          본문
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} required />
        </Label>
        <div className="settings-form-actions">
          {editingId ? (
            <Button type="button" size="sm" variant="secondary" onClick={resetForm}>
              취소
            </Button>
          ) : null}
          <Button type="submit" size="sm">
            {editingId ? "문서 저장" : "문서 게시"}
          </Button>
        </div>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
