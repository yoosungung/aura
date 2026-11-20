import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createApiClient, getApiBaseUrl } from '@/lib/api';
import { useSession } from '@/stores/session';

export function AuthModal() {
  const authError = useSession((s) => s.authError);
  const rememberDefault = useSession((s) => s.rememberSession);
  const setAuth = useSession((s) => s.setAuth);

  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(rememberDefault);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const displayError = error || authError;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError('Admin API Key is required.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const client = createApiClient({
        baseUrl: getApiBaseUrl(),
        bearer: trimmed,
      });
      const res = await client.get<{ tenants?: string[] }>('/v1/tenants');
      if (res.status === 200) {
        setAuth(trimmed, remember);
        return;
      }
      if (res.status === 401 || res.status === 403) {
        setError(`Invalid or unauthorized token (${res.status}).`);
        return;
      }
      setError(`Backend returned unexpected status (${res.status}).`);
    } catch {
      setError('Unable to reach control-admin server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/40 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader>
          <CardTitle id="auth-modal-title">Admin API Key</CardTitle>
          <CardDescription>
            Enter your ops Bearer token to verify access with control-admin.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="auth-modal-token">Bearer token</Label>
              <Input
                id="auth-modal-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ops-token"
                autoComplete="off"
                autoFocus
                disabled={submitting}
              />
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                disabled={submitting}
                className="h-4 w-4 rounded border-neutral-300"
              />
              Keep session in this browser
            </label>

            {displayError ? (
              <p
                role="alert"
                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                {displayError}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Verifying...' : 'Connect'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
