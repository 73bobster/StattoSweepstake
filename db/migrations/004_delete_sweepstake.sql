-- Host can delete a sweepstake. Members and picks go with it (on delete cascade); shared fixture_state is untouched.
create or replace function public.delete_sweepstake(p_sweepstake uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_host(p_sweepstake) then raise exception 'Only the host can delete this sweepstake'; end if;
  delete from public.sweepstakes where id = p_sweepstake;
end $$;
-- @@
revoke all on function public.delete_sweepstake(uuid) from public;
-- @@
grant execute on function public.delete_sweepstake(uuid) to authenticated;
-- @@
notify pgrst, 'reload schema';
