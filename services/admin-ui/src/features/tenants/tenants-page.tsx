import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CopyableId } from '@/components/copyable-id';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminApi } from '@/hooks/use-admin-api';
import { formatTenantLabel, shortId } from '@/lib/display';
import { formatApiError } from '@/lib/errors';
import { uuidSchema } from '@/lib/schemas';
import { normalizeTenantList } from '@/lib/tenants';
import { useSession } from '@/stores/session';
import { useToast } from '@/stores/toast';

export function TenantsPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const setTenantId = useSession((s) => s.setTenantId);
  const pushToast = useToast((s) => s.push);
  const qc = useQueryClient();
  const [manual, setManual] = useState('');
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [renameName, setRenameName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tenantsQuery = useQuery({
    queryKey: ['tenants'],
    queryFn: async () => {
      const r = await api.get('/v1/tenants');
      if (r.status >= 400) throw new Error(formatApiError(r));
      return normalizeTenantList(r.body);
    },
  });

  const upsert = useMutation({
    mutationFn: async (body: { id: string; display_name: string }) => {
      const r = await api.post('/v1/tenants', body);
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body;
    },
    onSuccess: (_body, vars) => {
      pushToast(`Saved ${vars.display_name}`, 'success');
      qc.invalidateQueries({ queryKey: ['tenants'] });
      setTenantId(vars.id);
      setNewId('');
      setNewName('');
      setRenameName('');
    },
    onError: (e) => pushToast(formatApiError(e), 'error'),
  });

  const rename = useMutation({
    mutationFn: async (body: { id: string; display_name: string }) => {
      const r = await api.patch(`/v1/tenants/${encodeURIComponent(body.id)}`, {
        display_name: body.display_name,
      });
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body;
    },
    onSuccess: (_b, vars) => {
      pushToast(`Renamed ${vars.display_name}`, 'success');
      qc.invalidateQueries({ queryKey: ['tenants'] });
    },
    onError: (e) => pushToast(formatApiError(e), 'error'),
  });

  function applyTenant(value: string) {
    const parsed = uuidSchema.safeParse(value.trim());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || 'invalid tenant');
      return;
    }
    setError(null);
    setTenantId(parsed.data);
    pushToast(`Tenant ${shortId(parsed.data)}`, 'success');
  }

  function saveNew() {
    const id = uuidSchema.safeParse(newId.trim());
    if (!id.success) {
      setError(id.error.issues[0]?.message || 'invalid tenant');
      return;
    }
    if (!newName.trim()) {
      setError('display_name required');
      return;
    }
    setError(null);
    upsert.mutate({ id: id.data, display_name: newName.trim() });
  }

  function saveRename() {
    if (!tenantId) return;
    if (!renameName.trim()) {
      setError('display_name required');
      return;
    }
    setError(null);
    rename.mutate({ id: tenantId, display_name: renameName.trim() });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tenant</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-neutral-600">
          Header switcher uses this list. Register a display name in{' '}
          <code>tenant_meta</code>, or paste a UUID (does not create a row until you save a name).
        </p>
        {tenantsQuery.isError && (
          <p className="text-sm text-red-600">{formatApiError(tenantsQuery.error)}</p>
        )}
        <div className="space-y-1">
          <Label>From list</Label>
          <ul className="divide-y rounded-md border border-neutral-200 bg-white text-sm">
            {(tenantsQuery.data || []).map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-neutral-50"
                  onClick={() => applyTenant(t.id)}
                >
                  <span title={t.id}>{formatTenantLabel(t)}</span>
                  {tenantId === t.id ? (
                    <span className="text-xs text-emerald-700">active</span>
                  ) : null}
                </button>
              </li>
            ))}
            {(tenantsQuery.data || []).length === 0 && !tenantsQuery.isLoading ? (
              <li className="px-3 py-2 text-neutral-500">No tenants yet.</li>
            ) : null}
          </ul>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2 rounded-md border border-neutral-200 p-3">
            <Label>Register / upsert alias</Label>
            <Input
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              placeholder="tenant UUID"
            />
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="display name"
            />
            <Button type="button" onClick={saveNew} disabled={upsert.isPending}>
              Save alias
            </Button>
          </div>
          <div className="space-y-2 rounded-md border border-neutral-200 p-3">
            <Label>Rename active tenant</Label>
            <p className="text-xs text-neutral-500">
              Active: {tenantId ? <CopyableId value={tenantId} /> : '(none)'}
            </p>
            <Input
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              placeholder="new display name"
              disabled={!tenantId}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!tenantId || rename.isPending}
              onClick={saveRename}
            >
              Rename
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="tenant-input">Advanced · paste full UUID</Label>
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
      </CardContent>
    </Card>
  );
}
