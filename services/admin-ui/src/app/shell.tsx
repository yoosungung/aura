import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router-dom';
import { AuthModal } from '@/components/auth-modal';
import { Button } from '@/components/ui/button';
import { getApiBaseUrl } from '@/lib/api';
import { shortId } from '@/lib/display';
import { cn } from '@/lib/utils';
import { useSession } from '@/stores/session';

const nav = [
  { to: '/', label: 'Tenants', end: true },
  { to: '/sources', label: 'Sources' },
  { to: '/bundles', label: 'Bundles' },
  { to: '/overlays', label: 'Overlays' },
  { to: '/audit', label: 'Audit' },
];

export function Shell() {
  const bearer = useSession((s) => s.bearer);
  const tenantId = useSession((s) => s.tenantId);
  const clearAuth = useSession((s) => s.clearAuth);
  const queryClient = useQueryClient();

  const health = useQuery({
    queryKey: ['control-admin-healthz'],
    queryFn: async () => {
      const res = await fetch(`${getApiBaseUrl()}/api/healthz`);
      if (!res.ok) throw new Error(`healthz ${res.status}`);
      return (await res.json()) as { ok?: boolean };
    },
    refetchInterval: 30_000,
    retry: false,
  });

  const isConnected = health.isSuccess && health.data?.ok !== false;
  const isChecking = health.isPending;

  function handleDisconnect() {
    clearAuth(null);
    queryClient.clear();
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <img
              src="/aura-logo.jpg"
              alt=""
              width={36}
              height={36}
              className="h-9 w-9 rounded-lg"
            />
            <div>
              <h1 className="text-lg font-semibold">Aura Admin</h1>
              <p className="text-xs text-neutral-500">ops-only · control-admin HTTP</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="health-badge"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                isChecking
                  ? 'border-neutral-200 bg-neutral-100 text-neutral-600'
                  : isConnected
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-red-200 bg-red-50 text-red-700'
              )}
            >
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  isChecking
                    ? 'bg-neutral-400'
                    : isConnected
                      ? 'bg-emerald-500'
                      : 'bg-red-500'
                )}
              />
              {isChecking ? 'Checking...' : isConnected ? 'Connected' : 'Unreachable'}
            </span>
            <div
              id="tenant-banner"
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white"
              data-testid="active-tenant"
              title={tenantId || undefined}
            >
              active tenant:{' '}
              <span id="active-tenant">
                {tenantId ? shortId(tenantId) : '(none)'}
              </span>
            </div>
            {bearer ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        </div>
        {bearer ? (
          <nav className="mx-auto flex max-w-6xl gap-1 px-4 pb-3">
            {nav.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end}>
                {({ isActive }) => (
                  <Button
                    type="button"
                    variant={isActive ? 'default' : 'ghost'}
                    size="sm"
                    className={cn(isActive && 'pointer-events-none')}
                  >
                    {item.label}
                  </Button>
                )}
              </NavLink>
            ))}
          </nav>
        ) : null}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {bearer ? <Outlet /> : null}
      </main>
      {!bearer ? <AuthModal /> : null}
    </div>
  );
}
