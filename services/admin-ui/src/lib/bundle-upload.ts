function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Browser/Node SubtleCrypto SHA-256 → `sha256:<64 hex>` (activate 계약과 동일). */
export async function sha256Checksum(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('crypto.subtle unavailable (need https or localhost)');
  }
  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return `sha256:${toHex(digest)}`;
}

/** Presign `upload_url`로 Garage PUT. headers는 서버가 준 값을 그대로 전달. */
export async function putBundle(
  uploadUrl: string,
  body: Blob,
  headers: Record<string, string>
): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body,
    headers: { ...headers },
  });
  if (!res.ok) {
    throw new Error(`bundle upload failed: ${res.status} ${res.statusText || ''}`.trim());
  }
}
