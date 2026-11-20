import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminApi } from '@/hooks/use-admin-api';
import { reasonSchema } from '@/lib/schemas';
import { useSession } from '@/stores/session';

type SourceRow = {
  id: string;
  kind: string;
  name: string;
  version: string;
  runtime: string;
  status: string;
};

export function SourcesPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['sources', tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const r = await api.get<{ sources: SourceRow[] }>('/v1/sources');
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
      return r.body.sources || [];
    },
  });

  const activate = useMutation({
    mutationFn: async (id: string) => {
      const r = await api.post(`/v1/sources/${id}/activate`);
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
      return r.body;
    },
    onSuccess: () => {
      setMessage('activated');
      qc.invalidateQueries({ queryKey: ['sources', tenantId] });
    },
    onError: (e) => setMessage(String(e)),
  });

  const retire = useMutation({
    mutationFn: async (id: string) => {
      const parsed = reasonSchema.parse({ reason });
      const r = await api.post(`/v1/sources/${id}/retire`, parsed);
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
      return r.body;
    },
    onSuccess: () => {
      setMessage('retired');
      qc.invalidateQueries({ queryKey: ['sources', tenantId] });
    },
    onError: (e) => setMessage(String(e)),
  });

  if (!tenantId) {
    return <p className="text-sm text-neutral-600">Select a tenant first.</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sources</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="retire-reason">Retire reason</Label>
          <Input
            id="retire-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="required for retire"
          />
        </div>
        {message && <pre className="overflow-auto rounded bg-neutral-100 p-2 text-xs">{message}</pre>}
        <div className="overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2">kind</th>
                <th>name</th>
                <th>version</th>
                <th>runtime</th>
                <th>status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list.data || []).map((s) => (
                <tr key={s.id} className="border-b">
                  <td className="py-2">{s.kind}</td>
                  <td>{s.name}</td>
                  <td>{s.version}</td>
                  <td>{s.runtime}</td>
                  <td>{s.status}</td>
                  <td className="space-x-2 text-right">
                    {s.status === 'pending' && (
                      <Button
                        id="btn-activate"
                        size="sm"
                        type="button"
                        onClick={() => activate.mutate(s.id)}
                      >
                        Activate
                      </Button>
                    )}
                    {s.status === 'active' && (
                      <Button
                        size="sm"
                        variant="destructive"
                        type="button"
                        onClick={() => retire.mutate(s.id)}
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
  );
}
