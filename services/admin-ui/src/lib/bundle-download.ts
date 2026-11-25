export type BundleDownloadBody = {
  filename?: string;
  content_base64?: string;
  checksum?: string;
  byte_length?: number;
};

/** Decode Admin `GET …/bundle` JSON into a browser download. */
export function triggerBundleDownload(body: BundleDownloadBody): void {
  const b64 = body.content_base64;
  if (!b64) throw new Error('bundle_content_missing');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = body.filename || 'source.bundle';
  a.click();
  URL.revokeObjectURL(url);
}
