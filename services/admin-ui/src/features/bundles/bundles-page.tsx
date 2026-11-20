import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAdminApi } from '@/hooks/use-admin-api';
import { createSourceSchema, type CreateSourceInput } from '@/lib/schemas';
import { useSession } from '@/stores/session';

type FormValues = Omit<CreateSourceInput, 'config'> & { configText: string };

export function BundlesPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const form = useForm<FormValues>({
    defaultValues: {
      kind: 'agent',
      name: '',
      version: '1.0.0',
      entrypoint: 'index:handler',
      bundle_uri: '',
      checksum: '',
      runtime: 'nodejs',
      configText: '{}',
    },
  });

  const presign = useMutation({
    mutationFn: async () => {
      const values = form.getValues();
      const r = await api.post<{
        upload_url: string;
        bundle_uri: string;
        headers: Record<string, string>;
      }>('/v1/bundles/presign', {
        kind: values.kind,
        name: values.name,
        version: values.version,
      });
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
      form.setValue('bundle_uri', r.body.bundle_uri);
      return r.body;
    },
  });

  const createSource = useMutation({
    mutationFn: async (raw: FormValues) => {
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(raw.configText || '{}') as Record<string, unknown>;
      } catch {
        throw new Error('config must be JSON object');
      }
      const parsed = createSourceSchema.parse({
        kind: raw.kind,
        name: raw.name,
        version: raw.version,
        entrypoint: raw.entrypoint,
        bundle_uri: raw.bundle_uri,
        checksum: raw.checksum,
        runtime: raw.runtime,
        config,
      });
      const r = await api.post('/v1/sources', parsed);
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
      return r.body;
    },
  });

  if (!tenantId) {
    return <p className="text-sm text-neutral-600">Select a tenant first.</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bundle registration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="kind" id="src-kind">
            <select
              id="src-kind"
              className="h-9 w-full rounded-md border px-2 text-sm"
              {...form.register('kind')}
            >
              <option value="agent">agent</option>
              <option value="mcp">mcp</option>
            </select>
          </Field>
          <Field label="runtime" id="src-runtime">
            <select
              id="src-runtime"
              className="h-9 w-full rounded-md border px-2 text-sm"
              {...form.register('runtime')}
            >
              <option value="nodejs">nodejs</option>
              <option value="python">python</option>
              <option value="custom">custom</option>
            </select>
          </Field>
          <Field label="name" id="src-name">
            <Input id="src-name" {...form.register('name')} />
          </Field>
          <Field label="version" id="src-version">
            <Input id="src-version" {...form.register('version')} />
          </Field>
          <Field label="entrypoint" id="src-entrypoint">
            <Input id="src-entrypoint" {...form.register('entrypoint')} />
          </Field>
          <Field label="checksum sha256:…" id="src-checksum">
            <Input id="src-checksum" {...form.register('checksum')} />
          </Field>
        </div>
        <Field label="bundle_uri" id="src-bundle-uri">
          <Input id="src-bundle-uri" {...form.register('bundle_uri')} />
        </Field>
        <Field label="config JSON (no runtime key)" id="src-config">
          <Textarea id="src-config" {...form.register('configText')} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            id="btn-presign"
            type="button"
            variant="outline"
            onClick={() => presign.mutate()}
          >
            Presign
          </Button>
          <Button
            id="btn-create-source"
            type="button"
            onClick={form.handleSubmit((v) => createSource.mutate(v))}
          >
            Create pending source
          </Button>
        </div>
        {(presign.data || createSource.data || presign.error || createSource.error) && (
          <pre className="overflow-auto rounded bg-neutral-100 p-2 text-xs">
            {JSON.stringify(
              {
                presign: presign.data,
                created: createSource.data,
                error: String(presign.error || createSource.error || ''),
              },
              null,
              2
            )}
          </pre>
        )}
        <p className="text-xs text-neutral-500">
          Client uploads to upload_url, then activate from Sources (server sha256).
        </p>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
