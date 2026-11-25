export type ApiResult<T> = { status: number; body: T };

export type ApiClientOptions = {
  baseUrl?: string;
  bearer: string;
  tenantId?: string | null;
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => void;
};

export function getApiBaseUrl(): string {
  const raw =
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env.VITE_API_BASE_URL
      : '';
  return (raw || '').replace(/\/$/, '');
}

export function buildAuthHeaders(opts: {
  bearer: string;
  tenantId?: string | null;
}): Record<string, string> {
  const token = opts.bearer.startsWith('Bearer ')
    ? opts.bearer
    : `Bearer ${opts.bearer}`;
  const headers: Record<string, string> = {
    authorization: token,
    'content-type': 'application/json',
  };
  if (opts.tenantId) {
    headers['x-aura-tenant-id'] = opts.tenantId;
  }
  return headers;
}

export function createApiClient(opts: ApiClientOptions) {
  const fetchImpl = opts.fetchImpl || fetch;
  const base = (opts.baseUrl ?? getApiBaseUrl()).replace(/\/$/, '');

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>
  ): Promise<ApiResult<T>> {
    const qs = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null && v !== '') qs.set(k, v);
      }
    }
    const q = qs.toString();
    const url = `${base}${path}${q ? `?${q}` : ''}`;
    const res = await fetchImpl(url, {
      method,
      headers: buildAuthHeaders({
        bearer: opts.bearer,
        tenantId: opts.tenantId,
      }),
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      opts.onUnauthorized?.();
    }
    const text = await res.text();
    let json = {} as T;
    try {
      json = text ? (JSON.parse(text) as T) : ({} as T);
    } catch {
      json = { raw: text } as T;
    }
    return { status: res.status, body: json };
  }

  return {
    get: <T>(path: string, query?: Record<string, string | undefined>) =>
      request<T>('GET', path, undefined, query),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
    delete: <T>(path: string, body?: unknown) =>
      request<T>('DELETE', path, body),
  };
}
