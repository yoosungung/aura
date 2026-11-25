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

type TenantCreated = { tenant?: { id?: string; display_name?: string } };

export function TenantsPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const setTenantId = useSession((s) => s.setTenantId);
  const pushToast = useToast((s) => s.push);
  const qc = useQueryClient();
  const [manual, setManual] = useState('');
  const [newName, setNewName] = useState('');
  const [customId, setCustomId] = useState('');
  const [showCustomId, setShowCustomId] = useState(false);
  const [renameName, setRenameName] = useState('');
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tenantsQuery = useQuery({
    queryKey: ['tenants'],
    queryFn: async () => {
      const r = await api.get('/v1/tenants');
      if (r.status >= 400) throw new Error(formatApiError(r));
      return normalizeTenantList(r.body);
    },
  });

  const create = useMutation({
    mutationFn: async (body: { display_name: string; id?: string }) => {
      const r = await api.post<TenantCreated>('/v1/tenants', body);
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body;
    },
    onSuccess: (body) => {
      const id = body?.tenant?.id;
      const name = body?.tenant?.display_name || newName.trim();
      pushToast(id ? `Created ${name} · ${shortId(id)}` : `Saved ${name}`, 'success');
      qc.invalidateQueries({ queryKey: ['tenants'] });
      if (id) {
        setTenantId(id);
        setLastCreatedId(id);
      }
      setNewName('');
      setCustomId('');
      setShowCustomId(false);
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
    if (!newName.trim()) {
      setError('display_name required');
      return;
    }
    if (showCustomId && customId.trim()) {
      const id = uuidSchema.safeParse(customId.trim());
      if (!id.success) {
        setError(id.error.issues[0]?.message || 'invalid tenant');
        return;
      }
      setError(null);
      create.mutate({ display_name: newName.trim(), id: id.data });
      return;
    }
    setError(null);
    create.mutate({ display_name: newName.trim() });
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
          Create with a display name — UUID is generated server-side. Paste a UUID only to
          select an existing tenant without creating a row.
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
            <Label htmlFor="tenant-create-name">Create tenant</Label>
            <Input
              id="tenant-create-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="display name"
            />
            <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-600">
              <input
                type="checkbox"
                checked={showCustomId}
                onChange={(e) => setShowCustomId(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-neutral-300"
              />
              Advanced · set UUID manually
            </label>
            {showCustomId ? (
              <Input
                id="tenant-create-id"
                value={customId}
                onChange={(e) => setCustomId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
            ) : null}
            <Button
              id="btn-create-tenant"
              type="button"
              onClick={saveNew}
              disabled={create.isPending}
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
            {lastCreatedId ? (
              <p className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
                Last created: <CopyableId value={lastCreatedId} />
              </p>
            ) : null}
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
          <Label htmlFor="tenant-input">Advanced · paste full UUID to select</Label>
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
