import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ConfigEntriesEditor } from '@/components/config-entries-editor';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminApi } from '@/hooks/use-admin-api';
import { putBundle, sha256Checksum } from '@/lib/bundle-upload';
import {
  configFromEntries,
  entriesFromConfig,
  type ConfigEntry,
} from '@/lib/config-entries';
import { shortId } from '@/lib/display';
import { formatApiError } from '@/lib/errors';
import {
  createCustomSourceSchema,
  createSourceSchema,
  type CreateSourceInput,
} from '@/lib/schemas';
import { scaffoldFor } from '@/lib/scaffold';
import { useSession } from '@/stores/session';
import { useToast } from '@/stores/toast';

type FormValues = Omit<
  CreateSourceInput,
  'config' | 'checksum' | 'bundle_uri' | 'runtime'
> & {
  checksum: string;
  bundle_uri: string;
  function: string;
  runtime: 'nodejs' | 'python' | 'custom';
};

export function BundlesPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const pushToast = useToast((s) => s.push);
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [activateOpen, setActivateOpen] = useState(false);
  const [entries, setEntries] = useState<ConfigEntry[]>(() => entriesFromConfig({}));
  const form = useForm<FormValues>({
    defaultValues: {
      kind: 'agent',
      name: '',
      version: '1.0.0',
      entrypoint: 'main:factory',
      function: 'aura-agent-invoke-',
      bundle_uri: '',
      checksum: '',
      runtime: 'nodejs',
    },
  });
  const bundleUri = form.watch('bundle_uri');
  const checksum = form.watch('checksum');
  const runtime = form.watch('runtime');
  const kind = form.watch('kind');
  const isCustom = runtime === 'custom';

  async function onFileChosen(next: File | null) {
    setFile(next);
    form.setValue('bundle_uri', '');
    form.setValue('checksum', '');
    setStatus(null);
    setCreatedId(null);
    if (!next) return;
    setStatus(`hashing ${next.name}…`);
    try {
      const digest = await sha256Checksum(next);
      form.setValue('checksum', digest);
      setStatus(`checksum ready · ${next.name}`);
    } catch (err) {
      setStatus(String(err));
    }
  }

  function onRuntimeChange(next: FormValues['runtime']) {
    form.setValue('runtime', next);
    setCreatedId(null);
    setStatus(null);
    if (next === 'custom') {
      setFile(null);
      form.setValue('bundle_uri', '');
      form.setValue('checksum', '');
      const current = form.getValues('function');
      if (!current || current.includes(':')) {
        form.setValue(
          'function',
          kind === 'mcp' ? 'aura-mcp-invoke-' : 'aura-agent-invoke-'
        );
      }
    } else if (!form.getValues('entrypoint') || !form.getValues('entrypoint').includes(':')) {
      form.setValue('entrypoint', 'main:factory');
    }
  }

  const register = useMutation({
    mutationFn: async (raw: FormValues) => {
      const config = configFromEntries(entries);

      if (raw.runtime === 'custom') {
        setStatus('creating pending custom source…');
        const parsed = createCustomSourceSchema.parse({
          kind: raw.kind,
          name: raw.name,
          version: raw.version,
          function: raw.function,
          runtime: 'custom',
          config,
        });
        const created = await api.post<{ source?: { id?: string; checksum?: string; bundle_uri?: string } }>(
          '/v1/sources',
          parsed
        );
        if (created.status >= 400) throw new Error(formatApiError(created));
        if (created.body.source?.checksum) {
          form.setValue('checksum', created.body.source.checksum);
        }
        if (created.body.source?.bundle_uri) {
          form.setValue('bundle_uri', created.body.source.bundle_uri);
        }
        return created.body;
      }

      if (!file) throw new Error('choose a bundle file first');
      let digest = raw.checksum;
      if (!digest) {
        digest = await sha256Checksum(file);
        form.setValue('checksum', digest);
      }

      setStatus('presigning…');
      const signed = await api.post<{
        upload_url: string;
        bundle_uri: string;
        headers: Record<string, string>;
      }>('/v1/bundles/presign', {
        kind: raw.kind,
        name: raw.name,
        version: raw.version,
      });
      if (signed.status >= 400) throw new Error(formatApiError(signed));
      form.setValue('bundle_uri', signed.body.bundle_uri);

      setStatus('uploading…');
      await putBundle(signed.body.upload_url, file, signed.body.headers || {});

      setStatus('creating pending source…');
      const parsed = createSourceSchema.parse({
        kind: raw.kind,
        name: raw.name,
        version: raw.version,
        entrypoint: raw.entrypoint,
        bundle_uri: signed.body.bundle_uri,
        checksum: digest,
        runtime: raw.runtime,
        config,
      });
      const created = await api.post<{ source?: { id?: string } }>('/v1/sources', parsed);
      if (created.status >= 400) throw new Error(formatApiError(created));
      return created.body;
    },
    onSuccess: (body) => {
      const id = body?.source?.id || null;
      setCreatedId(id);
      const msg = id
        ? `pending source created · ${shortId(id)}`
        : 'pending source created';
      setStatus(msg);
      pushToast(msg, 'success');
      qc.invalidateQueries({ queryKey: ['sources', tenantId] });
    },
    onError: (err) => {
      const msg = formatApiError(err);
      setStatus(msg);
      pushToast(msg, 'error');
    },
  });

  const activate = useMutation({
    mutationFn: async (id: string) => {
      const r = await api.post(`/v1/sources/${id}/activate`);
      if (r.status >= 400) throw new Error(formatApiError(r));
      return r.body;
    },
    onSuccess: () => {
      pushToast('Source activated', 'success');
      setActivateOpen(false);
      setStatus((prev) => `${prev || 'pending'} · activated`);
      qc.invalidateQueries({ queryKey: ['sources', tenantId] });
    },
    onError: (e) => pushToast(formatApiError(e), 'error'),
  });

  if (!tenantId) {
    return <p className="text-sm text-neutral-600">Select a tenant first.</p>;
  }

  const functionHint =
    kind === 'mcp'
      ? 'aura-mcp-invoke-… or aura-mcp-invoke-rpc-…'
      : 'aura-agent-invoke-…';
  const scaffold = !isCustom ? scaffoldFor(kind, runtime) : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Bundle registration</CardTitle>
        {scaffold ? (
          <a
            id="btn-download-scaffold"
            href={scaffold.href}
            download={scaffold.file}
            className="inline-flex h-8 items-center justify-center rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium hover:bg-neutral-50"
            title={`Includes ${scaffold.depsFile} for local install`}
          >
            Download scaffold (.zip)
          </a>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Kind" id="src-kind">
            <select
              id="src-kind"
              className="h-9 w-full rounded-md border px-2 text-sm"
              {...form.register('kind')}
            >
              <option value="agent">agent</option>
              <option value="mcp">mcp</option>
            </select>
          </Field>
          <Field label="Runtime" id="src-runtime">
            <select
              id="src-runtime"
              className="h-9 w-full rounded-md border px-2 text-sm"
              value={runtime}
              onChange={(e) => onRuntimeChange(e.target.value as FormValues['runtime'])}
            >
              <option value="nodejs">nodejs</option>
              <option value="python">python</option>
              <option value="custom">custom</option>
            </select>
          </Field>
          <Field label="Name" id="src-name">
            <Input id="src-name" {...form.register('name')} />
          </Field>
          <Field label="Version" id="src-version">
            <Input id="src-version" {...form.register('version')} />
          </Field>
          {isCustom ? (
            <Field label="Function name" id="src-function">
              <Input
                id="src-function"
                placeholder={functionHint}
                {...form.register('function')}
              />
            </Field>
          ) : (
            <Field label="Entrypoint" id="src-entrypoint">
              <Input
                id="src-entrypoint"
                placeholder="main:factory"
                {...form.register('entrypoint')}
              />
            </Field>
          )}
          {!isCustom ? (
            <div className="space-y-1">
              <Label htmlFor="src-file">Bundle file</Label>
              <Input
                id="src-file"
                type="file"
                accept=".zip,.js,.py,application/zip"
                onChange={(e) => onFileChosen(e.target.files?.[0] || null)}
              />
              <p className="text-xs text-neutral-500">
                Prefer a source zip (e.g. <span className="font-mono">main.js</span> +{' '}
                <span className="font-mono">lib/</span>). No{' '}
                <span className="font-mono">node_modules</span>. Single{' '}
                <span className="font-mono">.js</span>/<span className="font-mono">.py</span>{' '}
                still works.
              </p>
            </div>
          ) : (
            <p className="self-end text-xs text-neutral-500 md:col-span-1">
              custom uses <span className="font-mono">source_meta.function</span> — no
              entrypoint / zip / Garage.
            </p>
          )}
        </div>
        {!isCustom ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="src-checksum">Checksum</Label>
              <Input
                id="src-checksum"
                readOnly
                value={checksum || ''}
                placeholder="filled from file"
                className="bg-neutral-50 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="src-bundle-uri">Bundle location</Label>
              <Input
                id="src-bundle-uri"
                readOnly
                value={bundleUri || ''}
                placeholder="filled on register"
                className="bg-neutral-50 font-mono text-xs"
              />
            </div>
          </div>
        ) : null}
        <ConfigEntriesEditor id="src-config" entries={entries} onChange={setEntries} />
        <div className="flex flex-wrap gap-2">
          <Button
            id="btn-presign"
            type="button"
            disabled={(!isCustom && !file) || register.isPending}
            onClick={form.handleSubmit((v) => register.mutate(v))}
          >
            {register.isPending
              ? 'Working…'
              : isCustom
                ? 'Create pending'
                : 'Upload & create pending'}
          </Button>
        </div>
        {status && <p className="text-sm text-neutral-700">{status}</p>}
        {createdId ? (
          <div className="flex flex-wrap gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
            <Button
              id="btn-activate-now"
              type="button"
              disabled={activate.isPending}
              onClick={() => setActivateOpen(true)}
            >
              Activate now
            </Button>
            <Link
              to={`/sources?focus=${encodeURIComponent(createdId)}&status=pending`}
              className="inline-flex h-9 items-center rounded-md border border-neutral-300 bg-white px-4 text-sm hover:bg-neutral-50"
            >
              Go to Sources
            </Link>
          </div>
        ) : null}
        <p className="text-xs text-neutral-500">
          {isCustom
            ? 'Flow: function (allowlisted prefix) → pending · entrypoint=null → Activate (no Garage).'
            : 'Flow: Download scaffold → npm/pip locally → zip sources at zip root (main + lib/, no node_modules) → upload → entrypoint main:factory → Activate.'}
        </p>
        <ConfirmDialog
          open={activateOpen}
          title="Activate source?"
          description={
            <div className="space-y-1">
              <p>
                Activate pending source{' '}
                <span className="font-mono text-xs">{shortId(createdId || '')}</span>
              </p>
              {checksum ? (
                <p className="font-mono text-xs text-neutral-500">{checksum}</p>
              ) : null}
            </div>
          }
          confirmLabel="Activate"
          confirming={activate.isPending}
          onCancel={() => !activate.isPending && setActivateOpen(false)}
          onConfirm={() => {
            if (createdId) activate.mutate(createdId);
          }}
        />
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
