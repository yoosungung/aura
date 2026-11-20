import { describe, expect, it, vi } from 'vitest';
import { buildAuthHeaders, createApiClient } from './api';

describe('api client', () => {
  it('sends Authorization and X-Aura-Tenant-Id', async () => {
    const headers = buildAuthHeaders({
      bearer: 'ops-token',
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    expect(headers.authorization).toBe('Bearer ops-token');
    expect(headers['x-aura-tenant-id']).toBe(
      '11111111-1111-4111-8111-111111111111'
    );
  });

  it('calls control-admin paths only and supports same-origin relative URLs', async () => {
    const calls: string[] = [];
    const client = createApiClient({
      baseUrl: '',
      bearer: 'ops',
      tenantId: '11111111-1111-4111-8111-111111111111',
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ tenants: [] }), { status: 200 });
      },
    });
    await client.get('/v1/tenants');
    await client.get('/v1/audit', { limit: '10' });
    expect(calls[0]).toBe('/v1/tenants');
    expect(calls[1]).toBe('/v1/audit?limit=10');
    expect(calls.join('')).not.toMatch(/aura\.rpc\.control\.resolve/);
  });

  it('invokes onUnauthorized on 401 response', async () => {
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      baseUrl: '',
      bearer: 'expired-token',
      onUnauthorized,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
        }),
    });
    const res = await client.get('/v1/tenants');
    expect(res.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
