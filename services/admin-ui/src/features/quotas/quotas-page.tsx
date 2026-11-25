import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminApi } from '@/hooks/use-admin-api';
import { formatApiError } from '@/lib/errors';
import { useSession } from '@/stores/session';
import { useToast } from '@/stores/toast';

type QuotaBody = {
  tenant_id?: string;
  present?: boolean;
  tokens?: number;
  inflight?: number;
  limits?: { ratePerSec?: number; burst?: number; maxInflight?: number };
  updated_at_ms?: number;
  run_count?: number;
  error?: string;
};

export function QuotasPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const pushToast = useToast((s) => s.push);
  const qc = useQueryClient();
  const [resetOpen, setResetOpen] = useState(false);

  const quota = useQuery({
    queryKey: ['quota', tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const r = await api.get<QuotaBody>(`/v1/quotas/${encodeURIComponent(tenantId!)}`);
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body;
    },
  });

  const reset = useMutation({
    mutationFn: async (reason: string) => {
      const r = await api.post(`/v1/quotas/${encodeURIComponent(tenantId!)}/reset`, {
        reason,
      });
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body;
    },
    onSuccess: () => {
      pushToast('Quota reset', 'success');
      setResetOpen(false);
      qc.invalidateQueries({ queryKey: ['quota', tenantId] });
    },
    onError: (e) => pushToast(formatApiError(e), 'error'),
  });

  if (!tenantId) {
    return <p className="text-sm text-neutral-600">Select a tenant first.</p>;
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Quota</CardTitle>
        <Button type="button" variant="outline" size="sm" onClick={() => quota.refetch()}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-neutral-600">
          Runtime counters from Gateway KV (via control-admin). Limit editing is out of
          scope — reset only clears usage/inflight.
        </p>
        {quota.isError && (
          <p className="text-sm text-red-600">{formatApiError(quota.error)}</p>
        )}
        {quota.data ? (
          <dl className="grid gap-2 text-sm md:grid-cols-2">
            <div>
              <dt className="text-neutral-500">Present</dt>
              <dd>{quota.data.present ? 'yes' : 'no (defaults)'}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Tokens</dt>
              <dd>{quota.data.tokens ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Inflight</dt>
              <dd>{quota.data.inflight ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Runs tracked</dt>
              <dd>{quota.data.run_count ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Limits (read-only)</dt>
              <dd className="font-mono text-xs">
                {quota.data.limits
                  ? `${quota.data.limits.ratePerSec}/s · burst ${quota.data.limits.burst} · maxInflight ${quota.data.limits.maxInflight}`
                  : '—'}
              </dd>
            </div>
          </dl>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          disabled={reset.isPending || quota.isError}
          onClick={() => setResetOpen(true)}
        >
          Reset counters
        </Button>

        <ConfirmDialog
          open={resetOpen}
          title="Reset quota counters?"
          description={
            <p>
              Clears KV usage for this tenant. Does not change rate/burst/maxInflight
              plan limits.
            </p>
          }
          confirmLabel="Reset"
          requireReason
          destructive
          confirming={reset.isPending}
          onCancel={() => !reset.isPending && setResetOpen(false)}
          onConfirm={(reason) => {
            if (reason) reset.mutate(reason);
          }}
        />
      </CardContent>
    </Card>
  );
}
