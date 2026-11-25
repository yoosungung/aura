import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './shell';
import { TenantsPage } from '@/features/tenants/tenants-page';
import { SourcesPage } from '@/features/sources/sources-page';
import { BundlesPage } from '@/features/bundles/bundles-page';
import { OverlaysPage } from '@/features/overlays/overlays-page';
import { AuditPage } from '@/features/audit/audit-page';
import { QuotasPage } from '@/features/quotas/quotas-page';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<TenantsPage />} />
        <Route path="sources" element={<SourcesPage />} />
        <Route path="bundles" element={<BundlesPage />} />
        <Route path="overlays" element={<OverlaysPage />} />
        <Route path="quotas" element={<QuotasPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
