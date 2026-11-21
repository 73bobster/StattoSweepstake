-- Favourite leagues and teams per signed-in user. Only reachable through these two functions (RLS on, no table policies).
create table if not exists public.user_prefs (
  user_id text primary key, leagues jsonb not null default '[]', teams jsonb not null default '[]', updated_at timestamptz not null default now());
-- @@
alter table public.user_prefs enable row level security;
-- @@
create or replace function public.get_prefs() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('leagues', leagues, 'teams', teams) from public.user_prefs where user_id = auth.user_id()), '{"leagues":[],"teams":[]}'::jsonb)
$$;
-- @@
create or replace function public.save_prefs(p_leagues jsonb, p_teams jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.user_id() is null then raise exception 'Sign in first'; end if;
  if jsonb_typeof(coalesce(p_leagues, '[]')) <> 'array' or jsonb_typeof(coalesce(p_teams, '[]')) <> 'array' then raise exception 'Bad favourites'; end if;
  if jsonb_array_length(coalesce(p_leagues, '[]')) > 30 or jsonb_array_length(coalesce(p_teams, '[]')) > 50 then raise exception 'Too many favourites'; end if;
  insert into public.user_prefs(user_id, leagues, teams) values (auth.user_id(), coalesce(p_leagues, '[]'), coalesce(p_teams, '[]'))
  on conflict (user_id) do update set leagues = excluded.leagues, teams = excluded.teams, updated_at = now();
end $$;
-- @@
revoke all on function public.get_prefs(), public.save_prefs(jsonb, jsonb) from public;
-- @@
grant execute on function public.get_prefs(), public.save_prefs(jsonb, jsonb) to authenticated;
-- @@
notify pgrst, 'reload schema';
