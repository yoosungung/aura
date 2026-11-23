import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ConfigEntriesEditor } from '@/components/config-entries-editor';
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
import { overlaySchema, reasonSchema, uuidSchema } from '@/lib/schemas';
import { useSession } from '@/stores/session';

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

export function OverlaysPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sourceId, setSourceId] = useState('');
  const [principalId, setPrincipalId] = useState('');
  const [secretsRef, setSecretsRef] = useState('');
  const [reason, setReason] = useState('');
  const [entries, setEntries] = useState<ConfigEntry[]>(() => entriesFromConfig({}));

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

  function fillFromRow(row: OverlayRow) {
    setPrincipalId(row.principal_id);
    setSecretsRef(row.secrets_ref || '');
    setEntries(entriesFromConfig(row.config || {}));
  }

  const sources = useQuery({
    queryKey: ['sources', tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const r = await api.get<{ sources: SourceRow[] }>('/v1/sources');
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
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
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
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
        reason: reason || undefined,
      });
      const r = await api.put(
        `/v1/sources/${sourceId}/overlays/${encodeURIComponent(principalId)}`,
        body
      );
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
      return r.body;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['overlays', tenantId, sourceId] }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      uuidSchema.parse(sourceId);
      const parsed = reasonSchema.parse({ reason });
      const r = await api.delete(
        `/v1/sources/${sourceId}/overlays/${encodeURIComponent(principalId)}`,
        parsed
      );
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
      return r.body;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['overlays', tenantId, sourceId] }),
  });

  if (!tenantId) {
    return <p className="text-sm text-neutral-600">Select a tenant first.</p>;
  }

  const statusMessage = upsert.error || remove.error || list.error
    ? String(upsert.error || remove.error || list.error)
    : upsert.isSuccess
      ? 'overlay saved'
      : remove.isSuccess
        ? 'overlay deleted'
        : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overlays</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="ov-source">Source</Label>
            <select
              id="ov-source"
              className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm"
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
          <div className="space-y-1">
            <Label htmlFor="ov-principal">Principal</Label>
            <Input
              id="ov-principal"
              value={principalId}
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
          <div className="space-y-1">
            <Label htmlFor="ov-reason">Reason (required to delete)</Label>
            <Input
              id="ov-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <ConfigEntriesEditor id="ov-config" entries={entries} onChange={setEntries} />
        <div className="flex gap-2">
          <Button type="button" onClick={() => upsert.mutate()}>
            Upsert
          </Button>
          <Button type="button" variant="destructive" onClick={() => remove.mutate()}>
            Delete
          </Button>
          <Button type="button" variant="outline" onClick={() => list.refetch()}>
            Refresh
          </Button>
        </div>
        {statusMessage && (
          <p className="text-sm text-neutral-700">{statusMessage}</p>
        )}
        <div className="overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2">principal</th>
                <th>secrets_ref</th>
                <th>updated</th>
              </tr>
            </thead>
            <tbody>
              {(list.data || []).map((row) => (
                <tr
                  key={row.id || row.principal_id}
                  className="cursor-pointer border-b hover:bg-neutral-50"
                  onClick={() => fillFromRow(row)}
                >
                  <td className="py-2">{row.principal_id}</td>
                  <td className="font-mono text-xs">{row.secrets_ref || '—'}</td>
                  <td className="whitespace-nowrap text-xs text-neutral-600">
                    {row.updated_at || '—'}
                  </td>
                </tr>
              ))}
              {sourceId && (list.data || []).length === 0 && !list.isLoading && (
                <tr>
                  <td colSpan={3} className="py-3 text-neutral-500">
                    No overlays for this source.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-neutral-500">Click a row to load it into the form.</p>
      </CardContent>
    </Card>
  );
}
