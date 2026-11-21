// Loader for the shared football-data database (Neon project football-data, schema ref; see db/football-data/README.md).
// Runs inside the Pages Function. One small step per request so it fits Cloudflare limits; the browser loops through the steps.
// Idempotent: every write is an upsert keyed on (provider, external id), so re-running a step never duplicates anything.
// API-Football calls per league-season: 1 (teams) + ~1 per 20 players. Stats come from /players?league&season&page.

export const LOADER_LEAGUES = { 39: { tier: 1 }, 40: { tier: 2 }, 179: { tier: 1 }, 180: { tier: 2 } }; // PL, Championship, Scottish Prem, Scottish Champ
export const FIRST_SEASON = 2015;
export const LAST_SEASON = 2026; // 2026 = 2026/27 (API-Football names a season by its start year)
export const LOAD_RESERVE = 1500; // the loader never uses the last 1,500 calls of the daily limit; those stay for live matches
const PROVIDER = 'api-football';
const ROLE = { Goalkeeper: 'GK', Defender: 'DEF', Midfielder: 'MID', Attacker: 'ATT', G: 'GK', D: 'DEF', M: 'MID', F: 'ATT' };

export const nameKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const num = (v) => { const m = String(v ?? '').match(/\d+/); return m ? Number(m[0]) : null; };
const int = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.trunc(Number(v)));
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);

/** One API /players item -> { player, stats[] } for our tables. Pure, so it is unit tested. */
export function mapPlayerItem(it, league) {
  const p = it.player || {};
  const full = [p.firstname, p.lastname].filter(Boolean).join(' ').trim() || p.name || '';
  const stats = (it.statistics || []).filter((s) => s.league?.id === league && s.team?.id).map((s) => ({
    team: String(s.team.id), appearances: int(s.games?.appearences), starts: int(s.games?.lineups), minutes: int(s.games?.minutes),
    subs_in: int(s.substitutes?.in), subs_out: int(s.substitutes?.out), goals: int(s.goals?.total), assists: int(s.goals?.assists),
    yellow: int(s.cards?.yellow), red: int(s.cards?.red), pens_scored: int(s.penalty?.scored), pens_missed: int(s.penalty?.missed),
    goals_conceded: int(s.goals?.conceded), saves: int(s.goals?.saves), rating: s.games?.rating ? Math.round(Number(s.games.rating) * 100) / 100 : null,
    extra: { yellowred: int(s.cards?.yellowred), bench: int(s.substitutes?.bench), pens_saved: int(s.penalty?.saved) },
    position: ROLE[s.games?.position] || null,
  }));
  return {
    player: {
      pid: String(p.id), full_name: full, first_name: p.firstname || null, last_name: p.lastname || null, known_as: p.name || null, name_key: nameKey(full),
      birth_date: date(p.birth?.date), birth_place: p.birth?.place || null, birth_nation: p.birth?.country || null, nationality: p.nationality || null,
      height_cm: num(p.height), weight_kg: num(p.weight), photo_url: p.photo || null, position: stats.find((s) => s.position)?.position || null,
    },
    stats,
  };
}

const PLAYER_UPSERT = `
with inp as (select * from jsonb_to_recordset($1::jsonb) as x(pid text, full_name text, first_name text, last_name text, known_as text, name_key text, birth_date text, birth_place text, birth_nation text, nationality text, height_cm int, weight_kg int, photo_url text, position text)),
prep as materialized (select inp.*, coalesce(e.entity_id, nextval('ref.players_id_seq')) as oid, e.entity_id is not null as existed from inp left join ref.external_ids e on e.entity = 'player' and e.provider = '${PROVIDER}' and e.external_id = inp.pid),
ins as (insert into ref.players(id, full_name, first_name, last_name, known_as, name_key, birth_date, birth_place, birth_nation, nationality, height_cm, weight_kg, photo_url, position, source)
  select oid, full_name, first_name, last_name, known_as, name_key, birth_date::date, birth_place, birth_nation, nationality, height_cm, weight_kg, photo_url, position, '${PROVIDER}' from prep where not existed returning 1),
ext as (insert into ref.external_ids(entity, entity_id, provider, external_id) select 'player', oid, '${PROVIDER}', pid from prep where not existed returning 1),
upd as (update ref.players p set photo_url = coalesce(prep.photo_url, p.photo_url), height_cm = coalesce(prep.height_cm, p.height_cm), weight_kg = coalesce(prep.weight_kg, p.weight_kg),
  birth_date = coalesce(p.birth_date, prep.birth_date::date), nationality = coalesce(prep.nationality, p.nationality), position = coalesce(prep.position, p.position), updated_at = now()
  from prep where prep.existed and p.id = prep.oid returning 1)
select pid, oid::text as oid from prep`;

const STATS_UPSERT = `
with inp as (select * from jsonb_to_recordset($1::jsonb) as x(oid bigint, team text, appearances int, starts int, minutes int, subs_in int, subs_out int, goals int, assists int, yellow int, red int, pens_scored int, pens_missed int, goals_conceded int, saves int, rating numeric, extra jsonb, position text)),
j as materialized (select inp.*, c.entity_id as club_id from inp join ref.external_ids c on c.entity = 'club' and c.provider = '${PROVIDER}' and c.external_id = inp.team),
cs as materialized (select id from ref.competition_seasons where competition_id = (select entity_id from ref.external_ids where entity = 'competition' and provider = '${PROVIDER}' and external_id = $2) and season = $3::int),
st as (insert into ref.player_season_stats(player_id, club_id, competition_season_id, appearances, starts, minutes, subs_in, subs_out, goals, assists, yellow, red, pens_scored, pens_missed, goals_conceded, saves, rating, extra, source)
  select oid, club_id, (select id from cs), appearances, starts, minutes, subs_in, subs_out, goals, assists, yellow, red, pens_scored, pens_missed, goals_conceded, saves, rating, extra, '${PROVIDER}' from j
  on conflict (player_id, club_id, competition_season_id) do update set appearances = excluded.appearances, starts = excluded.starts, minutes = excluded.minutes, subs_in = excluded.subs_in, subs_out = excluded.subs_out,
    goals = excluded.goals, assists = excluded.assists, yellow = excluded.yellow, red = excluded.red, pens_scored = excluded.pens_scored, pens_missed = excluded.pens_missed,
    goals_conceded = excluded.goals_conceded, saves = excluded.saves, rating = excluded.rating, extra = excluded.extra, updated_at = now() returning 1),
sq as (insert into ref.squad_entries(club_id, season, player_id, position, source) select club_id, $3::int, oid, position, '${PROVIDER}' from j
  on conflict (club_id, season, player_id) do update set position = coalesce(excluded.position, ref.squad_entries.position), updated_at = now() returning 1)
select (select count(*) from j)::text as kept, (select count(*) from inp)::text as total`;

const CLUB_UPSERT = `
with inp as (select * from jsonb_to_recordset($1::jsonb) as x(tid text, name text, code text, country text, founded int, national boolean, logo text, venue text, city text, cap int)),
prep as materialized (select inp.*, coalesce(e.entity_id, nextval('ref.clubs_id_seq')) as oid, e.entity_id is not null as existed from inp left join ref.external_ids e on e.entity = 'club' and e.provider = '${PROVIDER}' and e.external_id = inp.tid),
ins as (insert into ref.clubs(id, name, short_name, code, nation_code, founded, venue_name, venue_city, venue_capacity, logo_url, level, is_national_team)
  select oid, name, name, code, (select n.code from ref.nations n where n.name = prep.country limit 1), founded, venue, city, cap, logo, 'pro', coalesce(national, false) from prep where not existed returning 1),
ext as (insert into ref.external_ids(entity, entity_id, provider, external_id) select 'club', oid, '${PROVIDER}', tid from prep where not existed returning 1),
upd as (update ref.clubs c set name = prep.name, code = coalesce(prep.code, c.code), founded = coalesce(prep.founded, c.founded), venue_name = coalesce(prep.venue, c.venue_name), venue_city = coalesce(prep.city, c.venue_city),
  venue_capacity = coalesce(prep.cap, c.venue_capacity), logo_url = coalesce(prep.logo, c.logo_url), updated_at = now() from prep where prep.existed and c.id = prep.oid returning 1),
cs as (insert into ref.club_seasons(competition_season_id, club_id)
  select (select id from ref.competition_seasons where competition_id = (select entity_id from ref.external_ids where entity = 'competition' and provider = '${PROVIDER}' and external_id = $2) and season = $3::int), oid from prep
  on conflict do nothing returning 1)
select count(*)::text as n from prep`;

const SEASONS_UPSERT = `
insert into ref.competition_seasons(competition_id, season, starts_on, ends_on, is_current)
select $1::bigint, x.year, x.start_d::date, x.end_d::date, x.is_current from jsonb_to_recordset($2::jsonb) as x(year int, start_d text, end_d text, is_current boolean)
on conflict (competition_id, season) do update set starts_on = excluded.starts_on, ends_on = excluded.ends_on, is_current = excluded.is_current`;

const SQUAD_ENTRY_UPSERT = `
with inp as (select * from jsonb_to_recordset($1::jsonb) as x(oid bigint, number int, position text)),
club as (select entity_id from ref.external_ids where entity = 'club' and provider = '${PROVIDER}' and external_id = $2)
insert into ref.squad_entries(club_id, season, player_id, shirt_number, position, source)
select (select entity_id from club), $3::int, oid, number, position, '${PROVIDER}' from inp where exists (select 1 from club)
on conflict (club_id, season, player_id) do update set shirt_number = excluded.shirt_number, position = coalesce(excluded.position, ref.squad_entries.position), updated_at = now()`;

export const SQL = { PLAYER_UPSERT, STATS_UPSERT, CLUB_UPSERT, SEASONS_UPSERT, SQUAD_ENTRY_UPSERT };

const log = (ctx, action, params, calls, rows) => ctx.fsql('insert into ref.load_log(source, action, params, api_calls, rows_written) values ($1, $2, $3::jsonb, $4::int, $5::int)', [PROVIDER, action, JSON.stringify(params), calls, rows]);

async function guard(ctx) {
  if ((await ctx.usage()) >= ctx.limit - LOAD_RESERVE) throw new Error('Loader paused: daily API budget reserve reached (it will carry on tomorrow)');
}

export function validate({ league, season }) {
  if (!LOADER_LEAGUES[league]) throw new Error('Unknown league');
  if (season !== undefined && !(season >= FIRST_SEASON && season <= LAST_SEASON)) throw new Error('Season out of range');
}

/** Competition + its seasons (1 API call). */
export async function stepLeague(ctx, league) {
  validate({ league });
  await guard(ctx);
  const L = (await ctx.api(`/leagues?id=${league}`))?.[0];
  if (!L) throw new Error(`League ${league} not found`);
  const code = L.country?.code || L.country?.name || 'XX';
  await ctx.fsql('insert into ref.nations(code, name) values ($1, $2) on conflict (code) do update set name = excluded.name', [code, L.country?.name || code]);
  let cid = (await ctx.fsql(`select entity_id::text as id from ref.external_ids where entity = 'competition' and provider = '${PROVIDER}' and external_id = $1`, [String(league)]))[0]?.id;
  if (!cid) {
    cid = (await ctx.fsql(`insert into ref.competitions(name, nation_code, kind, tier, level) values ($1, $2, 'league', $3::int, 'pro') returning id::text as id`, [L.league.name, code, LOADER_LEAGUES[league].tier]))[0].id;
    await ctx.fsql(`insert into ref.external_ids(entity, entity_id, provider, external_id) values ('competition', $1::bigint, '${PROVIDER}', $2)`, [cid, String(league)]);
  }
  const seasons = (L.seasons || []).filter((s) => s.year >= FIRST_SEASON && s.year <= LAST_SEASON).map((s) => ({ year: s.year, start_d: date(s.start), end_d: date(s.end), is_current: !!s.current }));
  if (seasons.length) await ctx.fsql(SEASONS_UPSERT, [cid, JSON.stringify(seasons)]);
  await log(ctx, 'league', { league }, 1, seasons.length);
  return { league, name: L.league.name, seasons: seasons.length };
}

/** The clubs in one league-season (1 API call). */
export async function stepTeams(ctx, league, season) {
  validate({ league, season });
  await guard(ctx);
  const resp = (await ctx.api(`/teams?league=${league}&season=${season}`)) || [];
  const items = resp.map((t) => ({ tid: String(t.team.id), name: t.team.name, code: t.team.code || null, country: t.team.country || null, founded: int(t.team.founded), national: !!t.team.national, logo: t.team.logo || null, venue: t.venue?.name || null, city: t.venue?.city || null, cap: int(t.venue?.capacity) }));
  if (items.length) await ctx.fsql(CLUB_UPSERT, [JSON.stringify(items), String(league), String(season)]);
  await log(ctx, 'teams', { league, season }, 1, items.length);
  return { league, season, clubs: items.length };
}

/** One page (20 players) of a league-season with their season stats (1 API call). Marks the league-season done on the last page. */
export async function stepPlayers(ctx, league, season, page = 1) {
  validate({ league, season });
  await guard(ctx);
  const { response, paging } = await ctx.apiRaw(`/players?league=${league}&season=${season}&page=${page}`);
  const total = paging?.total || 1;
  const mapped = (response || []).map((it) => mapPlayerItem(it, league));
  const byPid = new Map(); mapped.forEach((m) => { if (!byPid.has(m.player.pid)) byPid.set(m.player.pid, m); });
  const unique = [...byPid.values()];
  let kept = 0;
  if (unique.length) {
    const rows = await ctx.fsql(PLAYER_UPSERT, [JSON.stringify(unique.map((m) => m.player))]);
    const oid = Object.fromEntries(rows.map((r) => [r.pid, r.oid]));
    const seen = new Set(); const stats = [];
    for (const m of unique) for (const s of m.stats) { const k = `${oid[m.player.pid]}|${s.team}`; if (!seen.has(k)) { seen.add(k); stats.push({ oid: Number(oid[m.player.pid]), ...s }); } }
    if (stats.length) kept = Number((await ctx.fsql(STATS_UPSERT, [JSON.stringify(stats), String(league), String(season)]))[0]?.kept || 0);
  }
  const done = page >= total;
  await log(ctx, done ? 'league-season-done' : 'players', { league, season, page, total }, 1, kept);
  return { league, season, page, total, players: unique.length, rows: kept, done };
}

/** Shirt numbers for the current squad of one club (1 API call). Also adds squad members who have no stats yet. */
export async function stepNumbers(ctx, team) {
  if (!/^\d+$/.test(String(team))) throw new Error('Bad team');
  await guard(ctx);
  const squad = (await ctx.api(`/players/squads?team=${team}`))?.[0]?.players || [];
  const items = squad.map((p) => ({ pid: String(p.id), full_name: p.name, first_name: null, last_name: null, known_as: p.name, name_key: nameKey(p.name), birth_date: null, birth_place: null, birth_nation: null, nationality: null, height_cm: null, weight_kg: null, photo_url: p.photo || null, position: ROLE[p.position] || null }));
  if (items.length) {
    const rows = await ctx.fsql(PLAYER_UPSERT, [JSON.stringify(items)]);
    const oid = Object.fromEntries(rows.map((r) => [r.pid, r.oid]));
    const entries = squad.map((p) => ({ oid: Number(oid[String(p.id)]), number: int(p.number), position: ROLE[p.position] || null }));
    await ctx.fsql(SQUAD_ENTRY_UPSERT, [JSON.stringify(entries), String(team), String(LAST_SEASON)]);
  }
  await log(ctx, 'numbers-done', { team: String(team) }, 1, items.length);
  return { team, players: items.length };
}

/** What is still to do, so the browser can loop. Latest seasons first. */
export async function plan(ctx) {
  const setUp = new Set((await ctx.fsql(`select external_id from ref.external_ids where entity = 'competition' and provider = '${PROVIDER}'`)).map((r) => r.external_id));
  const done = new Set((await ctx.fsql(`select params->>'league' as l, params->>'season' as s from ref.load_log where action = 'league-season-done'`)).map((r) => `${r.l}|${r.s}`));
  const leagues = Object.keys(LOADER_LEAGUES).map(Number).filter((l) => !setUp.has(String(l)));
  const todo = [];
  for (let s = LAST_SEASON; s >= FIRST_SEASON; s--) for (const l of Object.keys(LOADER_LEAGUES).map(Number)) if (!done.has(`${l}|${s}`)) todo.push({ league: l, season: s });
  const numbers = (await ctx.fsql(`select distinct ce.external_id as team from ref.club_seasons cs join ref.competition_seasons s on s.id = cs.competition_season_id
    join ref.external_ids ce on ce.entity = 'club' and ce.entity_id = cs.club_id and ce.provider = '${PROVIDER}'
    where s.season = $1::int and not exists (select 1 from ref.load_log l where l.action = 'numbers-done' and l.params->>'team' = ce.external_id and l.at > now() - interval '7 days')`, [String(LAST_SEASON)])).map((r) => r.team);
  const counts = (await ctx.fsql('select (select count(*) from ref.players)::text as players, (select count(*) from ref.clubs)::text as clubs, (select count(*) from ref.player_season_stats)::text as stats'))[0];
  return { leagues, todo, numbers, counts, first: FIRST_SEASON, last: LAST_SEASON };
}
