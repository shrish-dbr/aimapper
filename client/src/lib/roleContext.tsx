// Shared role/identity context. Fetches /whoami once and exposes the signed-in
// user's email + role, plus convenience booleans for UI gating. Also loads the
// user's saved preferences (server-side) and applies the theme app-wide.
// Server routes enforce roles authoritatively; this only drives what the UI offers.
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { api, type Role, type UserPrefs } from './aimapperApi';

const EMPTY_PREFS: UserPrefs = {
  defaultEndpoint: null,
  defaultCatalog: null,
  defaultSchema: null,
  defaultTarget: null,
  theme: null,
};

interface RoleState {
  email: string | null;
  role: Role;
  loading: boolean;
  isEditor: boolean; // editor or admin
  isAdmin: boolean;
  refresh: () => void;
  prefs: UserPrefs;
  /** Persist prefs, update context, and re-apply the theme. */
  savePrefs: (next: UserPrefs) => Promise<void>;
}

const RoleContext = createContext<RoleState | null>(null);

/** Apply a theme preference by toggling the `dark` class on <html>. */
function applyTheme(theme: string | null) {
  if (typeof document === 'undefined') return;
  const wantsDark =
    theme === 'dark' ||
    (theme !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', !!wantsDark);
}

export function RoleProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<Role>('viewer');
  const [prefs, setPrefs] = useState<UserPrefs>(EMPTY_PREFS);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const [who, prefsRes] = await Promise.allSettled([api.whoami(), api.getUserPrefs()]);
      if (!active) return;
      if (who.status === 'fulfilled') { setEmail(who.value.email); setRole(who.value.role); }
      if (prefsRes.status === 'fulfilled') {
        setPrefs(prefsRes.value.prefs);
        applyTheme(prefsRes.value.prefs.theme);
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, [tick]);

  const savePrefs = useCallback(async (next: UserPrefs) => {
    await api.saveUserPrefs(next);
    setPrefs(next);
    applyTheme(next.theme);
  }, []);

  const value: RoleState = {
    email,
    role,
    loading,
    isEditor: role === 'editor' || role === 'admin',
    isAdmin: role === 'admin',
    refresh: () => setTick((t) => t + 1),
    prefs,
    savePrefs,
  };
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleState {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error('useRole must be used within <RoleProvider>');
  return ctx;
}
