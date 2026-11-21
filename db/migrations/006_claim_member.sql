-- Someone who was dealt in by the host (a 'local' player on the host's phone) can claim their spot later with the invite link
-- and then see and follow their own players on their own phone.
create or replace function public.claimable_members(p_code text)
returns table (id uuid, name text, pick_count bigint)
language sql security definer set search_path = public stable as $$
  select m.id, m.display_name, (select count(*) from public.picks p where p.member_id = m.id)
  from public.members m join public.sweepstakes s on s.id = m.sweepstake_id
  where s.code = upper(p_code) and m.kind = 'local' order by m.joined_at;
$$;
-- @@
create or replace function public.claim_member(p_code text, p_member uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare s public.sweepstakes; m public.members;
begin
  if auth.user_id() is null then raise exception 'Not signed in'; end if;
  select * into s from public.sweepstakes where code = upper(p_code);
  if not found then raise exception 'Invite code not found'; end if;
  if exists (select 1 from public.members where sweepstake_id = s.id and user_id = auth.user_id()) then return s.id; end if;
  select * into m from public.members where id = p_member and sweepstake_id = s.id and kind = 'local' for update;
  if not found then raise exception 'That spot has already been taken'; end if;
  update public.members set user_id = auth.user_id(), kind = 'user' where id = m.id;
  return s.id;
end $$;
-- @@
revoke all on function public.claimable_members(text), public.claim_member(text,uuid) from public;
-- @@
grant execute on function public.claimable_members(text), public.claim_member(text,uuid) to authenticated;
