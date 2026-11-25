import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ConfigEntriesEditor } from '@/components/config-entries-editor';
import { Drawer } from '@/components/drawer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminApi } from '@/hooks/use-admin-api';
import {
  configFromEntries,
  entriesFromConfig,
  type ConfigEntry,
} from '@/lib/config-entries';
import { formatSourceLabel } from '@/lib/display';
import { formatApiError } from '@/lib/errors';
import { overlaySchema, reasonSchema, uuidSchema } from '@/lib/schemas';
import { useSession } from '@/stores/session';
import { useToast } from '@/stores/toast';

type SourceRow = {
  id: string;
  kind: string;
  name: string;
  version: string;
  status: string;
};

type OverlayRow = {
  id: string;
  principal_id: string;
  secrets_ref: string | null;
  updated_at?: string;
  config?: Record<string, unknown>;
};

type DrawerMode = 'create' | 'edit' | null;

export function OverlaysPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const qc = useQueryClient();
  const pushToast = useToast((s) => s.push);
  const [searchParams, setSearchParams] = useSearchParams();
  const [sourceId, setSourceId] = useState('');
  const [drawer, setDrawer] = useState<DrawerMode>(null);
  const [principalId, setPrincipalId] = useState('');
  const [secretsRef, setSecretsRef] = useState('');
  const [entries, setEntries] = useState<ConfigEntry[]>(() => entriesFromConfig({}));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePrincipal, setDeletePrincipal] = useState('');

  useEffect(() => {
    const fromQuery = searchParams.get('source') || '';
    if (fromQuery) setSourceId(fromQuery);
  }, [searchParams]);

  function selectSource(next: string) {
    setSourceId(next);
    const nextParams = new URLSearchParams(searchParams);
    if (next) nextParams.set('source', next);
    else nextParams.delete('source');
    setSearchParams(nextParams, { replace: true });
  }

  function openCreate() {
    setPrincipalId('');
    setSecretsRef('');
    setEntries(entriesFromConfig({}));
    setDrawer('create');
  }

  function openEdit(row: OverlayRow) {
    setPrincipalId(row.principal_id);
    setSecretsRef(row.secrets_ref || '');
    setEntries(entriesFromConfig(row.config || {}));
    setDrawer('edit');
  }

  function closeDrawer() {
    if (upsert.isPending) return;
    setDrawer(null);
  }

  const sources = useQuery({
    queryKey: ['sources', tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const r = await api.get<{ sources: SourceRow[] }>('/v1/sources');
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body.sources || [];
    },
  });

  const list = useQuery({
    queryKey: ['overlays', tenantId, sourceId],
    enabled: !!tenantId && !!sourceId,
    queryFn: async () => {
      const r = await api.get<{ overlays: OverlayRow[] }>(
        `/v1/sources/${sourceId}/overlays`
      );
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body.overlays || [];
    },
  });

  const upsert = useMutation({
    mutationFn: async () => {
      uuidSchema.parse(sourceId);
      const config = configFromEntries(entries);
      const body = overlaySchema.parse({
        principal_id: principalId,
        config,
        secrets_ref: secretsRef || null,
      });
      const r = await api.put(
        `/v1/sources/${sourceId}/overlays/${encodeURIComponent(principalId)}`,
        body
      );
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body;
    },
    onSuccess: () => {
      pushToast('Overlay saved', 'success');
      setDrawer(null);
      qc.invalidateQueries({ queryKey: ['overlays', tenantId, sourceId] });
    },
    onError: (e) => pushToast(formatApiError(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: async (reason: string) => {
      uuidSchema.parse(sourceId);
      const parsed = reasonSchema.parse({ reason });
      const r = await api.delete(
        `/v1/sources/${sourceId}/overlays/${encodeURIComponent(deletePrincipal)}`,
        parsed
      );
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body;
    },
    onSuccess: () => {
      pushToast('Overlay deleted', 'success');
      setDeleteOpen(false);
      setDeletePrincipal('');
      qc.invalidateQueries({ queryKey: ['overlays', tenantId, sourceId] });
    },
    onError: (e) => pushToast(formatApiError(e), 'error'),
  });

  if (!tenantId) {
    return <p className="text-sm text-neutral-600">Select a tenant first.</p>;
  }

  const selectedSource = (sources.data || []).find((s) => s.id === sourceId);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Overlays</CardTitle>
        <Button
          type="button"
          size="sm"
          disabled={!sourceId}
          onClick={openCreate}
        >
          New overlay
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="ov-source">Source</Label>
          <select
            id="ov-source"
            className="h-9 w-full max-w-xl rounded-md border border-neutral-300 bg-white px-2 text-sm"
            value={sourceId}
            onChange={(e) => selectSource(e.target.value)}
          >
            <option value="">(select source)</option>
            {(sources.data || []).map((s) => (
              <option key={s.id} value={s.id}>
                {formatSourceLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2">principal</th>
                <th>secrets_ref</th>
                <th>updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list.data || []).map((row) => (
                <tr key={row.id || row.principal_id} className="border-b">
                  <td className="py-2">{row.principal_id}</td>
                  <td className="font-mono text-xs">{row.secrets_ref || '—'}</td>
                  <td className="whitespace-nowrap text-xs text-neutral-600">
                    {row.updated_at || '—'}
                  </td>
                  <td className="space-x-2 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => openEdit(row)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        setDeletePrincipal(row.principal_id);
                        setDeleteOpen(true);
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
              {sourceId && (list.data || []).length === 0 && !list.isLoading && (
                <tr>
                  <td colSpan={4} className="py-3 text-neutral-500">
                    No overlays for this source.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-neutral-500">
          Click a row Edit to open the drawer. Delete asks for a reason.
        </p>

        <Drawer
          open={drawer != null}
          title={drawer === 'edit' ? 'Edit overlay' : 'New overlay'}
          onClose={closeDrawer}
          footer={
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeDrawer}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={upsert.isPending || !principalId}
                onClick={() => upsert.mutate()}
              >
                {upsert.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="ov-principal">Principal</Label>
              <Input
                id="ov-principal"
                value={principalId}
                disabled={drawer === 'edit'}
                onChange={(e) => setPrincipalId(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ov-secrets-ref">Secrets ref</Label>
              <Input
                id="ov-secrets-ref"
                value={secretsRef}
                onChange={(e) => setSecretsRef(e.target.value)}
              />
            </div>
            <ConfigEntriesEditor id="ov-config" entries={entries} onChange={setEntries} />
          </div>
        </Drawer>

        <ConfirmDialog
          open={deleteOpen}
          title="Delete overlay?"
          description={
            <div className="space-y-1">
              <p>
                Principal <span className="font-medium">{deletePrincipal || '(none)'}</span>
              </p>
              {selectedSource ? (
                <p className="text-xs text-neutral-500">{formatSourceLabel(selectedSource)}</p>
              ) : null}
            </div>
          }
          confirmLabel="Delete"
          requireReason
          destructive
          confirming={remove.isPending}
          onCancel={() => !remove.isPending && setDeleteOpen(false)}
          onConfirm={(reason) => {
            if (reason) remove.mutate(reason);
          }}
        />
      </CardContent>
    </Card>
  );
}
