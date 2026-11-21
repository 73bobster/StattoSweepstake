// One-off / resumable loader that runs on YOUR computer (home IP) instead of Cloudflare.
// Why: API-Football blocks shared cloud IPs (Cloudflare Workers) with "Too many requests" even when the key is fine.
//
// Usage (PowerShell), with your VPN OFF:
//   $env:API_FOOTBALL_KEY = "<your Pro key>"
//   $env:FOOTBALL_DATABASE_URL = "<football-data connection string>"
//   node tools/load-football-data.mjs
//
// Safe to stop (Ctrl+C) and re-run: it carries on where it stopped. Needs Node 18+.
import { makeSql } from '../functions/_lib/neon.js';
import * as fd from '../functions/_lib/footballdata.js';

const key = process.env.API_FOOTBALL_KEY, dbUrl = process.env.FOOTBALL_DATABASE_URL;
if (!key || !dbUrl) { console.error('Set API_FOOTBALL_KEY and FOOTBALL_DATABASE_URL first (see the top of this file).'); process.exit(1); }
const DAILY = Number(process.env.API_DAILY_LIMIT) || 7500;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0, lastCall = 0;

async function request(path) {
  for (let attempt = 0; ; attempt++) {
    const gap = Date.now() - lastCall; if (gap < 250) await wait(250 - gap); // gentle pacing: max ~4 calls a second
    lastCall = Date.now(); calls++;
    const r = await fetch('https://v3.football.api-sports.io' + path, { headers: { 'x-apisports-key': key } });
    const j = await r.json().catch(() => ({}));
    const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
    if (errs && errs.length) {
      const m = String(errs[0]);
      if (/too many requests|rate ?limit|per minute/i.test(m) && attempt < 8) { console.log(`  API says slow down - waiting 30s (attempt ${attempt + 1})`); await wait(30000); continue; }
      throw new Error(m);
    }
    return { response: unesc(j.response), paging: j.paging };
  }
}
const ENT = { '&apos;': "'", '&#39;': "'", '&#x27;': "'", '&quot;': '"', '&amp;': '&' };
const unesc = (v) => typeof v === 'string' ? v.replace(/&(apos|#39|#x27|quot|amp);/g, (m) => ENT[m]) : Array.isArray(v) ? v.map(unesc) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unesc(x)])) : v;

const NAMES = { 39: 'Premier League', 40: 'Championship', 179: 'Scottish Premiership', 180: 'Scottish Championship' };
const ctx = { fsql: makeSql(dbUrl), api: async (p) => (await request(p)).response, apiRaw: (p) => request(p), limit: DAILY, usage: async () => calls };

const plan = await fd.plan(ctx);
console.log(`Plan: ${plan.leagues.length} leagues to set up, ${plan.todo.length} league-seasons to load.`);
for (const l of plan.leagues) { console.log(`Setting up league ${l}`); await fd.stepLeague(ctx, l); }
for (const t of plan.todo) {
  const lbl = `${NAMES[t.league] ?? t.league} ${t.season}/${String(t.season + 1).slice(2)}`;
  console.log(`${lbl}: clubs`); await fd.stepTeams(ctx, t.league, t.season);
  let page = 1, total = 1;
  while (page <= total) { const r = await fd.stepPlayers(ctx, t.league, t.season, page); total = r.total; console.log(`${lbl}: players page ${page}/${total}`); page++; }
}
const p2 = await fd.plan(ctx);
let n = 0; for (const team of p2.numbers) { console.log(`Shirt numbers ${++n}/${p2.numbers.length}`); await fd.stepNumbers(ctx, String(team)); }
const c = (await fd.plan(ctx)).counts;
console.log(`Done. ${c.players} players, ${c.clubs} clubs, ${c.stats} season records. API calls this run: ${calls}.`);
