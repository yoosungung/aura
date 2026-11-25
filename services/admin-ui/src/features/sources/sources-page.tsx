import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyableId } from '@/components/copyable-id';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useAdminApi } from '@/hooks/use-admin-api';
import { formatSourceLabel } from '@/lib/display';
import { formatApiError } from '@/lib/errors';
import { reasonSchema } from '@/lib/schemas';
import { cn } from '@/lib/utils';
import { useSession } from '@/stores/session';
import { useToast } from '@/stores/toast';

type SourceRow = {
  id: string;
  kind: string;
  name: string;
  version: string;
  runtime: string;
  status: string;
  checksum?: string;
  created_at?: string;
};

type PendingAction =
  | { type: 'activate'; source: SourceRow }
  | { type: 'retire'; source: SourceRow }
  | null;

type TimelineKey = { kind: string; name: string } | null;

export function SourcesPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const qc = useQueryClient();
  const pushToast = useToast((s) => s.push);
  const [searchParams, setSearchParams] = useSearchParams();
  const [pending, setPending] = useState<PendingAction>(null);
  const [statusFilter, setStatusFilter] = useState<string>(
    searchParams.get('status') || ''
  );
  const [kindFilter, setKindFilter] = useState<string>(searchParams.get('kind') || '');
  const [timeline, setTimeline] = useState<TimelineKey>(null);

  const focusId = searchParams.get('focus') || '';

  const list = useQuery({
    queryKey: ['sources', tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const r = await api.get<{ sources: SourceRow[] }>('/v1/sources');
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body.sources || [];
    },
  });

  const versions = useQuery({
    queryKey: ['source-versions', tenantId, timeline?.kind, timeline?.name],
    enabled: !!tenantId && !!timeline,
    queryFn: async () => {
      if (!timeline) return [];
      const r = await api.get<{ sources: SourceRow[] }>(
        `/v1/sources/${encodeURIComponent(timeline.kind)}/${encodeURIComponent(timeline.name)}`
      );
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body.sources || [];
    },
  });

  const filtered = useMemo(() => {
    return (list.data || []).filter((s) => {
      if (statusFilter && s.status !== statusFilter) return false;
      if (kindFilter && s.kind !== kindFilter) return false;
      return true;
    });
  }, [list.data, statusFilter, kindFilter]);

  function syncFilters(nextStatus: string, nextKind: string) {
    setStatusFilter(nextStatus);
    setKindFilter(nextKind);
    const next = new URLSearchParams(searchParams);
    if (nextStatus) next.set('status', nextStatus);
    else next.delete('status');
    if (nextKind) next.set('kind', nextKind);
    else next.delete('kind');
    setSearchParams(next, { replace: true });
  }

  const activate = useMutation({
    mutationFn: async (id: string) => {
      const r = await api.post(`/v1/sources/${id}/activate`);
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body;
    },
    onSuccess: () => {
      pushToast('Source activated', 'success');
      setPending(null);
      qc.invalidateQueries({ queryKey: ['sources', tenantId] });
      qc.invalidateQueries({ queryKey: ['source-versions', tenantId] });
    },
    onError: (e) => pushToast(formatApiError(e), 'error'),
  });

  const retire = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const parsed = reasonSchema.parse({ reason });
      const r = await api.post(`/v1/sources/${id}/retire`, parsed);
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body;
    },
    onSuccess: () => {
      pushToast('Source retired', 'success');
      setPending(null);
      qc.invalidateQueries({ queryKey: ['sources', tenantId] });
      qc.invalidateQueries({ queryKey: ['source-versions', tenantId] });
    },
    onError: (e) => pushToast(formatApiError(e), 'error'),
  });

  if (!tenantId) {
    return <p className="text-sm text-neutral-600">Select a tenant first.</p>;
  }

  const confirming = activate.isPending || retire.isPending;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <div className="space-y-1">
              <Label htmlFor="filter-status">Status</Label>
              <select
                id="filter-status"
                className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm"
                value={statusFilter}
                onChange={(e) => syncFilters(e.target.value, kindFilter)}
              >
                <option value="">all</option>
                <option value="pending">pending</option>
                <option value="active">active</option>
                <option value="retired">retired</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="filter-kind">Kind</Label>
              <select
                id="filter-kind"
                className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm"
                value={kindFilter}
                onChange={(e) => syncFilters(statusFilter, e.target.value)}
              >
                <option value="">all</option>
                <option value="agent">agent</option>
                <option value="mcp">mcp</option>
              </select>
            </div>
          </div>
          {list.isError && (
            <p className="text-sm text-red-600">{formatApiError(list.error)}</p>
          )}
          <div className="overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2">kind</th>
                  <th>name</th>
                  <th>version</th>
                  <th>runtime</th>
                  <th>status</th>
                  <th>id</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr
                    key={s.id}
                    className={cn(
                      'border-b',
                      focusId === s.id && 'bg-amber-50'
                    )}
                  >
                    <td className="py-2">{s.kind}</td>
                    <td>
                      <button
                        type="button"
                        className="text-left underline-offset-2 hover:underline"
                        onClick={() => setTimeline({ kind: s.kind, name: s.name })}
                      >
                        {s.name}
                      </button>
                    </td>
                    <td>{s.version}</td>
                    <td>{s.runtime}</td>
                    <td>{s.status}</td>
                    <td>
                      <CopyableId value={s.id} />
                    </td>
                    <td className="space-x-2 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => setTimeline({ kind: s.kind, name: s.name })}
                      >
                        Timeline
                      </Button>
                      <Link
                        to={`/overlays?source=${encodeURIComponent(s.id)}`}
                        className={cn(
                          'inline-flex h-8 items-center rounded-md border border-neutral-300 bg-white px-3 text-xs hover:bg-neutral-50'
                        )}
                      >
                        Overlays
                      </Link>
                      {s.status === 'pending' && (
                        <Button
                          id="btn-activate"
                          size="sm"
                          type="button"
                          onClick={() => setPending({ type: 'activate', source: s })}
                        >
                          Activate
                        </Button>
                      )}
                      {s.status === 'active' && (
                        <Button
                          size="sm"
                          variant="destructive"
                          type="button"
                          onClick={() => setPending({ type: 'retire', source: s })}
                        >
                          Retire
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {timeline ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle>
              Timeline · {timeline.kind}/{timeline.name}
            </CardTitle>
            <Button type="button" variant="outline" size="sm" onClick={() => setTimeline(null)}>
              Close
            </Button>
          </CardHeader>
          <CardContent>
            {versions.isError && (
              <p className="text-sm text-red-600">{formatApiError(versions.error)}</p>
            )}
            <ol className="space-y-2 border-l border-neutral-200 pl-4">
              {(versions.data || []).map((v) => (
                <li key={v.id} className="relative text-sm">
                  <span className="absolute -left-[1.15rem] top-1.5 h-2 w-2 rounded-full bg-neutral-400" />
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{v.version}</span>
                    <span className="text-neutral-500">{v.status}</span>
                    <CopyableId value={v.id} />
                  </div>
                  <p className="text-xs text-neutral-500">{v.created_at || ''}</p>
                </li>
              ))}
              {!versions.isLoading && (versions.data || []).length === 0 ? (
                <li className="text-sm text-neutral-500">No versions.</li>
              ) : null}
            </ol>
          </CardContent>
        </Card>
      ) : null}

      <ConfirmDialog
        open={pending?.type === 'activate'}
        title="Activate source?"
        description={
          pending?.type === 'activate' ? (
            <div className="space-y-1">
              <p>
                <span className="font-medium">{formatSourceLabel(pending.source)}</span>
              </p>
              <p className="font-mono text-xs text-neutral-500">
                {pending.source.checksum || 'server will re-check Garage sha256'}
              </p>
            </div>
          ) : null
        }
        confirmLabel="Activate"
        confirming={confirming}
        onCancel={() => !confirming && setPending(null)}
        onConfirm={() => {
          if (pending?.type === 'activate') activate.mutate(pending.source.id);
        }}
      />

      <ConfirmDialog
        open={pending?.type === 'retire'}
        title="Retire source?"
        description={
          pending?.type === 'retire' ? (
            <p>
              Resolve will stop serving{' '}
              <span className="font-medium">{formatSourceLabel(pending.source)}</span>.
              Status becomes retired (no hard delete).
            </p>
          ) : null
        }
        confirmLabel="Retire"
        requireReason
        destructive
        confirming={confirming}
        onCancel={() => !confirming && setPending(null)}
        onConfirm={(reason) => {
          if (pending?.type === 'retire' && reason) {
            retire.mutate({ id: pending.source.id, reason });
          }
        }}
      />
    </div>
  );
}
