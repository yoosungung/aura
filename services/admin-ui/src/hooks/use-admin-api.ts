import { useMemo } from 'react';
import { createApiClient, getApiBaseUrl } from '@/lib/api';
import { useSession } from '@/stores/session';

export function useAdminApi() {
  const bearer = useSession((s) => s.bearer);
  const tenantId = useSession((s) => s.tenantId);
  const clearAuth = useSession((s) => s.clearAuth);
  return useMemo(
    () =>
      createApiClient({
        baseUrl: getApiBaseUrl(),
        bearer,
        tenantId,
        onUnauthorized: () =>
          clearAuth('Session expired or invalid token (401).'),
      }),
    [bearer, tenantId, clearAuth]
  );
}
