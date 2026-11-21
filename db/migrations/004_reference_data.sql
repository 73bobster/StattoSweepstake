-- Shared football reference data, used by Statto Sweepstake, the quiz, MatchStatto and the future Football Draft.
-- Lives in its own schema (ref). Server-side only: RLS on, no client policies; apps read it through their own API functions.
-- Principle: our own ids everywhere; provider ids (API-Football, Sportmonks, Wikidata...) live in ref.external_ids.
create schema if not exists ref;
-- @@
create table if not exists ref.nations (code text primary key, name text not null);
-- @@
create table if not exists ref.competitions (
  id bigserial primary key, name text not null, nation_code text references ref.nations(code),
  kind text not null default 'league' check (kind in ('league','cup','international')),
  tier int, level text not null default 'pro' check (level in ('pro','semi','grassroots')),
  active boolean not null default true);
-- @@
create table if not exists ref.competition_seasons (
  id bigserial primary key, competition_id bigint not null references ref.competitions(id),
  season int not null, starts_on date, ends_on date, is_current boolean not null default false,
  unique (competition_id, season));
-- @@
create table if not exists ref.clubs (
  id bigserial primary key, name text not null, short_name text, code text, nation_code text references ref.nations(code),
  founded int, venue_name text, venue_city text, venue_capacity int, logo_url text,
  level text not null default 'pro' check (level in ('pro','semi','grassroots')),
  is_national_team boolean not null default false, updated_at timestamptz not null default now());
-- @@
create table if not exists ref.players (
  id bigserial primary key, full_name text not null, first_name text, last_name text, known_as text,
  name_key text not null, birth_date date, birth_place text, birth_nation text, nationality text,
  height_cm int, weight_kg int, photo_url text,
  position text check (position in ('GK','DEF','MID','ATT')), active boolean not null default true,
  died_on date, source text, updated_at timestamptz not null default now());
-- @@
create table if not exists ref.external_ids (
  entity text not null check (entity in ('club','player','competition')), entity_id bigint not null,
  provider text not null, external_id text not null,
  primary key (entity, entity_id, provider), unique (entity, provider, external_id));
-- @@
create table if not exists ref.club_seasons (
  competition_season_id bigint not null references ref.competition_seasons(id),
  club_id bigint not null references ref.clubs(id), primary key (competition_season_id, club_id));
-- @@
create table if not exists ref.squad_entries (
  id bigserial primary key, club_id bigint not null references ref.clubs(id), season int not null,
  player_id bigint not null references ref.players(id), shirt_number int,
  position text check (position in ('GK','DEF','MID','ATT')), on_loan boolean not null default false,
  joined_on date, left_on date, source text, updated_at timestamptz not null default now(),
  unique (club_id, season, player_id));
-- @@
create table if not exists ref.player_season_stats (
  id bigserial primary key, player_id bigint not null references ref.players(id),
  club_id bigint not null references ref.clubs(id), competition_season_id bigint not null references ref.competition_seasons(id),
  appearances int, starts int, minutes int, subs_in int, subs_out int, goals int, assists int,
  yellow int, red int, pens_scored int, pens_missed int, clean_sheets int, goals_conceded int, saves int,
  rating numeric(4,2), extra jsonb, source text, updated_at timestamptz not null default now(),
  unique (player_id, club_id, competition_season_id));
-- @@
create table if not exists ref.load_log (
  id bigserial primary key, source text not null, action text not null, params jsonb,
  api_calls int not null default 0, rows_written int not null default 0, note text, at timestamptz not null default now());
-- @@
create index if not exists players_name_key_idx on ref.players(name_key);
-- @@
create index if not exists squad_entries_club_season_idx on ref.squad_entries(club_id, season);
-- @@
create index if not exists squad_entries_player_idx on ref.squad_entries(player_id);
-- @@
create index if not exists pss_player_idx on ref.player_season_stats(player_id);
-- @@
create index if not exists pss_compseason_idx on ref.player_season_stats(competition_season_id);
-- @@
create index if not exists club_seasons_club_idx on ref.club_seasons(club_id);
-- @@
alter table ref.nations enable row level security;
alter table ref.competitions enable row level security;
alter table ref.competition_seasons enable row level security;
alter table ref.clubs enable row level security;
alter table ref.players enable row level security;
alter table ref.external_ids enable row level security;
alter table ref.club_seasons enable row level security;
alter table ref.squad_entries enable row level security;
alter table ref.player_season_stats enable row level security;
alter table ref.load_log enable row level security;
