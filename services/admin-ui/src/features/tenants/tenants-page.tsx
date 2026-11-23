import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CopyableId } from '@/components/copyable-id';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminApi } from '@/hooks/use-admin-api';
import { shortId } from '@/lib/display';
import { uuidSchema } from '@/lib/schemas';
import { useSession } from '@/stores/session';

export function TenantsPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const setTenantId = useSession((s) => s.setTenantId);
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tenantsQuery = useQuery({
    queryKey: ['tenants'],
    queryFn: async () => {
      const r = await api.get<{ tenants: string[] }>('/v1/tenants');
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
      return r.body.tenants || [];
    },
  });

  function applyTenant(value: string) {
    const parsed = uuidSchema.safeParse(value.trim());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || 'invalid tenant');
      return;
    }
    setError(null);
    setTenantId(parsed.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tenant picker</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            id="btn-load-tenants"
            type="button"
            onClick={() => tenantsQuery.refetch()}
          >
            Load tenants
          </Button>
        </div>
        {tenantsQuery.isError && (
          <p className="text-sm text-red-600">{String(tenantsQuery.error)}</p>
        )}
        <div className="space-y-1">
          <Label htmlFor="tenant-select">From list</Label>
          <select
            id="tenant-select"
            className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm"
            value={tenantId || ''}
            onChange={(e) => applyTenant(e.target.value)}
          >
            <option value="">(select)</option>
            {(tenantsQuery.data || []).map((t) => (
              <option key={t} value={t} title={t}>
                {shortId(t)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="tenant-input">Or paste full UUID</Label>
          <div className="flex gap-2">
            <Input
              id="tenant-input"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            />
            <Button id="btn-set-tenant" type="button" onClick={() => applyTenant(manual)}>
              Use
            </Button>
          </div>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <p className="flex items-center gap-2 text-sm text-neutral-600">
          Active: {tenantId ? <CopyableId value={tenantId} /> : <code>(none)</code>}
        </p>
      </CardContent>
    </Card>
  );
}
