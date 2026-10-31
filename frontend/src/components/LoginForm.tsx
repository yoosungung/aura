import { useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "./ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.jsx";
import { Input } from "./ui/input.jsx";
import { Label } from "./ui/label.jsx";
import type { HelpdeskClient } from "../gateway.js";

type LoginFormProps = {
  client: Partial<HelpdeskClient>;
  gatewayUrl?: string;
  onSuccess: (session: {
    token: string;
    accountId: string;
    role?: string;
    inboxIds?: string[];
    userId?: string;
    name?: string;
    email?: string;
  }) => void;
};

export function LoginForm({ client, gatewayUrl, onSuccess }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setPending(true);
    try {
      const signIn = client.signIn;
      if (!signIn) {
        throw new Error("signIn missing");
      }
      const data = await signIn({ gatewayUrl, email, password });
      onSuccess({
        token: data.access_token,
        accountId: data.user.account_id,
        role: data.user.role,
        inboxIds: data.user.inbox_ids || [],
        userId: data.user.id,
        name: data.user.name,
        email: data.user.email,
      });
    } catch {
      setError("이메일 또는 비밀번호가 올바르지 않습니다");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="mx-auto mt-24 w-full max-w-sm">
      <CardHeader>
        <CardTitle>로그인</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-label="로그인">
          <Label>
            이메일
            <Input
              type="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              required
            />
          </Label>
          <Label>
            비밀번호
            <Input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
              required
            />
          </Label>
          {error ? <p role="alert">{error}</p> : null}
          <Button type="submit" disabled={pending}>
            로그인
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
