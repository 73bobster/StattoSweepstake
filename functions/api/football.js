// Cloudflare Pages Function: POST /api/football
// The ONLY place the API-Football key lives. Browsers call this, never api-sports directly.
// Results are cached in Neon so all friends share the same few API calls (free plan = 100 calls/day).
//
// Secrets (Cloudflare Pages > Settings > Variables and Secrets): DATABASE_URL, API_FOOTBALL_KEY
// Plain variable (wrangler.toml): NEON_JWKS_URL
import { verifyJwt } from '../_lib/jwt.js';
import { makeSql } from '../_lib/neon.js';

const API = 'https://v3.football.api-sports.io';
const DAILY_BUDGET = 95; // stop before the 100/day free limit

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

    async function call(path) {
      const [{ calls }] = await sql('insert into api_usage(day, calls) values ((now() at time zone \'utc\')::date, 1) on conflict (day) do update set calls = api_usage.calls + 1 returning calls::text as calls');
      if (Number(calls) > DAILY_BUDGET) throw new Error('Daily API-Football budget reached - try again tomorrow');
      const r = await fetch(API + path, { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } });
      const j = await r.json();
      const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
      if (errs && errs.length) throw new Error(String(errs[0]));
      return j.response;
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

    const { action } = body;

    if (action === 'fixtures') {
      const date = String(body.date || '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
      if (!date) return json({ error: 'Bad date' }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const r = await cached(`fixtures:${date}`, date === today ? 30 * 60 : 3 * 3600, async () => (await call(`/fixtures?date=${date}&timezone=Europe/London`)).map(normFixtureRow));
      return json({ fixtures: r.data, fetchedAt: r.fetchedAt });
    }

    if (action === 'pool') {
      // Player pool for the draw: confirmed lineups if announced, otherwise the two squads.
      const id = Number(body.fixtureId), home = Number(body.homeId), away = Number(body.awayId);
      if (!id || !home || !away) return json({ error: 'Missing ids' }, 400);
      const lu = await cached(`lineups:${id}`, 10 * 60, () => call(`/fixtures/lineups?fixture=${id}`), !!body.force);
      const lineups = normLineups(lu.data, home);
      let players, source;
      if (lineups) {
        source = 'lineups';
        players = ['home', 'away'].flatMap((side) => lineups[side].players.map((p) => ({ ...p, side, teamId: side === 'home' ? home : away })));
      } else {
        source = 'squads';
        players = [];
        for (const [side, teamId] of [['home', home], ['away', away]]) {
          const sq = await cached(`squad:${teamId}`, 24 * 3600, () => call(`/players/squads?team=${teamId}`));
          (sq.data[0]?.players || []).forEach((p) => players.push({ id: p.id, name: p.name, number: p.number, photo: p.photo, role: ROLE[p.position] || 'MID', bench: null, side, teamId }));
        }
      }
      players.forEach((p) => { p.photo = p.photo || `https://media.api-sports.io/football/players/${p.id}.png`; });
      return json({ source, players, fetchedAt: lu.fetchedAt });
    }

    if (action === 'state') {
      const id = Number(body.fixtureId);
      if (!id) return json({ error: 'Missing fixtureId' }, 400);
      const ex = (await sql('select state::text as state, extract(epoch from (now() - updated_at))::text as age from fixture_state where fixture_id = $1', [id]))[0];
      const prev = ex ? JSON.parse(ex.state) : null;
      const st = prev?.status?.short;
      const kickoff = prev?.kickoff ? new Date(prev.kickoff).getTime() : null;
      let ttl = 120; // live: one API call per 2 minutes shared by everyone (~55 calls for a whole match)
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

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: e.message || 'Server error' }, 500);
  }
}

export const onRequest = () => json({ error: 'POST only' }, 405);
