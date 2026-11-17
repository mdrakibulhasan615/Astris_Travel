import {
  GUEST_ROUTES_KEY,
  MAX_SAVED_ROUTES,
  mergeRoutes,
  parseSavedRoutes,
  type SavedRoute,
  type SavedRouteData,
} from '../shared/savedRoutes.ts';

/**
 * The guest route store in `localStorage` (`astris_guest_routes`): the active route and the recently
 * viewed ones, newest first. It holds route JSON only (stops, dates, party, ticket choices); auth
 * tokens never live here, they are HttpOnly cookies the page cannot read. No DOM imports, so the
 * functions run under `tsx --test` with an in-memory Storage.
 */

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface GuestStore {
  v: 1;
  activeId: string | null;
  routes: SavedRoute[];
}

const EMPTY: GuestStore = { v: 1, activeId: null, routes: [] };
/** Which account the local routes were last merged into (so a login merges once, not on every load). */
export const MIGRATED_KEY = 'astris_routes_migrated_for';

export function safeStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    const probe = '__astris_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null; // private mode, blocked storage, SSR
  }
}

export function loadGuestStore(storage: StorageLike | null): GuestStore {
  if (!storage) return { ...EMPTY, routes: [] };
  try {
    const raw = JSON.parse(storage.getItem(GUEST_ROUTES_KEY) ?? 'null') as Partial<GuestStore> | null;
    if (!raw || typeof raw !== 'object') return { ...EMPTY, routes: [] };
    const routes = parseSavedRoutes(raw.routes).slice(0, MAX_SAVED_ROUTES);
    const activeId = typeof raw.activeId === 'string' && routes.some((r) => r.clientId === raw.activeId) ? raw.activeId : null;
    return { v: 1, activeId, routes };
  } catch {
    return { ...EMPTY, routes: [] };
  }
}

export function saveGuestStore(storage: StorageLike | null, store: GuestStore): void {
  if (!storage) return;
  try {
    storage.setItem(GUEST_ROUTES_KEY, JSON.stringify({ v: 1, activeId: store.activeId, routes: store.routes.slice(0, MAX_SAVED_ROUTES) }));
  } catch {
    // Quota exceeded: the route simply isn't persisted this time
  }
}

/** Saves `data` as route `clientId`, makes it active and moves it to the front. */
export function upsertGuestRoute(
  storage: StorageLike | null,
  clientId: string,
  data: SavedRouteData,
  now: Date = new Date()
): SavedRoute {
  const store = loadGuestStore(storage);
  const route: SavedRoute = { clientId, updatedAt: now.toISOString(), data };
  store.routes = [route, ...store.routes.filter((r) => r.clientId !== clientId)].slice(0, MAX_SAVED_ROUTES);
  store.activeId = clientId;
  saveGuestStore(storage, store);
  return route;
}

export function activeGuestRoute(storage: StorageLike | null): SavedRoute | null {
  const store = loadGuestStore(storage);
  return store.routes.find((r) => r.clientId === store.activeId) ?? null;
}

export interface MigrationResult {
  /** Local + account routes after the merge, newest first. */
  routes: SavedRoute[];
  imported: number;
  skipped: boolean;
}

/**
 * Guest → account migration, run once per account after login: sends every local route to
 * `POST /api/routes/import` (the server writes those that are new or newer), then stores the merged
 * list locally so routes saved on other devices are available here too. The active route is kept.
 * A failed request leaves local storage untouched and is retried on the next load.
 */
export async function migrateGuestRoutes(
  storage: StorageLike | null,
  userId: string,
  importRoutes: (routes: SavedRoute[]) => Promise<{ routes: SavedRoute[]; imported: number }>
): Promise<MigrationResult> {
  const store = loadGuestStore(storage);
  if (storage?.getItem(MIGRATED_KEY) === userId) return { routes: store.routes, imported: 0, skipped: true };
  const answer = await importRoutes(store.routes);
  const merged = mergeRoutes(store.routes, parseSavedRoutes(answer.routes));
  saveGuestStore(storage, { v: 1, activeId: store.activeId ?? merged[0]?.clientId ?? null, routes: merged });
  try {
    storage?.setItem(MIGRATED_KEY, userId);
  } catch {
    // ignore
  }
  return { routes: merged, imported: answer.imported, skipped: false };
}
