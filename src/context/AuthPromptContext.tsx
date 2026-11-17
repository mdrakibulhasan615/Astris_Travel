import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext.tsx';
import { AuthModal, type AuthModalVariant } from '../components/auth/AuthModal.tsx';
import { NudgeToast } from '../components/auth/NudgeToast.tsx';

/**
 * AuthPromptManager: the three login prompts, shown ONLY to guests on a server with accounts set up,
 * each dismissible and rate-limited per browser session (sessionStorage) so nobody is nagged.
 *
 *  A. Post-checkout: "Proceed to {Seller}" opens the seller in a new tab and, on this tab, the modal
 *     "Save your trip itinerary & track this flight?" (flag `astris_pending_checkout_prompt`), so it
 *     is waiting when the traveller switches back. Same seller twice within 10 minutes → once.
 *  B. Exit intent: the pointer leaves through the top of the window (desktop), or the tab is hidden
 *     on a touch device (shown when it comes back), once per session, only with a route on screen.
 *     No `beforeunload` dialog: there are no unsaved checkout edits to lose; the route is already
 *     in localStorage.
 *  C. Nudge toast (bottom right): first after 90 s on the site, then every 4 minutes while the guest
 *     is actively working on a route, at most 3 times per session; × snoozes it for 4 minutes.
 */

export const PROMPT_KEYS = {
  pendingCheckout: 'astris_pending_checkout_prompt',
  checkoutDismissedAt: 'astris_checkout_prompt_dismissed_at',
  exitDismissed: 'astris_exit_prompt_dismissed',
  nudgeCount: 'astris_nudge_count',
  nudgeNextAt: 'astris_nudge_next_at',
} as const;

export const NUDGE_FIRST_DELAY_MS = 90_000;
export const NUDGE_INTERVAL_MS = 4 * 60_000;
export const NUDGE_MAX_PER_SESSION = 3;
const NUDGE_AUTO_HIDE_MS = 20_000;
const ACTIVE_WINDOW_MS = 2 * 60_000;
const CHECKOUT_COOLDOWN_MS = 10 * 60_000;

const session = {
  get(key: string): string | null {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // ignore
    }
  },
  remove(key: string) {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

interface AuthPromptApi {
  /** Call when a guest hands off to a seller's checkout (Trigger A). */
  notifyCheckoutHandoff: (seller?: string) => void;
  /** The app reports whether a route (2+ stops) is on screen. */
  setRouteActive: (active: boolean) => void;
  /** Opens the login modal on request (the top bar's "Log in"). */
  openLogin: () => void;
}

const AuthPromptContext = createContext<AuthPromptApi>({
  notifyCheckoutHandoff: () => undefined,
  setRouteActive: () => undefined,
  openLogin: () => undefined,
});

export function AuthPromptProvider({ children }: { children: ReactNode }) {
  const { ready, configured, user } = useAuth();
  const guest = ready && configured && !user;
  const [modal, setModal] = useState<AuthModalVariant | null>(null);
  const [toast, setToast] = useState(false);
  const [routeActive, setRouteActiveState] = useState(false);
  const lastActivityRef = useRef(Date.now());
  const exitPendingRef = useRef(false);
  const modalRef = useRef(modal);
  modalRef.current = modal;

  const setRouteActive = useCallback((active: boolean) => setRouteActiveState(active), []);

  // Signed in (or accounts off): nothing to prompt, and a pending prompt is void
  useEffect(() => {
    if (!guest) {
      setModal(null);
      setToast(false);
    }
  }, [guest]);

  // ── A. Checkout handoff ──────────────────────────────────────────────────────────────────────
  const notifyCheckoutHandoff = useCallback(() => {
    if (!guest) return;
    const dismissedAt = Number(session.get(PROMPT_KEYS.checkoutDismissedAt));
    if (dismissedAt && Date.now() - dismissedAt < CHECKOUT_COOLDOWN_MS) return;
    session.set(PROMPT_KEYS.pendingCheckout, '1');
    setToast(false);
    setModal('checkout');
  }, [guest]);

  // A reload or a return to the tab finds the prompt still waiting
  useEffect(() => {
    if (!guest) return;
    if (session.get(PROMPT_KEYS.pendingCheckout) === '1' && !modalRef.current) setModal('checkout');
  }, [guest]);

  // ── B. Exit intent ───────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!guest || !routeActive) return;
    const canShowExit = () => !modalRef.current && session.get(PROMPT_KEYS.exitDismissed) !== '1';
    const show = () => {
      setToast(false);
      setModal('exit');
    };

    const onMouseOut = (e: MouseEvent) => {
      // Leaving through the top edge, toward the tab bar / close button
      if (e.relatedTarget === null && e.clientY <= 0 && canShowExit()) show();
    };
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (coarse && canShowExit()) exitPendingRef.current = true;
        return;
      }
      // Visible again: a pending checkout prompt takes priority over the exit prompt
      if (session.get(PROMPT_KEYS.pendingCheckout) === '1') {
        if (!modalRef.current) setModal('checkout');
      } else if (exitPendingRef.current && canShowExit()) {
        show();
      }
      exitPendingRef.current = false;
    };

    document.addEventListener('mouseout', onMouseOut);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('mouseout', onMouseOut);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [guest, routeActive]);

  // ── C. Periodic nudge ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const mark = () => {
      lastActivityRef.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, mark));
  }, []);

  useEffect(() => {
    if (!guest || !routeActive) {
      setToast(false);
      return;
    }
    if (!session.get(PROMPT_KEYS.nudgeNextAt)) session.set(PROMPT_KEYS.nudgeNextAt, String(Date.now() + NUDGE_FIRST_DELAY_MS));
    const tick = window.setInterval(() => {
      const count = Number(session.get(PROMPT_KEYS.nudgeCount)) || 0;
      const nextAt = Number(session.get(PROMPT_KEYS.nudgeNextAt)) || 0;
      const now = Date.now();
      if (
        count < NUDGE_MAX_PER_SESSION &&
        now >= nextAt &&
        !modalRef.current &&
        document.visibilityState === 'visible' &&
        now - lastActivityRef.current < ACTIVE_WINDOW_MS
      ) {
        session.set(PROMPT_KEYS.nudgeCount, String(count + 1));
        session.set(PROMPT_KEYS.nudgeNextAt, String(now + NUDGE_INTERVAL_MS));
        setToast(true);
      }
    }, 5_000);
    return () => window.clearInterval(tick);
  }, [guest, routeActive]);

  useEffect(() => {
    if (!toast) return;
    const hide = window.setTimeout(() => setToast(false), NUDGE_AUTO_HIDE_MS);
    return () => window.clearTimeout(hide);
  }, [toast]);

  const dismissToast = useCallback(() => {
    setToast(false);
    session.set(PROMPT_KEYS.nudgeNextAt, String(Date.now() + NUDGE_INTERVAL_MS));
  }, []);

  const closeModal = useCallback(() => {
    setModal((current) => {
      if (current === 'checkout') {
        session.remove(PROMPT_KEYS.pendingCheckout);
        session.set(PROMPT_KEYS.checkoutDismissedAt, String(Date.now()));
      }
      if (current === 'exit') session.set(PROMPT_KEYS.exitDismissed, '1');
      return null;
    });
  }, []);

  // Leaving for Google / signing in clears the pending checkout prompt too
  const onLoginStarted = useCallback(() => session.remove(PROMPT_KEYS.pendingCheckout), []);

  const openLogin = useCallback(() => {
    setToast(false);
    setModal('manual');
  }, []);

  const api = useMemo(() => ({ notifyCheckoutHandoff, setRouteActive, openLogin }), [notifyCheckoutHandoff, setRouteActive, openLogin]);

  return (
    <AuthPromptContext.Provider value={api}>
      {children}
      {modal && <AuthModal variant={modal} onClose={closeModal} onLoginStarted={onLoginStarted} />}
      {toast && !modal && (
        <NudgeToast
          onLogin={() => {
            setToast(false);
            setModal('nudge');
          }}
          onClose={dismissToast}
        />
      )}
    </AuthPromptContext.Provider>
  );
}

export const useAuthPrompt = () => useContext(AuthPromptContext);
