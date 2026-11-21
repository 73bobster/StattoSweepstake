-- View-only guests: anyone with the invite code can join after the draw and watch. They have no players, are not on the table,
-- and cannot change anything (every change is host-only in the database).
alter table public.members drop constraint if exists members_kind_check;
-- @@
alter table public.members add constraint members_kind_check check (kind in ('user','local','cpu','viewer'));
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
  insert into public.members (sweepstake_id, user_id, display_name, kind)
  values (s.id, auth.user_id(), left(trim(p_display_name), 30), case when s.status = 'setup' then 'user' else 'viewer' end);
  return s.id;
end $$;
-- @@
create or replace function public.set_virtual_members(p_sweepstake uuid, p_members jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_host(p_sweepstake) then raise exception 'Only the host can change who is playing'; end if;
  if (select status from public.sweepstakes where id = p_sweepstake) <> 'setup' then raise exception 'Reopen the draw first'; end if;
  delete from public.members where sweepstake_id = p_sweepstake and kind in ('local','cpu');
  insert into public.members (sweepstake_id, user_id, display_name, kind)
  select p_sweepstake, 'v:' || gen_random_uuid()::text, left(trim(x->>'name'), 30), case when x->>'kind' = 'cpu' then 'cpu' else 'local' end
  from jsonb_array_elements(coalesce(p_members, '[]'::jsonb)) x
  where length(trim(coalesce(x->>'name', ''))) > 0;
end $$;
