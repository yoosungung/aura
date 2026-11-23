import { describe, expect, it, vi } from 'vitest';
import { putBundle, sha256Checksum } from './bundle-upload';

describe('bundle-upload', () => {
  it('hashes blob bytes as sha256:<hex>', async () => {
    const bytes = new TextEncoder().encode('aura-bundle');
    const got = await sha256Checksum(new Blob([bytes]));
    expect(got).toBe(
      'sha256:7bee3f1cba03d7b5193b55e871cfe44911c15e99e08b650fbc904f22921fa9e6'
    );
  });

  it('PUTs file with presign headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const file = new File([new Uint8Array([1, 2, 3])], 'b.zip', {
      type: 'application/zip',
    });
    await putBundle('https://garage.test/put', file, {
      'content-type': 'application/zip',
      'x-amz-meta-aura': '1',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://garage.test/put', {
      method: 'PUT',
      body: file,
      headers: {
        'content-type': 'application/zip',
        'x-amz-meta-aura': '1',
      },
    });
    vi.unstubAllGlobals();
  });

  it('rejects non-ok PUT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' })
    );
    await expect(
      putBundle('https://garage.test/put', new Blob(['x']), {})
    ).rejects.toThrow(/403/);
    vi.unstubAllGlobals();
  });
});
