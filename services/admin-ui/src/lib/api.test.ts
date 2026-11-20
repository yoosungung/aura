import { describe, expect, it } from 'vitest';
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

  it('calls control-admin paths only', async () => {
    const calls: string[] = [];
    const client = createApiClient({
      baseUrl: 'http://control.test',
      bearer: 'ops',
      tenantId: '11111111-1111-4111-8111-111111111111',
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ tenants: [] }), { status: 200 });
      },
    });
    await client.get('/v1/tenants');
    await client.get('/v1/audit', { limit: '10' });
    expect(calls[0]).toContain('http://control.test/v1/tenants');
    expect(calls[1]).toContain('http://control.test/v1/audit?limit=10');
    expect(calls.join('')).not.toMatch(/aura\.rpc\.control\.resolve/);
  });
});
