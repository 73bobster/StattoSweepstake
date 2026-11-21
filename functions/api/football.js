// Cloudflare Pages Function: POST /api/football
// The ONLY place the API-Football key lives. Browsers call this, never api-sports directly.
// Results are cached in Neon so all friends share the same few API calls (free plan = 100 calls/day).
// Squads are NOT fetched per game: they live in our own `squads` table (see seedSquads). The API is used only for
// fixtures (what's on), line-ups and live match events (polled at most every 5 minutes for everyone together).
//
// Secrets (Cloudflare Pages > Settings > Variables and Secrets): DATABASE_URL, API_FOOTBALL_KEY, FOOTBALL_DATABASE_URL (shared football-data DB)
// Plain variable (wrangler.toml): NEON_JWKS_URL
import { verifyJwt } from '../_lib/jwt.js';
import { makeSql } from '../_lib/neon.js';
import * as fd from '../_lib/footballdata.js';

const API = 'https://v3.football.api-sports.io';
const DAILY_BUDGET = 95; // stop before the 100/day free limit
const SEED_BUDGET = 70; // squad seeding never uses the last ~25 calls of the day - those are for fixtures and live matches
// Leagues whose squads we keep in our own database: Premier League, Championship, Scottish Premiership, Scottish Championship
// API-Football sometimes returns HTML-escaped text (O&apos;Donnell); store and show it as plain text.
const ENT = { '&apos;': "'", '&#39;': "'", '&#x27;': "'", '&quot;': '"', '&amp;': '&' };
const unescapeDeep = (v) => typeof v === 'string' ? v.replace(/&(apos|#39|#x27|quot|amp);/g, (m) => ENT[m]) : Array.isArray(v) ? v.map(unescapeDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unescapeDeep(x)])) : v;

const LEAGUES = { 39: { name: 'Premier League', teams: 20 }, 40: { name: 'Championship', teams: 24 }, 179: { name: 'Scottish Premiership', teams: 12 }, 180: { name: 'Scottish Championship', teams: 10 } };
const SQUAD_MAX_AGE_DAYS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const ROLE = { Goalkeeper: 'GK', Defender: 'DEF', Midfielder: 'MID', Attacker: 'ATT', G: 'GK', D: 'DEF', M: 'MID', F: 'ATT' };
const finished = (s) => ['FT', 'AET', 'PEN'].includes(s);

const normFixtureRow = (f) => ({
  id: f.fixture.id,
  kickoff: f.fixture.date,
  status: { short: f.fixture.status.short, long: f.fixture.status.long, elapsed: f.fixture.status.elapsed },
  league: { id: f.league.id, name: f.league.name, country: f.league.country, logo: f.league.logo, round: f.league.round },
  teams: {
    home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
    away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
  },
  goals: f.goals,
});

function normLineups(lineups, homeId) {
  if (!lineups?.length) return null;
  const out = {};
  for (const l of lineups) {
    const side = l.team.id === homeId ? 'home' : 'away';
    out[side] = {
      formation: l.formation,
      coach: l.coach?.name,
      startXI: l.startXI.map((p) => p.player.id),
      subs: l.substitutes.map((p) => p.player.id),
      players: [
        ...l.startXI.map((p) => ({ ...p.player, bench: false })),
        ...l.substitutes.map((p) => ({ ...p.player, bench: true })),
      ].map((p) => ({ id: p.id, name: p.name, number: p.number, role: ROLE[p.pos] || 'MID', bench: p.bench })),
    };
  }
  return out.home && out.away ? out : null;
}

function normState(f) {
  return {
    ...normFixtureRow(f),
    events: (f.events || []).map((e) => ({
      x: e.time.elapsed, e: e.time.extra, team: e.team.id, pid: e.player?.id ?? null, pname: e.player?.name ?? null,
      aid: e.assist?.id ?? null, aname: e.assist?.name ?? null, type: e.type, detail: e.detail,
    })),
    lineups: normLineups(f.lineups, f.teams.home.id),
  };
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DATABASE_URL || !env.API_FOOTBALL_KEY || !env.NEON_JWKS_URL) return json({ error: 'Server is not configured yet (missing secrets)' }, 503);
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    try { await verifyJwt(token, env.NEON_JWKS_URL); } catch { return json({ error: 'Please sign in again' }, 401); }

    const sql = makeSql(env.DATABASE_URL);
    const body = await request.json().catch(() => ({}));

    const dailyLimit = Number(env.API_DAILY_LIMIT) || DAILY_BUDGET; // 7500 on API-Football Pro (wrangler.toml var); 95 on the free plan
    async function call(path, raw = false) {
      const [{ calls }] = await sql('insert into api_usage(day, calls) values ((now() at time zone \'utc\')::date, 1) on conflict (day) do update set calls = api_usage.calls + 1 returning calls::text as calls');
      if (Number(calls) > (dailyLimit > 1000 ? dailyLimit - 50 : DAILY_BUDGET)) throw new Error('Daily API-Football budget reached - try again tomorrow');
      const r = await fetch(API + path, { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } });
      const j = await r.json();
      const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
      if (errs && errs.length) { const m = String(errs[0]); throw new Error(/too many requests|per minute|rate ?limit/i.test(m) ? 'API-Football per-minute limit reached - wait a minute and try again.' : m); }
      const response = unescapeDeep(j.response);
      return raw ? { response, paging: j.paging } : response;
    }

    async function cached(key, ttlSec, load, force = false) {
      const rows = await sql('select payload::text as payload, fetched_at::text as fetched_at, extract(epoch from (now() - fetched_at))::text as age from api_cache where key = $1', [key]);
      const row = rows[0];
      if (row && !force && Number(row.age) < ttlSec) return { data: JSON.parse(row.payload), fresh: false, fetchedAt: row.fetched_at };
      try {
        const data = await load();
        await sql('insert into api_cache(key, payload, fetched_at) values ($1, $2::jsonb, now()) on conflict (key) do update set payload = excluded.payload, fetched_at = now()', [key, JSON.stringify(data)]);
        return { data, fresh: true, fetchedAt: new Date().toISOString() };
      } catch (e) {
        if (row) return { data: JSON.parse(row.payload), fresh: false, fetchedAt: row.fetched_at }; // serve stale on failure/budget
        throw e;
      }
    }

    const normSquad = (resp) => (resp?.[0]?.players || []).map((p) => ({ id: p.id, name: p.name, number: p.number ?? null, photo: p.photo || `https://media.api-sports.io/football/players/${p.id}.png`, role: ROLE[p.position] || 'MID' }));

    /** A team's squad from our own database; only if we've never stored it do we ask the API (and then keep it). */
    async function squadFor(teamId) {
      const row = (await sql('select players::text as players from squads where team_id = $1 and players is not null', [teamId]))[0];
      if (row) return JSON.parse(row.players);
      const players = normSquad(await call(`/players/squads?team=${teamId}`));
      await sql('insert into squads(team_id, players, fetched_at) values ($1, $2::jsonb, now()) on conflict (team_id) do update set players = excluded.players, fetched_at = now()', [teamId, JSON.stringify(players)]);
      return players;
    }

    async function squadStatus() {
      const rows = await sql('select league_id::text as league_id, count(*)::text as teams, count(players)::text as loaded, count(*) filter (where players is not null and fetched_at < now() - ($1 || \' days\')::interval)::text as stale from squads where league_id is not null group by league_id', [String(SQUAD_MAX_AGE_DAYS)]);
      const by = Object.fromEntries(rows.map((r) => [r.league_id, r]));
      const leagues = Object.entries(LEAGUES).map(([id, l]) => ({ id: Number(id), name: l.name, expected: l.teams, found: Number(by[id]?.teams || 0), loaded: Number(by[id]?.loaded || 0), stale: Number(by[id]?.stale || 0) }));
      const used = Number((await sql('select coalesce(max(calls), 0)::text as calls from api_usage where day = (now() at time zone \'utc\')::date'))[0]?.calls || 0);
      const complete = leagues.every((l) => l.loaded >= l.expected && l.stale === 0);
      return { leagues, complete, callsToday: used, budget: SEED_BUDGET };
    }

    /**
     * Fill our squads table in small, rate-limited batches (free plan = 10 calls/minute, 100/day).
     *  1. find the teams: every club that plays in these four leagues in the next two weeks (fixtures-by-date, shared cache)
     *  2. fetch each team's squad once, then keep it for 30 days
     * Safe to call repeatedly: it only does work that's missing, and stops at SEED_BUDGET calls for the day.
     */
    async function seedSquads() {
      const lock = await sql(`insert into api_cache(key, payload, fetched_at) values ('seed:lock', '{}'::jsonb, now()) on conflict (key) do update set fetched_at = now() where api_cache.fetched_at < now() - interval '50 seconds' returning key`);
      if (!lock.length) return { ...(await squadStatus()), busy: true };
      const pace = env.SEED_PACE_MS === undefined ? 6500 : Number(env.SEED_PACE_MS);
      const MAX_CALLS = 6; let made = 0; let paused = '';
      const usage = async () => Number((await sql('select coalesce(max(calls), 0)::text as calls from api_usage where day = (now() at time zone \'utc\')::date'))[0]?.calls || 0);
      const canCall = async () => { if (made >= MAX_CALLS) return false; if ((await usage()) >= SEED_BUDGET) { paused = 'budget'; return false; } return true; };
      const paced = async () => { if (made > 0 && pace) await sleep(pace); made++; };
      try {
        // 1. discover teams from upcoming fixtures
        const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() + i * 86400e3).toISOString().slice(0, 10));
        for (const date of days) {
          let rows = (await sql('select payload::text as payload from api_cache where key = $1', [`fixtures:${date}`]))[0];
          let list = rows ? JSON.parse(rows.payload) : null;
          if (!list) {
            if (!(await canCall())) break;
            await paced();
            const r = await cached(`fixtures:${date}`, 3 * 3600, async () => (await call(`/fixtures?date=${date}&timezone=Europe/London`)).map(normFixtureRow));
            list = r.data;
          }
          for (const f of list) {
            if (!LEAGUES[f.league.id]) continue;
            for (const t of [f.teams.home, f.teams.away]) await sql('insert into squads(team_id, name, logo, league_id, league_name) values ($1, $2, $3, $4, $5) on conflict (team_id) do update set name = excluded.name, logo = excluded.logo, league_id = excluded.league_id, league_name = excluded.league_name', [t.id, t.name, t.logo, f.league.id, LEAGUES[f.league.id].name]);
          }
        }
        // 2. squads for teams we know about but haven't loaded (or that have gone stale)
        const todo = await sql('select team_id::text as team_id from squads where league_id is not null and (players is null or fetched_at < now() - ($1 || \' days\')::interval) order by (players is null) desc, league_id, team_id', [String(SQUAD_MAX_AGE_DAYS)]);
        for (const t of todo) {
          if (!(await canCall())) break;
          await paced();
          const players = normSquad(await call(`/players/squads?team=${t.team_id}`));
          await sql('update squads set players = $2::jsonb, fetched_at = now() where team_id = $1', [t.team_id, JSON.stringify(players)]);
        }
      } catch (e) {
        paused = e.message || 'error';
      } finally {
        await sql(`update api_cache set fetched_at = now() - interval '1 hour' where key = 'seed:lock'`);
      }
      return { ...(await squadStatus()), busy: false, paused, calls: made };
    }

    const { action } = body;

    if (action === 'fixtures') {
      const date = String(body.date || '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
      if (!date) return json({ error: 'Bad date' }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const r = await cached(`fixtures:${date}`, date === today ? 30 * 60 : 3 * 3600, async () => (await call(`/fixtures?date=${date}&timezone=Europe/London`)).map(normFixtureRow));
      return json({ fixtures: r.data, fetchedAt: r.fetchedAt });
    }

    if (action === 'search') { // find a team or league by name for favourites (cached a month: names rarely change)
      const kind = body.kind === 'league' ? 'league' : 'team';
      const q = String(body.q || '').replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (q.length < 3) return json({ results: [] });
      const r = await cached(`search:${kind}:${q.toLowerCase()}`, 30 * 86400, async () => {
        const resp = (await call(`/${kind === 'league' ? 'leagues' : 'teams'}?search=${encodeURIComponent(q)}`)) || [];
        return resp.map((x) => kind === 'league' ? { id: x.league.id, name: x.league.name, logo: x.league.logo, country: x.country?.name || '' } : { id: x.team.id, name: x.team.name, logo: x.team.logo, country: x.team.country || '' }).slice(0, 15);
      });
      return json({ results: r.data });
    }
    if (action === 'pool') {
      // Player pool for the draw: confirmed lineups if announced, otherwise the two squads.
      const id = Number(body.fixtureId), home = Number(body.homeId), away = Number(body.awayId);
      if (!id || !home || !away) return json({ error: 'Missing ids' }, 400);
      // body.squadOnly: deal from the full squads even if line-ups are out (saves an API call too)
      const lu = body.squadOnly ? { data: null, fetchedAt: null } : await cached(`lineups:${id}`, 10 * 60, () => call(`/fixtures/lineups?fixture=${id}`), !!body.force);
      const lineups = body.squadOnly ? null : normLineups(lu.data, home);
      let players, source;
      if (lineups) {
        source = 'lineups';
        players = ['home', 'away'].flatMap((side) => lineups[side].players.map((p) => ({ ...p, side, teamId: side === 'home' ? home : away })));
      } else {
        source = 'squads';
        players = [];
        for (const [side, teamId] of [['home', home], ['away', away]]) {
          (await squadFor(teamId)).forEach((p) => players.push({ ...p, bench: null, side, teamId }));
        }
      }
      // Leave out players the API lists as missing this fixture through injury/suspension ("Missing Fixture"; "Questionable" players stay in).
      // Line-ups already exclude them. Best effort: if the injuries look-up fails (budget, coverage) we simply don't filter.
      let excluded = [], injuriesError = null;
      if (source === 'squads') {
        try {
          const inj = await cached(`injuries:${id}`, 3 * 3600, () => call(`/injuries?fixture=${id}`)); // shared for 3 hours, never forced
          const out = new Map((inj.data || []).filter((i) => i.player?.type === 'Missing Fixture').map((i) => [i.player.id, i.player.reason || 'Injured']));
          excluded = players.filter((p) => out.has(p.id)).map((p) => ({ id: p.id, name: p.name, reason: out.get(p.id) }));
          players = players.filter((p) => !out.has(p.id));
        } catch (e) { injuriesError = String(e.message || e).slice(0, 120); /* keep everyone */ }
      }
      players.forEach((p) => { p.photo = p.photo || `https://media.api-sports.io/football/players/${p.id}.png`; });
      return json({ source, players, excluded, injuriesError, fetchedAt: lu.fetchedAt });
    }

    if (action === 'state') {
      const id = Number(body.fixtureId);
      if (!id) return json({ error: 'Missing fixtureId' }, 400);
      const ex = (await sql('select state::text as state, extract(epoch from (now() - updated_at))::text as age from fixture_state where fixture_id = $1', [id]))[0];
      const prev = ex ? JSON.parse(ex.state) : null;
      const st = prev?.status?.short;
      const kickoff = prev?.kickoff ? new Date(prev.kickoff).getTime() : null;
      let ttl = 300; // live: one API call per 5 minutes shared by everyone (~20 calls for a whole match)
      if (st && finished(st)) ttl = 7 * 24 * 3600;
      else if (st === 'NS' && kickoff && kickoff - Date.now() > 2 * 3600e3) ttl = 30 * 60;
      else if (st === 'NS' && kickoff && kickoff - Date.now() > 0) ttl = 5 * 60;
      const force = !!body.force && !(st && finished(st)) && (!ex || Number(ex.age) > 45);
      const r = await cached(`state:${id}`, ttl, async () => {
        const resp = await call(`/fixtures?id=${id}`);
        if (!resp?.length) throw new Error('Fixture not found');
        return normState(resp[0]);
      }, force);
      if (r.fresh) await sql('insert into fixture_state(fixture_id, state, updated_at) values ($1, $2::jsonb, now()) on conflict (fixture_id) do update set state = excluded.state, updated_at = now()', [id, JSON.stringify(r.data)]);
      return json({ state: r.data, fetchedAt: r.fetchedAt });
    }

    if (action === 'ffPlan' || action === 'ffStep') { // football-data loader (see functions/_lib/footballdata.js); switch off with LOADER_ENABLED once loaded
      if (env.LOADER_ENABLED !== 'true') return json({ error: 'Football data loader is switched off' }, 403);
      if (!env.FOOTBALL_DATABASE_URL) return json({ error: 'FOOTBALL_DATABASE_URL secret is not set yet' }, 503);
      const ctx = { fsql: makeSql(env.FOOTBALL_DATABASE_URL), api: (p) => call(p), apiRaw: (p) => call(p, true), limit: dailyLimit,
        usage: async () => Number((await sql('select coalesce(max(calls), 0)::text as calls from api_usage where day = (now() at time zone \'utc\')::date'))[0]?.calls || 0) };
      if (action === 'ffPlan') return json(await fd.plan(ctx));
      const league = Number(body.league), season = body.season === undefined ? undefined : Number(body.season);
      if (body.step === 'league') return json(await fd.stepLeague(ctx, league));
      if (body.step === 'teams') return json(await fd.stepTeams(ctx, league, season));
      if (body.step === 'players') return json(await fd.stepPlayers(ctx, league, season, Math.max(1, Number(body.page) || 1)));
      if (body.step === 'numbers') return json(await fd.stepNumbers(ctx, String(body.team)));
      return json({ error: 'Unknown step' }, 400);
    }
    if (action === 'apiStatus') { // plan and quota of the key in use (never returns the key); /status is not metered by API-Football
      const r = await fetch(API + '/status', { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } });
      const j = await r.json();
      const x = j.response || {};
      return json({ plan: x.subscription?.plan ?? null, active: x.subscription?.active ?? null, end: x.subscription?.end ?? null, used: x.requests?.current ?? null, limitDay: x.requests?.limit_day ?? null, errors: j.errors || null, keyTail: String(env.API_FOOTBALL_KEY).slice(-4) });
    }
    if (action === 'squadStatus') return json(await squadStatus());
    if (action === 'seedSquads') return json(await seedSquads());

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: e.message || 'Server error' }, 500);
  }
}

export const onRequest = () => json({ error: 'POST only' }, 405);
