import { useCallback, useEffect, useRef, useState } from 'react';
import type { Trip } from '../shared/types.ts';
import {
  decodeRouteLink,
  encodeRouteLink,
  newRouteId,
  parseSavedRoutes,
  ROUTE_LINK_PARAM,
  routeDataFromTrip,
  routeSignature,
  type SavedRoute,
  type SavedRouteData,
} from '../shared/savedRoutes.ts';
import { useAuth } from './context/AuthContext.tsx';
import { activeGuestRoute, migrateGuestRoutes, safeStorage, upsertGuestRoute } from './routeStorage.ts';

/**
 * Hybrid route persistence:
 *  - guests: the route is written to `localStorage` on every change (debounced), zero cloud writes;
 *  - signed in: also saved to the account (`PUT /api/routes/:id`, Supabase free tier, RLS-protected),
 *    and on login the local routes are merged into the account once;
 *  - anyone: `copySyncLink()` puts the whole route in a compressed `#r=` link (the hash never reaches
 *    a server log) that opens it on another device.
 *
 * On load the route comes from a `#r=` link if there is one, else the last active local route, and is
 * handed to `onRestore` once the app has finished its own initial load.
 */

export type SyncStatus = 'local' | 'syncing' | 'synced' | 'error';

const LOCAL_DEBOUNCE_MS = 600;
const CLOUD_DEBOUNCE_MS = 2500;

async function importToAccount(routes: SavedRoute[]): Promise<{ routes: SavedRoute[]; imported: number }> {
  const res = await fetch('/api/routes/import', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routes }),
  });
  if (!res.ok) throw new Error(`import failed (${res.status})`);
  const data = (await res.json()) as { routes?: unknown; imported?: number };
  return { routes: parseSavedRoutes(data.routes), imported: Number(data.imported) || 0 };
}

async function putRoute(route: SavedRoute): Promise<boolean> {
  try {
    const res = await fetch(`/api/routes/${encodeURIComponent(route.clientId)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedAt: route.updatedAt, data: route.data }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function readLinkToken(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  return params.get(ROUTE_LINK_PARAM);
}

function clearLinkToken() {
  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState(null, '', `${url.pathname}${url.search}`);
}

export function useRouteStorage(opts: {
  trip: Trip;
  /** The app finished its initial load, so a restored route won't be overwritten by it. */
  ready: boolean;
  onRestore: (data: SavedRouteData) => void;
}) {
  const { trip, ready, onRestore } = opts;
  const { user } = useAuth();
  const storageRef = useRef(safeStorage());
  const routeIdRef = useRef<string>(activeGuestRoute(storageRef.current)?.clientId ?? newRouteId());
  const lastSignatureRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  const [status, setStatus] = useState<SyncStatus>('local');
  const [hasRoute, setHasRoute] = useState(false);

  const restore = useCallback((data: SavedRouteData) => {
    lastSignatureRef.current = routeSignature(data);
    onRestoreRef.current(data);
  }, []);

  // 1. Restore once: a share link wins over the local copy
  useEffect(() => {
    if (!ready || restoredRef.current) return;
    restoredRef.current = true;
    const token = readLinkToken();
    void (async () => {
      if (token) {
        const data = await decodeRouteLink(token);
        clearLinkToken();
        if (data) {
          routeIdRef.current = newRouteId(); // an opened link becomes its own recent route
          upsertGuestRoute(storageRef.current, routeIdRef.current, data);
          restore(data);
          return;
        }
        console.warn('[Routes] the route link is invalid or damaged; ignoring it');
      }
      const local = activeGuestRoute(storageRef.current);
      if (local) {
        routeIdRef.current = local.clientId;
        restore(local.data);
      }
    })();
  }, [ready, restore]);

  // A link pasted into a tab that already has the app open only changes the hash
  useEffect(() => {
    if (!ready) return;
    const onHash = async () => {
      const token = readLinkToken();
      if (!token) return;
      const data = await decodeRouteLink(token);
      clearLinkToken();
      if (!data) return;
      routeIdRef.current = newRouteId();
      upsertGuestRoute(storageRef.current, routeIdRef.current, data);
      restore(data);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [ready, restore]);

  // 2. Save on change: local first (debounced), then the account when signed in
  const data = routeDataFromTrip(trip);
  const signature = data && data.stops.length >= 2 ? routeSignature(data) : null;
  useEffect(() => setHasRoute(signature !== null), [signature]);

  useEffect(() => {
    if (!ready || !restoredRef.current || !signature || !data) return;
    if (signature === lastSignatureRef.current) return;
    const local = window.setTimeout(() => {
      lastSignatureRef.current = signature;
      upsertGuestRoute(storageRef.current, routeIdRef.current, data);
      setStatus(user ? 'syncing' : 'local');
    }, LOCAL_DEBOUNCE_MS);
    return () => window.clearTimeout(local);
    // `data` is derived from `signature`'s inputs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, ready, user]);

  useEffect(() => {
    if (!user || !signature) return;
    const cloud = window.setTimeout(async () => {
      const route = activeGuestRoute(storageRef.current);
      if (!route) return;
      setStatus('syncing');
      setStatus((await putRoute(route)) ? 'synced' : 'error');
    }, CLOUD_DEBOUNCE_MS);
    return () => window.clearTimeout(cloud);
  }, [signature, user]);

  // 3. Login: merge local routes into the account once; pick up a route from another device
  useEffect(() => {
    if (!user || !ready) return;
    let cancelled = false;
    setStatus('syncing');
    migrateGuestRoutes(storageRef.current, user.id, importToAccount)
      .then((result) => {
        if (cancelled) return;
        setStatus('synced');
        if (!hasRoute && result.routes[0] && !result.skipped) {
          routeIdRef.current = result.routes[0].clientId;
          upsertGuestRoute(storageRef.current, result.routes[0].clientId, result.routes[0].data, new Date(result.routes[0].updatedAt));
          restore(result.routes[0].data);
        }
      })
      .catch((err) => {
        if (!cancelled) setStatus('error');
        console.warn('[Routes] could not merge local routes into the account:', err);
      });
    return () => {
      cancelled = true;
    };
    // Runs per account, not per edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, ready]);

  /** Copies a link that opens the current route on any device. Resolves to false if nothing to copy. */
  const copySyncLink = useCallback(async (): Promise<string | null> => {
    const current = routeDataFromTrip(trip);
    if (!current) return null;
    const link = `${window.location.origin}/#${ROUTE_LINK_PARAM}=${await encodeRouteLink(current)}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      window.prompt('Copy this link to open the route on another device:', link);
    }
    return link;
  }, [trip]);

  /** Start a fresh route id (e.g. after "reset trip"), so the previous one stays in recent routes. */
  const startNewRoute = useCallback(() => {
    routeIdRef.current = newRouteId();
    lastSignatureRef.current = null;
  }, []);

  return { status: user ? status : ('local' as SyncStatus), hasRoute, copySyncLink, startNewRoute };
}
