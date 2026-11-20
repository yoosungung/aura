import { NavLink, Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession } from '@/stores/session';
import { cn } from '@/lib/utils';

const nav = [
  { to: '/', label: 'Tenants', end: true },
  { to: '/sources', label: 'Sources' },
  { to: '/bundles', label: 'Bundles' },
  { to: '/overlays', label: 'Overlays' },
  { to: '/audit', label: 'Audit' },
];

export function Shell() {
  const baseUrl = useSession((s) => s.baseUrl);
  const bearer = useSession((s) => s.bearer);
  const tenantId = useSession((s) => s.tenantId);
  const setBaseUrl = useSession((s) => s.setBaseUrl);
  const setBearer = useSession((s) => s.setBearer);

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold">Aura Admin</h1>
            <p className="text-xs text-neutral-500">ops-only · control-admin HTTP</p>
          </div>
          <div
            id="tenant-banner"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white"
            data-testid="active-tenant"
          >
            active tenant: <span id="active-tenant">{tenantId || '(none)'}</span>
          </div>
        </div>
        <div className="mx-auto grid max-w-6xl gap-3 px-4 pb-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="base-url">Control admin URL</Label>
            <Input
              id="base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:8080"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ops-token">Bearer token</Label>
            <Input
              id="ops-token"
              type="password"
              value={bearer}
              onChange={(e) => setBearer(e.target.value)}
              placeholder="ops token"
              autoComplete="off"
            />
          </div>
        </div>
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
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
