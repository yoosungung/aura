import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CopyableId } from '@/components/copyable-id';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminApi } from '@/hooks/use-admin-api';
import { formatApiError } from '@/lib/errors';
import { auditListSchema } from '@/lib/schemas';
import { useSession } from '@/stores/session';

function resourceLink(resourceType: string, resourceId: string): string | null {
  if (resourceType === 'source_meta') {
    return `/sources?focus=${encodeURIComponent(resourceId)}`;
  }
  if (resourceType === 'user_meta') {
    const sourceId = resourceId.split(':')[0];
    if (sourceId) return `/overlays?source=${encodeURIComponent(sourceId)}`;
  }
  return null;
}

export function AuditPage() {
  const api = useAdminApi();
  const tenantId = useSession((s) => s.tenantId);
  const [action, setAction] = useState('');
  const [appliedAction, setAppliedAction] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const audit = useQuery({
    queryKey: ['audit', tenantId, appliedAction, cursor],
    enabled: !!tenantId,
    queryFn: async () => {
      const r = await api.get<unknown>('/v1/audit', {
        limit: '50',
        cursor,
        action: appliedAction || undefined,
      });
      if (r.status >= 400) throw new Error(formatApiError(r));
      return auditListSchema.parse(r.body);
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
            <Label htmlFor="audit-action">Action filter</Label>
            <Input
              id="audit-action"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="source.activate or source"
            />
          </div>
          <Button
            type="button"
            onClick={() => {
              setCursor(undefined);
              setAppliedAction(action.trim());
            }}
          >
            Apply
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setAction('');
              setAppliedAction('');
              setCursor(undefined);
            }}
          >
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
          <p className="text-sm text-red-600">{formatApiError(audit.error)}</p>
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
              {(audit.data?.items || []).map((row) => {
                const href = resourceLink(row.resource_type, row.resource_id);
                return (
                  <tr key={row.id} className="border-b">
                    <td className="py-2 whitespace-nowrap">{row.at}</td>
                    <td>{row.actor}</td>
                    <td>{row.action}</td>
                    <td className="space-x-1">
                      <span>{row.resource_type}:</span>
                      {href ? (
                        <Link
                          to={href}
                          className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                        >
                          <CopyableId value={row.resource_id} />
                        </Link>
                      ) : (
                        <CopyableId value={row.resource_id} />
                      )}
                    </td>
                    <td>{row.reason || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
