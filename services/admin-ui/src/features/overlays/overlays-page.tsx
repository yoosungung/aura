import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAdminApi } from '@/hooks/use-admin-api';
import { overlaySchema, reasonSchema, uuidSchema } from '@/lib/schemas';
import { useSession } from '@/stores/session';

type FormValues = {
  sourceId: string;
  principal_id: string;
  configText: string;
  secrets_ref: string;
  reason: string;
};

export function OverlaysPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const qc = useQueryClient();
  const form = useForm<FormValues>({
    defaultValues: {
      sourceId: '',
      principal_id: '',
      configText: '{}',
      secrets_ref: '',
      reason: '',
    },
  });
  const sourceId = form.watch('sourceId');

  const list = useQuery({
    queryKey: ['overlays', tenantId, sourceId],
    enabled: !!tenantId && !!sourceId,
    queryFn: async () => {
      const r = await api.get<{ overlays: unknown[] }>(
        `/v1/sources/${sourceId}/overlays`
      );
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
      return r.body.overlays || [];
    },
  });

  const upsert = useMutation({
    mutationFn: async (values: FormValues) => {
      uuidSchema.parse(values.sourceId);
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(values.configText || '{}') as Record<string, unknown>;
      } catch {
        throw new Error('config must be JSON object');
      }
      const body = overlaySchema.parse({
        principal_id: values.principal_id,
        config,
        secrets_ref: values.secrets_ref || null,
        reason: values.reason || undefined,
      });
      const r = await api.put(
        `/v1/sources/${values.sourceId}/overlays/${encodeURIComponent(values.principal_id)}`,
        body
      );
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
      return r.body;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['overlays', tenantId, sourceId] }),
  });

  const remove = useMutation({
    mutationFn: async (values: FormValues) => {
      uuidSchema.parse(values.sourceId);
      const parsed = reasonSchema.parse({ reason: values.reason });
      const r = await api.delete(
        `/v1/sources/${values.sourceId}/overlays/${encodeURIComponent(values.principal_id)}`,
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overlays</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="ov-source">source_meta id</Label>
            <Input id="ov-source" {...form.register('sourceId')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ov-principal">principal_id</Label>
            <Input id="ov-principal" {...form.register('principal_id')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ov-secrets-ref">secrets_ref</Label>
            <Input id="ov-secrets-ref" {...form.register('secrets_ref')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ov-reason">reason (delete)</Label>
            <Input id="ov-reason" {...form.register('reason')} />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="ov-config">config JSON</Label>
          <Textarea id="ov-config" {...form.register('configText')} />
        </div>
        <div className="flex gap-2">
          <Button type="button" onClick={form.handleSubmit((v) => upsert.mutate(v))}>
            Upsert
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={form.handleSubmit((v) => remove.mutate(v))}
          >
            Delete
          </Button>
          <Button type="button" variant="outline" onClick={() => list.refetch()}>
            Refresh
          </Button>
        </div>
        <pre className="overflow-auto rounded bg-neutral-100 p-2 text-xs">
          {JSON.stringify(
            {
              overlays: list.data,
              error: String(upsert.error || remove.error || list.error || ''),
            },
            null,
            2
          )}
        </pre>
      </CardContent>
    </Card>
  );
}
