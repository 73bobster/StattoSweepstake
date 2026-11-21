import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/football.js';

const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'EdDSA' };
const b64u = (b) => Buffer.from(b).toString('base64url');
const h = b64u(JSON.stringify({ alg: 'EdDSA', kid: 'k1' })), pl = b64u(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 600 }));
const tok = `${h}.${pl}.${b64u(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(`${h}.${pl}`)))}`;

// ---- fake database
const db = { cache: new Map(), squads: new Map(), usage: 0, locked: false };
const apiCalls = [];
function runSql(q, params) {
  q = q.replace(/\s+/g, ' ');
  if (q.includes('insert into api_usage')) { db.usage++; return [{ calls: String(db.usage) }]; }
  if (q.includes("values ('seed:lock'")) { if (db.locked) return []; db.locked = true; return [{ key: 'seed:lock' }]; }
  if (q.includes("where key = 'seed:lock'")) { db.locked = false; return []; }
  if (q.includes('from api_usage')) return [{ calls: String(db.usage) }];
  if (q.startsWith('select payload::text as payload from api_cache')) return db.cache.has(params[0]) ? [{ payload: db.cache.get(params[0]) }] : [];
  if (q.includes('payload::text as payload, fetched_at')) return db.cache.has(params[0]) ? [{ payload: db.cache.get(params[0]), fetched_at: 'x', age: '1' }] : [];
  if (q.startsWith('insert into api_cache(key, payload, fetched_at) values ($1')) { db.cache.set(params[0], params[1]); return []; }
  if (q.startsWith('insert into squads(team_id, name, logo')) { const [id, name, logo, lid, ln] = params; db.squads.set(String(id), { ...(db.squads.get(String(id)) || {}), name, logo, league_id: lid, players: db.squads.get(String(id))?.players || null }); return []; }
  if (q.startsWith('insert into squads(team_id, players')) { db.squads.set(String(params[0]), { ...(db.squads.get(String(params[0])) || {}), players: params[1] }); return []; }
  if (q.startsWith('select team_id::text as team_id from squads')) return [...db.squads].filter(([, v]) => v.league_id && !v.players).map(([id]) => ({ team_id: id }));
  if (q.startsWith('update squads set players')) { db.squads.get(String(params[0])).players = params[1]; return []; }
  if (q.includes('from squads where team_id = $1 and players is not null')) { const v = db.squads.get(String(params[0])); return v?.players ? [{ players: v.players }] : []; }
  if (q.includes('group by league_id')) {
    const g = {}; for (const v of db.squads.values()) { if (!v.league_id) continue; g[v.league_id] ||= { league_id: String(v.league_id), teams: 0, loaded: 0, stale: '0' }; g[v.league_id].teams++; if (v.players) g[v.league_id].loaded++; }
    return Object.values(g).map((x) => ({ ...x, teams: String(x.teams), loaded: String(x.loaded) }));
  }
  throw new Error('unhandled sql: ' + q.slice(0, 80));
}
const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
const team = (id, name) => ({ id, name, logo: '' });
const fx = (id, lid, home, away) => ({ fixture: { id, date: '2026-11-21T15:00:00+00:00', status: { short: 'NS', long: 'x', elapsed: null } }, league: { id: lid, name: 'L', country: 'C', logo: '', round: '' }, teams: { home: team(...home), away: team(...away) }, goals: { home: null, away: null } });
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.includes('jwks')) return ok({ keys: [jwk] });
  if (url.endsWith('/sql')) { const { query, params } = JSON.parse(init.body); return ok({ rows: runSql(query, params) }); }
  if (url.startsWith('https://v3.football.api-sports.io')) {
    apiCalls.push(url);
    if (url.includes('/fixtures?date')) return ok({ errors: [], response: [fx(1, 39, [1, 'Arsenal'], [2, 'Chelsea']), fx(2, 179, [3, 'Celtic'], [4, 'Rangers']), fx(3, 2, [9, 'Champions League Team'], [8, 'Other'])] });
    if (url.includes('/players/squads')) return ok({ errors: [], response: [{ players: [{ id: 50, name: 'Pl', number: 7, position: 'Midfielder', photo: 'p' }] }] });
  }
  if (url.includes('api-sports')) return ok({ errors: [], response: [] });
  throw new Error('unexpected fetch ' + url);
};
const env = { DATABASE_URL: 'postgresql://u:p@ep-x.c-2.eu-west-2.aws.neon.tech/neondb', API_FOOTBALL_KEY: 'K', NEON_JWKS_URL: 'https://x/jwks.json', SEED_PACE_MS: '0' };
const post = async (body, e = env) => (await onRequestPost({ request: new Request('https://x/api/football', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) }), env: e })).json();

// batch 1: max 6 API calls (14 fixture dates are cached once fetched; teams are found in the same calls)
let r = await post({ action: 'seedSquads' });
assert.equal(r.busy, false);
assert.ok(r.calls <= 6 && apiCalls.length <= 6, 'batch limit ' + apiCalls.length);
// keep going until complete-ish: 14 date calls + 4 squads
for (let i = 0; i < 5; i++) r = await post({ action: 'seedSquads' });
assert.ok(db.squads.size >= 4, 'teams discovered');
assert.ok(![...db.squads.keys()].includes('9'), 'only the 4 leagues are kept');
assert.equal([...db.squads.values()].filter((v) => v.players).length, 4, 'all 4 squads loaded');
const prem = r.leagues.find((l) => l.id === 39); assert.equal(prem.found, 2); assert.equal(prem.loaded, 2); assert.equal(prem.expected, 20);
// nothing more to do -> no more API calls
const before = apiCalls.length; await post({ action: 'seedSquads' }); assert.equal(apiCalls.length, before, 'idempotent');
// pool now comes from the database with no API call
const before2 = apiCalls.length;
const pool = await post({ action: 'pool', fixtureId: 1, homeId: 1, awayId: 2, squadOnly: true });
assert.equal(pool.source, 'squads'); assert.equal(pool.players.length, 2); assert.equal(pool.players[0].role, 'MID'); assert.equal(pool.players[0].side, 'home');
assert.equal(apiCalls.length, before2, 'squad pool makes zero API calls');
// concurrent run is refused
db.locked = true; const busy = await post({ action: 'seedSquads' }); assert.equal(busy.busy, true); db.locked = false;
// budget guard
db.usage = 70; db.squads.set('99', { name: 'New', league_id: 39, players: null });
const n = apiCalls.length; r = await post({ action: 'seedSquads' }); assert.equal(apiCalls.length, n, 'no seeding past the budget'); assert.equal(r.paused, 'budget');
// unknown team (e.g. other league) still works: fetched once, then stored
const o = await post({ action: 'pool', fixtureId: 5, homeId: 777, awayId: 1, squadOnly: true }); assert.equal(o.players.length, 2);
assert.ok(db.squads.get('777').players, 'stored for next time');
console.log('seed tests passed;', apiCalls.length, 'api calls');
