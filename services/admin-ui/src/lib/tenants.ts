export type TenantRow = {
  id: string;
  display_name: string | null;
};

export function normalizeTenantList(body: unknown): TenantRow[] {
  const raw = (body as { tenants?: unknown })?.tenants;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') {
        return { id: item, display_name: null };
      }
      if (item && typeof item === 'object' && typeof (item as TenantRow).id === 'string') {
        const row = item as TenantRow;
        return {
          id: row.id,
          display_name:
            typeof row.display_name === 'string' && row.display_name.trim()
              ? row.display_name.trim()
              : null,
        };
      }
      return null;
    })
    .filter((t): t is TenantRow => !!t);
}
