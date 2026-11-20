import { useMemo } from 'react';
import { createApiClient } from '@/lib/api';
import { useSession } from '@/stores/session';

export function useAdminApi() {
  const baseUrl = useSession((s) => s.baseUrl);
  const bearer = useSession((s) => s.bearer);
  const tenantId = useSession((s) => s.tenantId);
  return useMemo(
    () => createApiClient({ baseUrl, bearer, tenantId }),
    [baseUrl, bearer, tenantId]
  );
}
