import { create } from 'zustand';

const STORAGE_KEY = 'aura-admin-session';

type PersistedSession = {
  bearer: string;
  tenantId: string | null;
  rememberSession: boolean;
};

function readStoredSession(): PersistedSession {
  if (typeof window === 'undefined') {
    return { bearer: '', tenantId: null, rememberSession: false };
  }
  for (const store of [window.sessionStorage, window.localStorage]) {
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Partial<PersistedSession>;
      return {
        bearer: typeof parsed.bearer === 'string' ? parsed.bearer : '',
        tenantId: typeof parsed.tenantId === 'string' ? parsed.tenantId : null,
        rememberSession: Boolean(parsed.rememberSession),
      };
    } catch {
      // Ignore malformed storage entries.
    }
  }
  return { bearer: '', tenantId: null, rememberSession: false };
}

function writeStoredSession(data: PersistedSession) {
  if (typeof window === 'undefined') return;
  try {
    const target = data.rememberSession
      ? window.localStorage
      : window.sessionStorage;
    const other = data.rememberSession
      ? window.sessionStorage
      : window.localStorage;
    other.removeItem(STORAGE_KEY);
    if (data.bearer) {
      target.setItem(STORAGE_KEY, JSON.stringify(data));
    } else {
      target.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota / privacy mode errors.
  }
}

function clearStoredSession() {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

type SessionState = {
  bearer: string;
  rememberSession: boolean;
  tenantId: string | null;
  authError: string | null;
  setAuth: (bearer: string, rememberSession: boolean) => void;
  clearAuth: (authError?: string | null) => void;
  setTenantId: (tenantId: string | null) => void;
};

const initial = readStoredSession();

export const useSession = create<SessionState>((set, get) => ({
  bearer: initial.bearer,
  rememberSession: initial.rememberSession,
  tenantId: initial.tenantId,
  authError: null,
  setAuth: (bearer, rememberSession) => {
    const tenantId = get().tenantId;
    writeStoredSession({ bearer, tenantId, rememberSession });
    set({ bearer, rememberSession, authError: null });
  },
  clearAuth: (authError = null) => {
    clearStoredSession();
    set({ bearer: '', tenantId: null, authError });
  },
  setTenantId: (tenantId) => {
    const { bearer, rememberSession } = get();
    if (bearer) {
      writeStoredSession({ bearer, tenantId, rememberSession });
    }
    set({ tenantId });
  },
}));
