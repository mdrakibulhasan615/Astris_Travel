-- Saved routes for signed-in travellers (Supabase free tier).
-- Each row is one route: stops, dates, party size and ticket choices (~1–3 KB of JSON, no fares).
-- Ownership is enforced by Row-Level Security: every policy requires auth.uid() = user_id, so a user
-- can never read, insert, change or delete another user's rows. The API (server/auth.ts) queries as
-- the signed-in user with the anon key + the user's JWT; no service-role key is used.

create table if not exists public.saved_routes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id   text not null check (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  title       text not null default 'My trip' check (char_length(title) <= 120),
  data        jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 32768),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint saved_routes_user_client_unique unique (user_id, client_id)
);

create index if not exists saved_routes_user_updated_idx on public.saved_routes (user_id, updated_at desc);

-- RLS on, and forced even for the table owner
alter table public.saved_routes enable row level security;
alter table public.saved_routes force row level security;

-- Anonymous visitors get nothing; signed-in users get only the statements the policies allow
revoke all on table public.saved_routes from anon;
revoke all on table public.saved_routes from public;
grant select, insert, update, delete on table public.saved_routes to authenticated;

drop policy if exists "saved_routes_select_own" on public.saved_routes;
create policy "saved_routes_select_own" on public.saved_routes
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "saved_routes_insert_own" on public.saved_routes;
create policy "saved_routes_insert_own" on public.saved_routes
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "saved_routes_update_own" on public.saved_routes;
create policy "saved_routes_update_own" on public.saved_routes
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "saved_routes_delete_own" on public.saved_routes;
create policy "saved_routes_delete_own" on public.saved_routes
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- A user_id can never be moved to another account by an update
create or replace function public.saved_routes_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.user_id <> old.user_id then
    raise exception 'user_id cannot be changed';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.saved_routes where user_id = new.user_id) >= 100 then
    raise exception 'saved route limit reached (100)';
  end if;
  return new;
end;
$$;

drop trigger if exists saved_routes_guard on public.saved_routes;
create trigger saved_routes_guard
  before insert or update on public.saved_routes
  for each row execute function public.saved_routes_guard();
