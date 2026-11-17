import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { GUEST_ROUTES_KEY } from '../../shared/savedRoutes.ts';
import { MIGRATED_KEY, safeStorage } from '../routeStorage.ts';

/**
 * Who is signed in. The session lives in HttpOnly cookies managed by the server (server/auth.ts), so
 * this context only knows the public profile `/api/auth/session` returns; it never sees a token.
 */

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

interface AuthState {
  /** false until the first session check answers */
  ready: boolean;
  /** Whether the server has Supabase set up (no accounts → no login prompts). */
  configured: boolean;
  user: AuthUser | null;
  /** Full-page redirect to Google via Supabase; comes back to the current page. */
  loginWithGoogle: () => void;
  sendMagicLink: (email: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  verifyCode: (email: string, code: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const noop = async () => undefined;
const AuthContext = createContext<AuthState>({
  ready: true,
  configured: false,
  user: null,
  loginWithGoogle: () => undefined,
  sendMagicLink: async () => ({ ok: false, message: 'Accounts are not available.' }),
  verifyCode: async () => ({ ok: false, message: 'Accounts are not available.' }),
  logout: noop,
  refresh: noop,
});

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, data: await res.json().catch(() => null) };
  } catch {
    return { ok: false, data: { message: 'Network error. Check your connection.' } };
  }
}

const currentPath = () => `${window.location.pathname}${window.location.hash.startsWith('#r=') ? '' : window.location.hash}`;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const data = res.ok ? ((await res.json()) as { configured?: boolean; user?: AuthUser | null }) : null;
      setConfigured(Boolean(data?.configured));
      setUser(data?.user ?? null);
    } catch {
      setConfigured(false);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Back from the OAuth / magic-link callback: drop the marker from the address bar
    const url = new URL(window.location.href);
    if (url.searchParams.has('auth')) {
      url.searchParams.delete('auth');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, [refresh]);

  const loginWithGoogle = useCallback(() => {
    window.location.assign(`/api/auth/google?next=${encodeURIComponent(currentPath())}`);
  }, []);

  const sendMagicLink = useCallback(async (email: string) => {
    const r = await postJson('/api/auth/magic-link', { email, next: currentPath() });
    return r.ok ? ({ ok: true } as const) : ({ ok: false, message: String(r.data?.message ?? 'Could not send the email.') } as const);
  }, []);

  const verifyCode = useCallback(
    async (email: string, code: string) => {
      const r = await postJson('/api/auth/verify', { email, token: code });
      if (!r.ok) return { ok: false, message: String(r.data?.message ?? 'That code did not work.') } as const;
      await refresh();
      return { ok: true } as const;
    },
    [refresh]
  );

  const logout = useCallback(async () => {
    await postJson('/api/auth/logout', {});
    // The account's routes were copied here at login; on a shared device they must not stay behind
    const storage = safeStorage();
    try {
      storage?.removeItem(GUEST_ROUTES_KEY);
      storage?.removeItem(MIGRATED_KEY);
    } catch {
      // ignore
    }
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ ready, configured, user, loginWithGoogle, sendMagicLink, verifyCode, logout, refresh }),
    [ready, configured, user, loginWithGoogle, sendMagicLink, verifyCode, logout, refresh]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
