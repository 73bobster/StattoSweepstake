-- Statto Sweepstake - Neon Postgres schema (Neon Auth + Data API, RLS enforced).
-- Applied to Neon project "stattosweepstake". Statements are separated by "-- @@" so they can be run one by one.

create table if not exists public.sweepstakes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  creator_id text not null default auth.user_id(),
  fixture_id bigint not null,
  fixture jsonb not null,
  rules jsonb not null,
  awards jsonb not null,
  draw_config jsonb not null,
  status text not null default 'setup' check (status in ('setup','drawn')),
  created_at timestamptz not null default now()
);
-- @@
create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  sweepstake_id uuid not null references public.sweepstakes(id) on delete cascade,
  user_id text not null default auth.user_id(),
  display_name text not null,
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  unique (sweepstake_id, user_id)
);
-- @@
create table if not exists public.picks (
  id uuid primary key default gen_random_uuid(),
  sweepstake_id uuid not null references public.sweepstakes(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  player_id bigint not null,
  player_name text not null,
  number int,
  photo text,
  side text not null check (side in ('home','away')),
  team_id bigint,
  role text not null check (role in ('GK','DEF','MID','ATT')),
  slot text not null check (slot in ('starter','sub')),
  unique (sweepstake_id, player_id)
);
-- @@
create table if not exists public.fixture_state (
  fixture_id bigint primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
-- @@
create table if not exists public.api_cache (
  key text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);
-- @@
create table if not exists public.api_usage (
  day date primary key,
  calls int not null default 0
);
-- @@
create index if not exists members_user_idx on public.members(user_id);
-- @@
create index if not exists picks_sweep_idx on public.picks(sweepstake_id);
-- @@
alter table public.sweepstakes enable row level security;
alter table public.members enable row level security;
alter table public.picks enable row level security;
alter table public.fixture_state enable row level security;
alter table public.api_cache enable row level security;
alter table public.api_usage enable row level security;
-- @@
create or replace function public.is_member(sid uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.members where sweepstake_id = sid and user_id = auth.user_id());
$$;
-- @@
create or replace function public.is_host(sid uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.sweepstakes where id = sid and creator_id = auth.user_id());
$$;
-- @@
create policy sweep_select on public.sweepstakes for select to authenticated
  using (public.is_member(id) or creator_id = auth.user_id());
-- @@
create policy members_select on public.members for select to authenticated
  using (public.is_member(sweepstake_id));
-- @@
create policy members_update_self on public.members for update to authenticated
  using (user_id = auth.user_id()) with check (user_id = auth.user_id());
-- @@
create policy picks_select on public.picks for select to authenticated
  using (public.is_member(sweepstake_id));
-- @@
create policy fixture_state_select on public.fixture_state for select to authenticated using (true);
-- @@
create or replace function public.create_sweepstake(
  p_name text, p_display_name text, p_fixture_id bigint, p_fixture jsonb,
  p_rules jsonb, p_awards jsonb, p_draw_config jsonb
) returns public.sweepstakes
language plpgsql security definer set search_path = public as $$
declare s public.sweepstakes; c text;
begin
  if auth.user_id() is null then raise exception 'Not signed in'; end if;
  loop
    c := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.sweepstakes where code = c);
  end loop;
  insert into public.sweepstakes (code, name, creator_id, fixture_id, fixture, rules, awards, draw_config)
  values (c, left(p_name, 40), auth.user_id(), p_fixture_id, p_fixture, p_rules, p_awards, p_draw_config)
  returning * into s;
  insert into public.members (sweepstake_id, user_id, display_name, is_host)
  values (s.id, auth.user_id(), left(trim(p_display_name), 30), true);
  return s;
end $$;
-- @@
create or replace function public.preview_sweepstake(p_code text)
returns table (id uuid, name text, fixture jsonb, status text, member_count bigint)
language sql security definer set search_path = public stable as $$
  select s.id, s.name, s.fixture, s.status, (select count(*) from public.members m where m.sweepstake_id = s.id)
  from public.sweepstakes s where s.code = upper(p_code);
$$;
-- @@
create or replace function public.join_sweepstake(p_code text, p_display_name text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare s public.sweepstakes;
begin
  if auth.user_id() is null then raise exception 'Not signed in'; end if;
  select * into s from public.sweepstakes where code = upper(p_code);
  if not found then raise exception 'Invite code not found'; end if;
  if exists (select 1 from public.members where sweepstake_id = s.id and user_id = auth.user_id()) then return s.id; end if;
  if s.status <> 'setup' then raise exception 'The draw has already happened - ask the host to reopen it'; end if;
  insert into public.members (sweepstake_id, user_id, display_name) values (s.id, auth.user_id(), left(trim(p_display_name), 30));
  return s.id;
end $$;
-- @@
create or replace function public.save_draw(p_sweepstake uuid, p_picks jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_host(p_sweepstake) then raise exception 'Only the host can draw'; end if;
  delete from public.picks where sweepstake_id = p_sweepstake;
  insert into public.picks (sweepstake_id, member_id, player_id, player_name, number, photo, side, team_id, role, slot)
  select p_sweepstake, (x->>'member_id')::uuid, (x->>'player_id')::bigint, x->>'player_name',
         nullif(x->>'number','')::int, x->>'photo', x->>'side', nullif(x->>'team_id','')::bigint, x->>'role', x->>'slot'
  from jsonb_array_elements(p_picks) x
  where exists (select 1 from public.members m where m.id = (x->>'member_id')::uuid and m.sweepstake_id = p_sweepstake);
  update public.sweepstakes set status = 'drawn' where id = p_sweepstake;
end $$;
-- @@
create or replace function public.reopen_draw(p_sweepstake uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_host(p_sweepstake) then raise exception 'Only the host can reopen the draw'; end if;
  delete from public.picks where sweepstake_id = p_sweepstake;
  update public.sweepstakes set status = 'setup' where id = p_sweepstake;
end $$;
-- @@
create or replace function public.update_rules(p_sweepstake uuid, p_rules jsonb, p_awards jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_host(p_sweepstake) then raise exception 'Only the host can change the scoring'; end if;
  update public.sweepstakes set rules = p_rules, awards = p_awards where id = p_sweepstake;
end $$;
-- @@
revoke all on function public.is_member(uuid), public.is_host(uuid), public.create_sweepstake(text,text,bigint,jsonb,jsonb,jsonb,jsonb),
  public.preview_sweepstake(text), public.join_sweepstake(text,text), public.save_draw(uuid,jsonb), public.reopen_draw(uuid), public.update_rules(uuid,jsonb,jsonb) from public;
-- @@
grant usage on schema public to authenticated;
-- @@
grant select on public.sweepstakes, public.members, public.picks, public.fixture_state to authenticated;
-- @@
grant update (display_name) on public.members to authenticated;
-- @@
grant execute on function public.is_member(uuid), public.is_host(uuid), public.create_sweepstake(text,text,bigint,jsonb,jsonb,jsonb,jsonb),
  public.preview_sweepstake(text), public.join_sweepstake(text,text), public.save_draw(uuid,jsonb), public.reopen_draw(uuid), public.update_rules(uuid,jsonb,jsonb) to authenticated;
