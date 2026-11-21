-- Live board: every game in play (or just finished) in the UK and European competitions, kept up to date by tools/poller.mjs
-- with one "fixtures?live=all" call a minute. Read by MyTeamCompanion through a read-only role (select only; no client policies).
create table if not exists public.live_board (
  fixture_id bigint primary key,
  league_id int not null,
  kickoff timestamptz not null,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
-- @@
create index if not exists live_board_kickoff_idx on public.live_board(kickoff);
-- @@
alter table public.live_board enable row level security;
