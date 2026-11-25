import { describe, expect, it } from 'vitest';
import {
  auditListSchema,
  createCustomSourceSchema,
  createSourceSchema,
  overlaySchema,
  reasonSchema,
  sessionSchema,
  uuidSchema,
} from './schemas';

describe('schemas', () => {
  it('accepts session with bearer and baseUrl', () => {
    const parsed = sessionSchema.parse({
      bearer: 'ops-token',
      baseUrl: 'http://localhost:8080',
    });
    expect(parsed.bearer).toBe('ops-token');
  });

  it('validates tenant UUID', () => {
    expect(() => uuidSchema.parse('not-a-uuid')).toThrow();
    expect(
      uuidSchema.parse('11111111-1111-4111-8111-111111111111')
    ).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('rejects runtime key inside source config', () => {
    const result = createSourceSchema.safeParse({
      kind: 'agent',
      name: 'help',
      version: '1.0.0',
      entrypoint: 'mod:main',
      bundle_uri: 's3://aura-content/tenants/t/bundles/a',
      checksum: 'sha256:' + 'a'.repeat(64),
      config: { runtime: 'python' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts custom Function registration without bundle fields', () => {
    const parsed = createCustomSourceSchema.parse({
      kind: 'agent',
      name: 'help',
      version: '1.0.0',
      function: 'aura-agent-invoke-help',
      runtime: 'custom',
    });
    expect(parsed.runtime).toBe('custom');
    expect(parsed.function).toBe('aura-agent-invoke-help');
  });

  it('rejects custom Function without allowlisted prefix', () => {
    expect(
      createCustomSourceSchema.safeParse({
        kind: 'agent',
        name: 'help',
        version: '1.0.0',
        function: 'my-fn',
        runtime: 'custom',
      }).success
    ).toBe(false);
  });

  it('rejects plaintext secrets on overlay', () => {
    const result = overlaySchema.safeParse({
      principal_id: 'user-1',
      config: {},
      secrets_ref: 'vault:path',
      secret_value: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('requires reason for retire/delete', () => {
    expect(reasonSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(reasonSchema.safeParse({ reason: 'superseded' }).success).toBe(true);
  });

  it('parses audit list envelope', () => {
    const parsed = auditListSchema.parse({
      items: [
        {
          id: 'a1',
          actor: 'ops',
          action: 'source.activate',
          resource_type: 'source_meta',
          resource_id: 's1',
          reason: null,
          at: '2026-11-20T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    expect(parsed.items).toHaveLength(1);
  });
});
