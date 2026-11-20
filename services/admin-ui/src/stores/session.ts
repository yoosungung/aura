import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type SessionState = {
  baseUrl: string;
  bearer: string;
  tenantId: string | null;
  setBaseUrl: (v: string) => void;
  setBearer: (v: string) => void;
  setTenantId: (v: string | null) => void;
};

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      baseUrl: 'http://localhost:8080',
      bearer: '',
      tenantId: null,
      setBaseUrl: (baseUrl) => set({ baseUrl }),
      setBearer: (bearer) => set({ bearer }),
      setTenantId: (tenantId) => set({ tenantId }),
    }),
    { name: 'aura-admin-session' }
  )
);
