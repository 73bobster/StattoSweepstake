import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/football.js';

// --- make an Ed25519 signed token + JWKS, like Neon Auth issues
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'EdDSA' };
const b64u = (b) => Buffer.from(b).toString('base64url');
async function token(claims) {
  const h = b64u(JSON.stringify({ alg: 'EdDSA', kid: 'k1' })), p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

const calls = [];
globalThis.fetch = async (url, init) => {
  url = String(url);
  const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
  if (url.includes('jwks')) return ok({ keys: [jwk] });
  if (url.endsWith('/sql')) {
    const { query } = JSON.parse(init.body);
    calls.push(query.slice(0, 40));
    if (query.includes('insert into api_usage')) return ok({ rows: [{ calls: '3' }] });
    return ok({ rows: [] });
  }
  if (url.startsWith('https://v3.football.api-sports.io')) {
    assert.equal(init.headers['x-apisports-key'], 'KEY');
    calls.push(url);
    if (url.includes('/fixtures?date')) return ok({ errors: [], response: [{ fixture: { id: 1, date: '2026-11-21T15:00:00+00:00', status: { short: 'NS', long: 'Not Started', elapsed: null } }, league: { id: 179, name: 'Premiership', country: 'Scotland', logo: 'l', round: 'R1' }, teams: { home: { id: 10, name: 'A', logo: 'a' }, away: { id: 11, name: 'B', logo: 'b' } }, goals: { home: null, away: null } }] });
    if (url.includes('/fixtures/lineups')) return ok({ errors: [], response: [] });
    if (url.includes('/players/squads')) return ok({ errors: [], response: [{ players: [{ id: 5, name: 'X', number: 9, position: 'Attacker', photo: 'p' }] }] });
    if (url.includes('/fixtures?id=')) return ok({ errors: [], response: [{ fixture: { id: 1, date: '2026-11-21T15:00:00+00:00', status: { short: '1H', long: 'First Half', elapsed: 12 } }, league: { id: 179, name: 'P', country: 'S', logo: '', round: '' }, teams: { home: { id: 10, name: 'A', logo: '' }, away: { id: 11, name: 'B', logo: '' } }, goals: { home: 1, away: 0 }, events: [{ time: { elapsed: 10, extra: null }, team: { id: 10 }, player: { id: 5, name: 'X' }, assist: { id: null, name: null }, type: 'Goal', detail: 'Normal Goal' }], lineups: [] }] });
  }
  throw new Error('unexpected fetch ' + url);
};

const env = { DATABASE_URL: 'postgresql://u:p@ep-x-pooler.c-2.eu-west-2.aws.neon.tech/neondb', API_FOOTBALL_KEY: 'KEY', NEON_JWKS_URL: 'https://x/jwks.json' };
const req = (body, tok) => new Request('https://x/api/football', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const good = await token({ sub: 'user1', exp: Math.floor(Date.now() / 1000) + 600 });

let r = await onRequestPost({ request: req({ action: 'fixtures', date: '2026-11-21' }, 'garbage'), env });
assert.equal(r.status, 401);
r = await onRequestPost({ request: req({ action: 'fixtures', date: '2026-11-21' }, await token({ sub: 'u', exp: 1 })), env });
assert.equal(r.status, 401, 'expired token rejected');
r = await onRequestPost({ request: req({ action: 'fixtures', date: '2026-11-21' }, good), env: { ...env, API_FOOTBALL_KEY: '' } });
assert.equal(r.status, 503);

r = await onRequestPost({ request: req({ action: 'fixtures', date: '2026-11-21' }, good), env });
let j = await r.json(); assert.equal(r.status, 200); assert.equal(j.fixtures[0].teams.home.name, 'A');
r = await onRequestPost({ request: req({ action: 'pool', fixtureId: 1, homeId: 10, awayId: 11 }, good), env });
j = await r.json(); assert.equal(j.source, 'squads'); assert.equal(j.players[0].role, 'ATT'); assert.equal(j.players.length, 2);
r = await onRequestPost({ request: req({ action: 'state', fixtureId: 1 }, good), env });
j = await r.json(); assert.equal(j.state.events[0].detail, 'Normal Goal'); assert.equal(j.state.status.short, '1H');
r = await onRequestPost({ request: req({ action: 'nope' }, good), env }); assert.equal(r.status, 400);
console.log('function tests passed;', calls.length, 'upstream/db calls');
