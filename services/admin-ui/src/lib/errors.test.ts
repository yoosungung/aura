import { describe, expect, it } from 'vitest';
import { formatApiError } from './errors';

describe('formatApiError', () => {
  it('prefers body.error string', () => {
    expect(formatApiError({ status: 422, body: { error: 'checksum_mismatch' } })).toBe(
      'checksum_mismatch (422)'
    );
  });

  it('does not dump raw JSON objects as the primary message', () => {
    const msg = formatApiError({
      status: 409,
      body: { error: 'source_not_pending', detail: { id: 'x' } },
    });
    expect(msg).toBe('source_not_pending (409)');
    expect(msg).not.toMatch(/^\{/);
  });

  it('falls back for Error and unknown', () => {
    expect(formatApiError(new Error('boom'))).toBe('boom');
    expect(formatApiError('plain')).toBe('plain');
    expect(formatApiError(null)).toBe('request_failed');
  });

  it('uses status when body has no error field', () => {
    expect(formatApiError({ status: 500, body: {} })).toBe('request_failed (500)');
  });
});
