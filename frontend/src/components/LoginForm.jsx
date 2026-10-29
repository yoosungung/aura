import { useState } from "react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";

export function LoginForm({ client, gatewayUrl, onSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setPending(true);
    try {
      const data = await client.signIn({ gatewayUrl, email, password });
      onSuccess({
        token: data.access_token,
        accountId: data.user.account_id,
      });
    } catch {
      setError("이메일 또는 비밀번호가 올바르지 않습니다");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mx-auto mt-24 flex w-full max-w-sm flex-col gap-4 bg-white p-6 text-neutral-900"
      aria-label="로그인"
    >
      <h1 className="text-xl font-semibold">로그인</h1>
      <label className="flex flex-col gap-1 text-sm">
        이메일
        <Input
          type="email"
          name="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        비밀번호
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        로그인
      </Button>
    </form>
  );
}
