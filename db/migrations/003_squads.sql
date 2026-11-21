-- Squads live in our own table so the API is only used for fixtures, line-ups and live events.
-- Server-side only (read/written by the Pages Function with the database owner role); RLS on, no client policies.
create table if not exists public.squads (team_id bigint primary key, name text, logo text, league_id int, league_name text, players jsonb, fetched_at timestamptz);
-- @@
alter table public.squads enable row level security;
-- @@
create index if not exists squads_league_idx on public.squads(league_id);
