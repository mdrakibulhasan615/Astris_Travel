import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activeGuestRoute, loadGuestStore, MIGRATED_KEY, migrateGuestRoutes, upsertGuestRoute, type StorageLike } from './routeStorage.ts';
import {
  decodeRouteLink,
  encodeRouteLink,
  GUEST_ROUTES_KEY,
  mergeRoutes,
  routeDataFromTrip,
  type SavedRoute,
  type SavedRouteData,
} from '../shared/savedRoutes.ts';

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

const stop = (id: string, city: string, code: string, arrival: string, departure: string) => ({
  id,
  city,
  country: 'X',
  iataCode: code,
  lat: 1,
  lng: 2,
  stayNights: 2,
  arrivalDate: arrival,
  departureDate: departure,
});

const routeA: SavedRouteData = {
  v: 1,
  title: 'Guest trip',
  travelers: 2,
  stops: [stop('s1', 'Kuala Lumpur', 'KUL', '2026-12-01', '2026-12-01'), stop('s2', 'Istanbul', 'IST', '2026-12-02', '2026-12-05')],
};
const routeB: SavedRouteData = { ...routeA, title: 'Phone trip', stops: [routeA.stops[1], routeA.stops[0]] };

describe('guest localStorage store', () => {
  it('saves the active route under astris_guest_routes and reads it back', () => {
    const storage = memoryStorage();
    upsertGuestRoute(storage, 'route_aaaaaaaa', routeA);
    assert.ok(storage.map.get(GUEST_ROUTES_KEY));
    assert.deepEqual(activeGuestRoute(storage)?.data, routeA);
  });

  it('ignores tampered or corrupt storage instead of crashing', () => {
    const storage = memoryStorage();
    storage.setItem(GUEST_ROUTES_KEY, '{not json');
    assert.deepEqual(loadGuestStore(storage).routes, []);
    storage.setItem(GUEST_ROUTES_KEY, JSON.stringify({ activeId: 'x', routes: [{ clientId: 'bad', data: { evil: true } }] }));
    assert.deepEqual(loadGuestStore(storage).routes, []);
  });

  it('strips markup from route text', () => {
    const data = routeDataFromTrip({ title: '<img src=x onerror=alert(1)>Trip', travelers: 1, stops: routeA.stops.map((s, i) => ({ ...s, order: i })) });
    assert.equal(data?.title, 'img src=x onerror=alert(1)Trip');
  });
});

describe('guest → account migration on login', () => {
  const remote: SavedRoute = { clientId: 'route_bbbbbbbb', updatedAt: '2026-11-01T10:00:00.000Z', data: routeB };

  it('uploads local routes, merges account routes in, keeps the active route, and runs once', async () => {
    const storage = memoryStorage();
    upsertGuestRoute(storage, 'route_aaaaaaaa', routeA, new Date('2026-11-10T10:00:00.000Z'));
    let uploaded: SavedRoute[] = [];
    let importCalls = 0;
    const importRoutes = async (routes: SavedRoute[]) => {
      importCalls++;
      uploaded = routes;
      return { routes: mergeRoutes([remote], routes), imported: routes.length };
    };

    const result = await migrateGuestRoutes(storage, 'user-1', importRoutes);
    assert.equal(result.skipped, false);
    assert.deepEqual(uploaded.map((r) => r.clientId), ['route_aaaaaaaa']);
    assert.deepEqual(result.routes.map((r) => r.clientId), ['route_aaaaaaaa', 'route_bbbbbbbb']);
    assert.equal(loadGuestStore(storage).activeId, 'route_aaaaaaaa');
    assert.equal(loadGuestStore(storage).routes.length, 2);
    assert.equal(storage.getItem(MIGRATED_KEY), 'user-1');

    const again = await migrateGuestRoutes(storage, 'user-1', importRoutes);
    assert.equal(again.skipped, true);
    assert.equal(importCalls, 1);
  });

  it('leaves local storage untouched and retries later when the import fails', async () => {
    const storage = memoryStorage();
    upsertGuestRoute(storage, 'route_aaaaaaaa', routeA);
    const before = storage.map.get(GUEST_ROUTES_KEY);
    await assert.rejects(migrateGuestRoutes(storage, 'user-1', async () => Promise.reject(new Error('502'))));
    assert.equal(storage.map.get(GUEST_ROUTES_KEY), before);
    assert.equal(storage.getItem(MIGRATED_KEY), null);
  });

  it('newer copy wins when the same route exists on both sides', () => {
    const older: SavedRoute = { clientId: 'route_aaaaaaaa', updatedAt: '2026-11-01T00:00:00.000Z', data: routeB };
    const newer: SavedRoute = { clientId: 'route_aaaaaaaa', updatedAt: '2026-11-02T00:00:00.000Z', data: routeA };
    assert.deepEqual(mergeRoutes([older], [newer]), [newer]);
    assert.deepEqual(mergeRoutes([newer], [older]), [newer]);
  });
});

describe('compressed route sync link', () => {
  it('round-trips a route and is shorter than the JSON', async () => {
    const token = await encodeRouteLink(routeA);
    assert.match(token, /^[zj][A-Za-z0-9_-]+$/);
    assert.deepEqual(await decodeRouteLink(token), routeA);
  });

  it('rejects damaged or hostile links', async () => {
    assert.equal(await decodeRouteLink('z!!!'), null);
    assert.equal(await decodeRouteLink('zAAAA'), null);
    const evil = Buffer.from(JSON.stringify({ v: 1, title: 'x', travelers: 1, stops: [{ id: 'a', city: 'c', lat: 999 }] })).toString('base64url');
    assert.equal(await decodeRouteLink(`j${evil}`), null);
  });
});
