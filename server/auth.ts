import type { Express, Request, Response } from 'express';
import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { getEnv, IS_PRODUCTION } from './env.ts';
import { getRedisClient } from './transitService.ts';
import { createLimiter, rateLimit, RATE_LIMITS } from './security/rateLimit.ts';
import { requestOrigin } from './security/headers.ts';
import { emailSchema, otpVerifySchema, parseWith, safeNextPath } from './security/validation.ts';
import {
  clientIdSchema,
  mergeRoutes,
  parseSavedRoutes,
  routeImportSchema,
  savedRouteDataSchema,
  type SavedRoute,
} from '../shared/savedRoutes.ts';
import { z } from 'zod';

/**
 * Accounts (Supabase Auth: Google OAuth, email magic link / one-time code) and saved routes.
 *
 * The browser never sees a Supabase token: this server runs the PKCE flow and keeps the session in
 * `HttpOnly; SameSite=Lax` (+ `Secure` in production) cookies, refreshing them as needed. Saved routes
 * are read and written with a client authenticated AS THE USER (anon key + the user's JWT), so the
 * `saved_routes` RLS policies (`auth.uid() = user_id`) are what enforce ownership. No service-role key
 * is used anywhere.
 *
 *   GET    /api/auth/session        { configured, user }
 *   GET    /api/auth/google?next=   302 to Google (via Supabase)
 *   POST   /api/auth/magic-link     { email }  -> email with a link and a code
 *   POST   /api/auth/verify         { email, token }  (the code, for another device)
 *   GET    /api/auth/callback       OAuth / magic-link landing: exchanges the code, sets cookies
 *   POST   /api/auth/logout
 *   GET    /api/routes              the user's saved routes, newest first
 *   PUT    /api/routes/:clientId    save one route { updatedAt, data }
 *   POST   /api/routes/import       merge the guest's local routes { routes }
 *   DELETE /api/routes/:clientId
 */

export function supabaseConfig(): { url: string; anonKey: string } | null {
  const url = getEnv('SUPABASE_URL');
  const anonKey = getEnv('SUPABASE_ANON_KEY') ?? getEnv('SUPABASE_PUBLISHABLE_KEY');
  return url && anonKey ? { url, anonKey } : null;
}

const COOKIE_DEFAULTS = { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax' as const, path: '/' };

/** A Supabase client bound to this request's cookies (reads them, writes refreshed ones back). */
export function supabaseFor(req: Request, res: Response): SupabaseClient | null {
  const cfg = supabaseConfig();
  if (!cfg) return null;
  return createServerClient(cfg.url, cfg.anonKey, {
    cookieOptions: COOKIE_DEFAULTS,
    cookies: {
      getAll: () => parseCookieHeader(req.headers.cookie ?? '').map((c) => ({ name: c.name, value: c.value ?? '' })),
      setAll: (cookies, headers) => {
        if (res.headersSent) return;
        for (const { name, value, options } of cookies) {
          // Whatever the library asks for, auth cookies are never readable by page scripts
          res.append('Set-Cookie', serializeCookieHeader(name, value, { ...options, ...COOKIE_DEFAULTS }));
        }
        for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
      },
    },
  });
}

export interface PublicUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

function publicUser(u: User): PublicUser {
  const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length < 500 ? v : null);
  const avatar = str(meta.avatar_url) ?? str(meta.picture);
  return {
    id: u.id,
    email: u.email ?? null,
    name: str(meta.full_name) ?? str(meta.name),
    avatarUrl: avatar && avatar.startsWith('https://') ? avatar : null,
  };
}

/** The verified user for this request (checked with Supabase, not just decoded), or null. */
async function currentUser(sb: SupabaseClient): Promise<User | null> {
  try {
    const { data, error } = await sb.auth.getUser();
    return error ? null : data.user;
  } catch {
    return null;
  }
}

/** Base URL for links in emails and OAuth redirects. Supabase also checks them against its allowlist. */
function siteUrl(req: Request): string {
  return (getEnv('APP_URL') ?? requestOrigin(req) ?? 'http://localhost:3000').replace(/\/+$/, '');
}

const notConfigured = (res: Response) =>
  res.status(503).json({ error: 'AUTH_DISABLED', message: 'Accounts are not set up on this server.' });

type RouteRow = { client_id: string; data: unknown; updated_at: string };

function rowsToRoutes(rows: RouteRow[] | null): SavedRoute[] {
  return parseSavedRoutes((rows ?? []).map((r) => ({ clientId: r.client_id, updatedAt: new Date(r.updated_at).toISOString(), data: r.data })));
}

/** A client-supplied timestamp, never in the future (so one device can't pin a route as "newest"). */
const clampTime = (iso: string) => new Date(Math.min(Date.parse(iso), Date.now())).toISOString();

const putRouteSchema = z.object({ updatedAt: z.string().datetime({ offset: true }), data: savedRouteDataSchema });

export function registerAuthRoutes(app: Express): void {
  const emailLimiter = createLimiter(RATE_LIMITS.authEmail, getRedisClient);
  const writeLimiter = createLimiter(RATE_LIMITS.routesWrite, getRedisClient);

  app.get('/api/auth/session', async (req, res) => {
    const sb = supabaseFor(req, res);
    if (!sb) return res.json({ configured: false, user: null });
    const user = await currentUser(sb);
    res.json({ configured: true, user: user ? publicUser(user) : null });
  });

  app.get('/api/auth/google', async (req, res) => {
    const sb = supabaseFor(req, res);
    if (!sb) return res.redirect(302, '/?auth=disabled');
    const next = safeNextPath(req.query.next);
    try {
      const { data, error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${siteUrl(req)}/api/auth/callback?next=${encodeURIComponent(next)}`, skipBrowserRedirect: true },
      });
      if (error || !data?.url || !data.url.startsWith('https://')) throw error ?? new Error('no OAuth url');
      res.redirect(302, data.url);
    } catch (err) {
      console.warn('[Auth] Google sign-in could not start:', (err as Error)?.message ?? err);
      res.redirect(302, '/?auth=error');
    }
  });

  app.post('/api/auth/magic-link', rateLimit(RATE_LIMITS.authEmail, emailLimiter), async (req, res) => {
    const body = parseWith(emailSchema, req.body);
    if (!body.ok) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Enter a valid email address.' });
    const sb = supabaseFor(req, res);
    if (!sb) return notConfigured(res);
    const next = safeNextPath((req.body as Record<string, unknown>)?.next);
    const { error } = await sb.auth.signInWithOtp({
      email: body.value.email,
      options: { emailRedirectTo: `${siteUrl(req)}/api/auth/callback?next=${encodeURIComponent(next)}`, shouldCreateUser: true },
    });
    if (error) {
      console.warn('[Auth] magic link failed:', error.message);
      // Same answer whether or not the address exists; only Supabase's own throttle is surfaced
      if (error.status === 429) return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many emails. Try again in a minute.' });
    }
    res.json({ sent: true });
  });

  app.post('/api/auth/verify', rateLimit(RATE_LIMITS.authEmail, emailLimiter), async (req, res) => {
    const body = parseWith(otpVerifySchema, req.body);
    if (!body.ok) return res.status(400).json({ error: 'BAD_REQUEST', message: body.message });
    const sb = supabaseFor(req, res);
    if (!sb) return notConfigured(res);
    const { data, error } = await sb.auth.verifyOtp({ email: body.value.email, token: body.value.token, type: 'email' });
    if (error || !data.user) return res.status(401).json({ error: 'INVALID_CODE', message: 'That code is wrong or has expired.' });
    res.json({ user: publicUser(data.user) });
  });

  app.get('/api/auth/callback', async (req, res) => {
    const next = safeNextPath(req.query.next);
    const done = (status: 'success' | 'error') => {
      const url = new URL(next, 'http://x');
      url.searchParams.set('auth', status);
      res.redirect(302, `${url.pathname}${url.search}${url.hash}`);
    };
    const sb = supabaseFor(req, res);
    const code = typeof req.query.code === 'string' && /^[\w-]{6,512}$/.test(req.query.code) ? req.query.code : null;
    if (!sb || !code) return done('error');
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (error) console.warn('[Auth] code exchange failed:', error.message);
    done(error ? 'error' : 'success');
  });

  app.post('/api/auth/logout', async (req, res) => {
    const sb = supabaseFor(req, res);
    if (sb) await sb.auth.signOut().catch(() => undefined);
    res.json({ ok: true });
  });

  // ── Saved routes (RLS: every query runs as the signed-in user) ──────────────────────────────

  const withUser = async (req: Request, res: Response) => {
    const sb = supabaseFor(req, res);
    if (!sb) {
      notConfigured(res);
      return null;
    }
    const user = await currentUser(sb);
    if (!user) {
      res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Log in to sync routes.' });
      return null;
    }
    return { sb, user };
  };

  const listRoutes = async (sb: SupabaseClient) => {
    const { data, error } = await sb
      .from('saved_routes')
      .select('client_id, data, updated_at')
      .order('updated_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return rowsToRoutes(data as RouteRow[]);
  };

  const upsert = async (sb: SupabaseClient, userId: string, routes: SavedRoute[]) => {
    if (!routes.length) return;
    const { error } = await sb.from('saved_routes').upsert(
      routes.map((r) => ({
        user_id: userId,
        client_id: r.clientId,
        title: r.data.title,
        data: r.data,
        updated_at: clampTime(r.updatedAt),
      })),
      { onConflict: 'user_id,client_id' }
    );
    if (error) throw error;
  };

  const fail = (res: Response, err: unknown) => {
    console.warn('[Routes] Supabase error:', (err as Error)?.message ?? err);
    res.status(502).json({ error: 'UPSTREAM_ERROR', message: 'Could not reach saved routes. Your route is still saved on this device.' });
  };

  app.get('/api/routes', async (req, res) => {
    const ctx = await withUser(req, res);
    if (!ctx) return;
    try {
      res.json({ routes: await listRoutes(ctx.sb) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put('/api/routes/:clientId', rateLimit(RATE_LIMITS.routesWrite, writeLimiter), async (req, res) => {
    const id = clientIdSchema.safeParse(req.params.clientId);
    const body = parseWith(putRouteSchema, req.body);
    if (!id.success || !body.ok) return res.status(400).json({ error: 'BAD_REQUEST', message: body.ok ? 'Bad route id.' : body.message });
    const ctx = await withUser(req, res);
    if (!ctx) return;
    try {
      await upsert(ctx.sb, ctx.user.id, [{ clientId: id.data, updatedAt: body.value.updatedAt, data: body.value.data }]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/routes/import', rateLimit(RATE_LIMITS.routesWrite, writeLimiter), async (req, res) => {
    const body = parseWith(routeImportSchema, req.body);
    if (!body.ok) return res.status(400).json({ error: 'BAD_REQUEST', message: body.message });
    const ctx = await withUser(req, res);
    if (!ctx) return;
    try {
      const remote = await listRoutes(ctx.sb);
      const remoteById = new Map(remote.map((r) => [r.clientId, r]));
      // Only routes that are new to the account, or newer than its copy, are written
      const toWrite = body.value.routes.filter((r) => {
        const prev = remoteById.get(r.clientId);
        return !prev || Date.parse(r.updatedAt) > Date.parse(prev.updatedAt);
      });
      await upsert(ctx.sb, ctx.user.id, toWrite);
      res.json({ routes: mergeRoutes(remote, toWrite), imported: toWrite.length });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete('/api/routes/:clientId', rateLimit(RATE_LIMITS.routesWrite, writeLimiter), async (req, res) => {
    const id = clientIdSchema.safeParse(req.params.clientId);
    if (!id.success) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Bad route id.' });
    const ctx = await withUser(req, res);
    if (!ctx) return;
    const { error } = await ctx.sb.from('saved_routes').delete().eq('client_id', id.data);
    if (error) return fail(res, error);
    res.json({ ok: true });
  });
}
