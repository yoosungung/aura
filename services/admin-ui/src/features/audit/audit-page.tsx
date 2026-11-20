import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminApi } from '@/hooks/use-admin-api';
import { auditListSchema } from '@/lib/schemas';
import { useSession } from '@/stores/session';

export function AuditPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const [action, setAction] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const audit = useQuery({
    queryKey: ['audit', tenantId, action, cursor],
    enabled: !!tenantId,
    queryFn: async () => {
      const r = await api.get<unknown>('/v1/audit', {
        limit: '50',
        cursor,
      });
      if (r.status >= 400) throw new Error(JSON.stringify(r.body));
      const parsed = auditListSchema.parse(r.body);
      const items = action
        ? parsed.items.filter((i) => i.action.includes(action))
        : parsed.items;
      return { ...parsed, items };
    },
  });

  if (!tenantId) {
    return <p className="text-sm text-neutral-600">Select a tenant first.</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="audit-action">action filter</Label>
            <Input
              id="audit-action"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="source.activate"
            />
          </div>
          <Button type="button" variant="outline" onClick={() => setCursor(undefined)}>
            Newest
          </Button>
          <Button
            type="button"
            disabled={!audit.data?.next_cursor}
            onClick={() => setCursor(audit.data?.next_cursor || undefined)}
          >
            Next page
          </Button>
        </div>
        {audit.isError && (
          <p className="text-sm text-red-600">{String(audit.error)}</p>
        )}
        <div className="overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2">at</th>
                <th>actor</th>
                <th>action</th>
                <th>resource</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {(audit.data?.items || []).map((row) => (
                <tr key={row.id} className="border-b">
                  <td className="py-2 whitespace-nowrap">{row.at}</td>
                  <td>{row.actor}</td>
                  <td>{row.action}</td>
                  <td>
                    {row.resource_type}:{row.resource_id}
                  </td>
                  <td>{row.reason || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
