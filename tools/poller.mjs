// Live-match poller. Runs on YOUR computer (home IP) while it is switched on.
// Every minute it looks for sweepstake matches that are about to start or in play, asks API-Football for all of
// them in ONE call, and saves the result in Neon - the same cache the website reads. The website's server only
// calls API-Football itself when this poller has gone quiet (heartbeat older than ~2.5 minutes), so stopping it is safe.
//
// Usage (PowerShell, VPN off):
//   $env:API_FOOTBALL_KEY = "<Pro key>"
//   $env:DATABASE_URL = "<stattosweepstake connection string>"
//   node tools/poller.mjs
// Or double-click tools/run-poller.bat. Leave the window open; Ctrl+C stops it.
import { makeSql } from '../functions/_lib/neon.js';
import { normState, finished, unescapeDeep, stamp } from '../functions/_lib/normalize.js';

const key = process.env.API_FOOTBALL_KEY, dbUrl = process.env.DATABASE_URL;
if (!key || !dbUrl) { console.error('Set API_FOOTBALL_KEY and DATABASE_URL first (see the top of this file).'); process.exit(1); }
const EVERY = Math.max(30, Number(process.env.POLL_SECONDS) || 60);
const DAILY = Number(process.env.API_DAILY_LIMIT) || 7500;
const sql = makeSql(dbUrl);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`${new Date().toLocaleTimeString('en-GB')}  ${m}`);
let stop = false, backoff = 0;
process.on('SIGINT', () => { stop = true; log('Stopping after this cycle…'); });

const DONE = "('FT','AET','PEN','CANC','PST','ABD','AWD','WO','SUSP')";
async function activeFixtures() {
  // matches from 90 min before kick-off to ~3.5 h after, that we have not already seen finish
  return (await sql(`select distinct s.fixture_id::text as id from sweepstakes s left join fixture_state f on f.fixture_id = s.fixture_id
    where (s.fixture->>'kickoff')::timestamptz between now() - interval '3 hours 30 minutes' and now() + interval '90 minutes'
      and coalesce(f.state->'status'->>'short', 'NS') not in ${DONE} order by 1 limit 60`)).map((r) => r.id);
}
async function api(path) {
  const [{ calls }] = await sql("insert into api_usage(day, calls) values ((now() at time zone 'utc')::date, 1) on conflict (day) do update set calls = api_usage.calls + 1 returning calls::text as calls");
  if (Number(calls) > DAILY - 50) throw new Error('Daily API budget reached');
  const r = await fetch('https://v3.football.api-sports.io' + path, { headers: { 'x-apisports-key': key } });
  const j = await r.json().catch(() => ({}));
  const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
  if (errs && errs.length) throw new Error(String(errs[0]));
  return unescapeDeep(j.response) || [];
}
const beat = () => sql("insert into api_cache(key, payload, fetched_at) values ('poller:heartbeat', '{}'::jsonb, now()) on conflict (key) do update set fetched_at = now()");

async function cycle() {
  const ids = await activeFixtures();
  if (!ids.length) { await beat(); return log('No active matches - idle (no API calls).'); }
  let saved = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const resp = await api(`/fixtures?ids=${ids.slice(i, i + 20).join('-')}`);
    for (const f of resp) {
      const prevRow = (await sql('select state::text as state from fixture_state where fixture_id = $1', [f.fixture.id]))[0];
      const st = stamp(prevRow ? JSON.parse(prevRow.state) : null, normState(f)), json = JSON.stringify(st);
      await sql("insert into api_cache(key, payload, fetched_at) values ($1, $2::jsonb, now()) on conflict (key) do update set payload = excluded.payload, fetched_at = now()", [`state:${st.id}`, json]);
      await sql("insert into fixture_state(fixture_id, state, updated_at) values ($1, $2::jsonb, now()) on conflict (fixture_id) do update set state = excluded.state, updated_at = now()", [st.id, json]);
      saved++; log(`  ${st.teams.home.name} ${st.goals?.home ?? '-'}-${st.goals?.away ?? '-'} ${st.teams.away.name}  [${st.status.short}${st.status.elapsed ? ' ' + st.status.elapsed + "'" : ''}]${finished(st.status.short) ? ' full time' : ''}`);
    }
  }
  await beat(); log(`Updated ${saved} of ${ids.length} match(es).`);
}

log(`Poller started. Checking every ${EVERY}s. Ctrl+C to stop.`);
while (!stop) {
  try { await cycle(); backoff = 0; }
  catch (e) { backoff = Math.min(backoff ? backoff * 2 : EVERY, 300); log(`Problem: ${e.message} - the website will fetch directly until I recover. Retrying in ${backoff}s.`); await wait((backoff - EVERY > 0 ? backoff - EVERY : 0) * 1000); }
  for (let t = 0; t < EVERY * 2 && !stop; t++) await wait(500);
}
log('Stopped. The website now falls back to calling API-Football itself.');
