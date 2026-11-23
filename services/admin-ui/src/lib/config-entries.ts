export type ConfigEntry = { key: string; value: string };

function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function formatValue(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** 키·값 행 → config 객체. 빈 키는 생략. */
export function configFromEntries(entries: ConfigEntry[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of entries) {
    const key = (row.key || '').trim();
    if (!key) continue;
    out[key] = parseValue(row.value ?? '');
  }
  return out;
}

/** config 객체 → 편집 행. 비어 있으면 한 줄 placeholder. */
export function entriesFromConfig(
  config: Record<string, unknown> | null | undefined
): ConfigEntry[] {
  const keys = Object.keys(config || {});
  if (keys.length === 0) return [{ key: '', value: '' }];
  return keys.map((key) => ({
    key,
    value: formatValue((config as Record<string, unknown>)[key]),
  }));
}
