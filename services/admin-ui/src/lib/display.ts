export function shortId(id: string): string {
  const value = (id || '').trim();
  if (!value) return '';
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export type SourceLabelInput = {
  kind: string;
  name: string;
  version: string;
  status: string;
};

export function formatSourceLabel(s: SourceLabelInput): string {
  return `${s.kind} / ${s.name} / ${s.version} · ${s.status}`;
}

export type TenantLabelInput = {
  id: string;
  display_name?: string | null;
};

/** Prefer display_name; fall back to shortId(id). */
export function formatTenantLabel(t: TenantLabelInput): string {
  const name = (t.display_name || '').trim();
  if (name) return name;
  return shortId(t.id);
}
