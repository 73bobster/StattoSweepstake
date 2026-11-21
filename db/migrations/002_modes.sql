-- Game modes: one-phone / vs-computer / friends, random or draft.
-- Members can now be 'user' (a real signed-in person), 'local' (a friend the host plays for on one phone) or 'cpu' (virtual rival).
alter table public.members add column if not exists kind text not null default 'user';
-- @@
alter table public.members drop constraint if exists members_kind_check;
-- @@
alter table public.members add constraint members_kind_check check (kind in ('user','local','cpu'));
-- @@
alter table public.sweepstakes add column if not exists pool jsonb;
-- @@
alter table public.sweepstakes drop constraint if exists sweepstakes_status_check;
-- @@
alter table public.sweepstakes add constraint sweepstakes_status_check check (status in ('setup','drafting','drawn'));
-- @@
alter table public.picks drop constraint if exists picks_slot_check;
-- @@
alter table public.picks add constraint picks_slot_check check (slot in ('starter','sub'));
-- @@
drop function if exists public.create_sweepstake(text,text,bigint,jsonb,jsonb,jsonb,jsonb);
-- @@
create or replace function public.set_virtual_members(p_sweepstake uuid, p_members jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_host(p_sweepstake) then raise exception 'Only the host can change who is playing'; end if;
  if (select status from public.sweepstakes where id = p_sweepstake) <> 'setup' then raise exception 'Reopen the draw first'; end if;
  delete from public.members where sweepstake_id = p_sweepstake and kind <> 'user';
  insert into public.members (sweepstake_id, user_id, display_name, kind)
  select p_sweepstake, 'v:' || gen_random_uuid()::text, left(trim(x->>'name'), 30), case when x->>'kind' = 'cpu' then 'cpu' else 'local' end
  from jsonb_array_elements(coalesce(p_members, '[]'::jsonb)) x
  where length(trim(coalesce(x->>'name', ''))) > 0;
end $$;
-- @@
create or replace function public.create_sweepstake(
  p_name text, p_display_name text, p_fixture_id bigint, p_fixture jsonb,
  p_rules jsonb, p_awards jsonb, p_draw_config jsonb, p_members jsonb default '[]'::jsonb
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
  perform public.set_virtual_members(s.id, p_members);
  return s;
end $$;
-- @@
-- Draft: host stores the player pool and the pick order; status becomes 'drafting'.
create or replace function public.start_draft(p_sweepstake uuid, p_order jsonb, p_pool jsonb, p_each int)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_host(p_sweepstake) then raise exception 'Only the host can start the draft'; end if;
  delete from public.picks where sweepstake_id = p_sweepstake;
  update public.sweepstakes
     set status = 'drafting', pool = p_pool,
         draw_config = draw_config || jsonb_build_object('order', p_order, 'each', p_each)
   where id = p_sweepstake;
end $$;
-- @@
-- One draft pick (snake order). The member whose turn it is - or the host, for anyone - may pick.
create or replace function public.draft_pick(p_sweepstake uuid, p_member uuid, p_player bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare s public.sweepstakes; k int; n int; each_n int; idx int; turn uuid; pl jsonb; m public.members;
begin
  select * into s from public.sweepstakes where id = p_sweepstake for update;
  if not found or s.status <> 'drafting' then raise exception 'The draft is not running'; end if;
  select * into m from public.members where id = p_member and sweepstake_id = p_sweepstake;
  if not found then raise exception 'Unknown player'; end if;
  if not (public.is_host(p_sweepstake) or m.user_id = auth.user_id()) then raise exception 'Not your pick'; end if;
  k := jsonb_array_length(s.draw_config->'order');
  each_n := (s.draw_config->>'each')::int;
  select count(*) into n from public.picks where sweepstake_id = p_sweepstake;
  idx := n % k; if (n / k) % 2 = 1 then idx := k - 1 - idx; end if;
  turn := ((s.draw_config->'order')->>idx)::uuid;
  if turn <> p_member then raise exception 'It is not their turn'; end if;
  select x into pl from jsonb_array_elements(s.pool) x where (x->>'id')::bigint = p_player;
  if pl is null then raise exception 'Player not in the pool'; end if;
  if exists (select 1 from public.picks where sweepstake_id = p_sweepstake and player_id = p_player) then raise exception 'Already picked'; end if;
  insert into public.picks (sweepstake_id, member_id, player_id, player_name, number, photo, side, team_id, role, slot)
  values (p_sweepstake, p_member, p_player, pl->>'name', nullif(pl->>'number','')::int, pl->>'photo', pl->>'side', nullif(pl->>'teamId','')::bigint, pl->>'role',
          case when (pl->>'bench') = 'true' then 'sub' else 'starter' end);
  if n + 1 >= k * each_n then update public.sweepstakes set status = 'drawn', pool = null where id = p_sweepstake; end if;
end $$;
-- @@
create or replace function public.reopen_draw(p_sweepstake uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_host(p_sweepstake) then raise exception 'Only the host can reopen the draw'; end if;
  delete from public.picks where sweepstake_id = p_sweepstake;
  update public.sweepstakes set status = 'setup', pool = null where id = p_sweepstake;
end $$;
-- @@
revoke all on function public.set_virtual_members(uuid,jsonb), public.create_sweepstake(text,text,bigint,jsonb,jsonb,jsonb,jsonb,jsonb),
  public.start_draft(uuid,jsonb,jsonb,int), public.draft_pick(uuid,uuid,bigint) from public;
-- @@
grant execute on function public.set_virtual_members(uuid,jsonb), public.create_sweepstake(text,text,bigint,jsonb,jsonb,jsonb,jsonb,jsonb),
  public.start_draft(uuid,jsonb,jsonb,int), public.draft_pick(uuid,uuid,bigint) to authenticated;
-- @@
create or replace function public.update_setup(p_sweepstake uuid, p_draw_config jsonb, p_rules jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_host(p_sweepstake) then raise exception 'Only the host can change the set-up'; end if;
  if (select status from public.sweepstakes where id = p_sweepstake) <> 'setup' then raise exception 'Reopen the draw first'; end if;
  update public.sweepstakes set draw_config = p_draw_config, rules = p_rules where id = p_sweepstake;
end $$;
-- @@
revoke all on function public.update_setup(uuid,jsonb,jsonb) from public;
-- @@
grant execute on function public.update_setup(uuid,jsonb,jsonb) to authenticated;
-- @@
-- (draft_pick as above, but clears the stored pool when the draft completes: set status = 'drawn', pool = null)
