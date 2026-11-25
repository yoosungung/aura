import { describe, expect, it } from 'vitest';
import { formatSourceLabel, formatTenantLabel, shortId } from './display';

describe('display', () => {
  it('shortens UUID for humans', () => {
    expect(shortId('11111111-1111-4111-8111-111111111111')).toBe('11111111…1111');
    expect(shortId('')).toBe('');
    expect(shortId('abc')).toBe('abc');
  });

  it('formats source picker label without raw id', () => {
    expect(
      formatSourceLabel({
        kind: 'agent',
        name: 'helpdesk',
        version: '1.2.0',
        status: 'active',
      })
    ).toBe('agent / helpdesk / 1.2.0 · active');
  });

  it('prefers tenant display_name over shortId', () => {
    expect(
      formatTenantLabel({
        id: '11111111-1111-4111-8111-111111111111',
        display_name: 'Acme Lab',
      })
    ).toBe('Acme Lab');
    expect(
      formatTenantLabel({ id: '11111111-1111-4111-8111-111111111111', display_name: null })
    ).toBe('11111111…1111');
  });
});
