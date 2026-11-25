type ApiLike = {
  status?: number;
  body?: unknown;
};

function bodyError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const err = (body as { error?: unknown }).error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  return null;
}

/** Human-readable API/UI error — never JSON.stringify dump as primary text. */
export function formatApiError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err.trim();

  const api = err as ApiLike | null;
  if (api && typeof api === 'object') {
    const code = bodyError(api.body);
    if (code && typeof api.status === 'number') return `${code} (${api.status})`;
    if (code) return code;
    if (typeof api.status === 'number') return `request_failed (${api.status})`;
  }

  return 'request_failed';
}
