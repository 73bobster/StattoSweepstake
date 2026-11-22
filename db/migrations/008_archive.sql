-- Each person can remove a game from their own list (archive it) and put it back; nobody else is affected.
alter table public.members add column if not exists archived boolean not null default false;
-- @@
create or replace function public.set_archived(p_sweepstake uuid, p_archived boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.user_id() is null then raise exception 'Not signed in'; end if;
  update public.members set archived = p_archived where sweepstake_id = p_sweepstake and user_id = auth.user_id();
end $$;
-- @@
revoke all on function public.set_archived(uuid, boolean) from public;
-- @@
grant execute on function public.set_archived(uuid, boolean) to authenticated;
