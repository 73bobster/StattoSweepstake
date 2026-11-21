# Football data database (shared across our sports apps)

Neon project **football-data** (`winter-wave-38503340`, eu-west-2, database `neondb`, schema `ref`).
Created 2026-11-21. Schema source: `db/migrations/004_reference_data.sql` (the same DDL is also commented in the database itself: `\d+ ref.*` or `select obj_description(...)`).

## Who uses it
| App | Uses |
|---|---|
| Statto Sweepstake | squads + players for dealing; live feed stays in its own app tables/API cache |
| Quiz | players, clubs, season stats, birth/death dates, nationalities |
| MatchStatto (non-pro) | competitions/clubs/players at `level` = semi or grassroots, entered by users, not provider-loaded |
| Football Draft (1960s+) | players, squad_entries and player_season_stats back to the 1960s, from permitted sources |

## Rules
1. **Our ids everywhere.** Provider ids live only in `ref.external_ids` (entity, provider, external_id). Never store a provider id on a main table.
2. **Season = start year** (2025 means 2025/26).
3. **Apps are read-only.** Only the loader writes. RLS is on with no client policies; apps read through a server function using the owner connection (as the Sweepstake does).
4. **Nulls are honest.** Older eras lack many stats; leave null, never 0. Put source-specific extras in `player_season_stats.extra`.
5. **Match players across sources with `players.name_key`** (lowercase, accents stripped, punctuation removed) plus birth_date where known.
6. **Positions are coarse**: GK, DEF, MID, ATT.
7. **Every load is logged** in `ref.load_log` (api_calls, rows_written) to track API budget.
8. **Level**: `pro`, `semi`, `grassroots` on competitions and clubs.

## Tables
- `nations(code, name)`
- `competitions(id, name, nation_code, kind league|cup|international, tier, level, active)`
- `competition_seasons(id, competition_id, season, starts_on, ends_on, is_current)` unique (competition_id, season)
- `clubs(id, name, short_name, code, nation_code, founded, venue_*, logo_url, level, is_national_team)`
- `players(id, full_name, first_name, last_name, known_as, name_key, birth_date, birth_place, birth_nation, nationality, height_cm, weight_kg, photo_url, position, active, died_on, source)`
- `external_ids(entity club|player|competition, entity_id, provider, external_id)`
- `club_seasons(competition_season_id, club_id)`
- `squad_entries(club_id, season, player_id, shirt_number, position, on_loan, joined_on, left_on, source)` unique (club_id, season, player_id)
- `player_season_stats(player_id, club_id, competition_season_id, appearances, starts, minutes, subs_in, subs_out, goals, assists, yellow, red, pens_scored, pens_missed, clean_sheets, goals_conceded, saves, rating, extra, source)` unique (player_id, club_id, competition_season_id)
- `load_log(source, action, params, api_calls, rows_written, note, at)`

## Common queries
- Current squad: `select p.full_name, s.shirt_number, s.position from ref.squad_entries s join ref.players p on p.id=s.player_id where s.club_id=$1 and s.season=(select max(season) from ref.squad_entries where club_id=$1)`
- Top scorers in a season: join `player_season_stats` to `competition_seasons`, order by goals desc.
- Career: all `player_season_stats` for a player ordered by season.

## Not here
Fixtures and live match events (real-time tier, cached per app), user/game data, secrets.

## Load order and sources
1. nations, competitions, competition_seasons, clubs (API-Football Pro, from 2026-11)
2. squads and players (squad_entries, external_ids)
3. player_season_stats
Historical (pre-API) data for Football Draft: separate loader, licensing to be confirmed per source before loading.
