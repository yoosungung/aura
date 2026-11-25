import { describe, expect, it, vi, afterEach } from 'vitest';
import { triggerBundleDownload } from './bundle-download';

describe('triggerBundleDownload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates an object URL from base64 content', () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    const el = { click, href: '', download: '' };
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('atob', () => 'hello-factory');
    vi.stubGlobal('document', {
      createElement: vi.fn(() => el),
    });

    triggerBundleDownload({
      filename: 'agent-demo-1.0.0.bundle',
      content_base64: 'aGVsbG8tZmFjdG9yeQ==',
    });

    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    expect(el.download).toBe('agent-demo-1.0.0.bundle');
  });

  it('rejects missing content', () => {
    expect(() => triggerBundleDownload({})).toThrow(/bundle_content_missing/);
  });
});
