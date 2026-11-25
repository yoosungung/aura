import { describe, expect, it } from 'vitest';
import { normalizeTenantList } from './tenants';

describe('normalizeTenantList', () => {
  it('accepts object rows and legacy string ids', () => {
    expect(
      normalizeTenantList({
        tenants: [
          { id: '11111111-1111-4111-8111-111111111111', display_name: 'Acme' },
          '22222222-2222-4222-8222-222222222222',
        ],
      })
    ).toEqual([
      { id: '11111111-1111-4111-8111-111111111111', display_name: 'Acme' },
      { id: '22222222-2222-4222-8222-222222222222', display_name: null },
    ]);
  });
});
