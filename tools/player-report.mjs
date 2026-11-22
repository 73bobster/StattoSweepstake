// One-off: pull everything API-Football has on ONE player and save it to a folder.
// Run from your own computer (home IP). Nothing is written to any database; the key is only used for this run.
//
//   $env:API_FOOTBALL_KEY = "<key>"
//   node tools/player-report.mjs 280305            (Ryan Naderi; any API-Football player id works)
//   node tools/player-report.mjs 280305 --matches  (also fetch his stats for every match this season: ~40-60 extra calls)
//
// Or double-click tools/run-player-report.bat. Output: player-report/<id>-<name>/ with player.json (everything raw)
// and report.md (a readable summary).
import { mkdir, writeFile } from 'node:fs/promises';

const KEY = process.env.API_FOOTBALL_KEY;
const id = Number(process.argv[2] || process.env.PLAYER_ID || 280305);
const withMatches = process.argv.includes('--matches') || process.env.WITH_MATCHES === '1';
if (!KEY) { console.error('Set API_FOOTBALL_KEY first (see the top of this file).'); process.exit(1); }
const BASE = 'https://v3.football.api-sports.io';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
const log = (m) => console.log(m);

async function api(path, retries = 4) {
  for (let i = 0; i <= retries; i++) {
    calls++;
    const res = await fetch(BASE + path, { headers: { 'x-apisports-key': KEY } });
    const j = await res.json().catch(() => ({}));
    const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
    const msg = errs && errs.length ? errs.join('; ') : '';
    if (/rate|too many|limit/i.test(msg) && i < retries) { log(`  rate limit - waiting 20s…`); await wait(20000); continue; }
    if (msg) throw new Error(`${path}: ${msg}`);
    await wait(250);
    return j.response || [];
  }
}
const safe = async (label, path) => { try { const r = await api(path); log(`  ${label}: ${r.length}`); return r; } catch (e) { log(`  ${label}: ${e.message}`); return { error: e.message }; } };
const arr = (x) => (Array.isArray(x) ? x : []);

log(`Player ${id}${withMatches ? ' (with match-by-match stats)' : ''}`);
const profile = (await safe('profile', `/players/profiles?player=${id}`));
const seasons = arr(await safe('seasons', `/players/seasons?player=${id}`));
const teams = await safe('teams played for', `/players/teams?player=${id}`);
const transfers = await safe('transfers', `/transfers?player=${id}`);
const trophies = await safe('trophies', `/trophies?player=${id}`);
const sidelined = await safe('sidelined', `/sidelined?player=${id}`);

// season-by-season stats (one call per season he has data for)
const stats = {};
for (const s of seasons.sort((a, b) => a - b)) stats[s] = await safe(`stats ${s}`, `/players?id=${id}&season=${s}`);

// optional: his stats in every match of the latest season (fixtures for his club, then one call per finished match)
const matches = [], teamFixtures = [];
if (withMatches && seasons.length) {
  const latest = Math.max(...seasons);
  const blocks = arr(stats[latest]).flatMap((r) => r.statistics || []);
  const clubs = [...new Map(blocks.map((b) => [b.team?.id, b.team])).values()].filter(Boolean);
  for (const club of clubs) {
    const allFx = await safe(`${club.name} fixtures ${latest}`, `/fixtures?team=${club.id}&season=${latest}`);
    const fx = arr(allFx).filter((f) => ['FT', 'AET', 'PEN'].includes(f.fixture.status.short));
    // every finished fixture the club played this season in ANY competition (cups included), and whether he appears in the match data
    for (const f of arr(allFx)) teamFixtures.push({ id: f.fixture.id, date: f.fixture.date, league: `${f.league?.name} (${f.league?.country})`, leagueId: f.league?.id, round: f.league?.round, status: f.fixture.status.short, home: f.teams.home.name, away: f.teams.away.name, goals: f.goals, played: null });
    for (const f of fx) {
      const r = arr(await safe(`  match ${f.fixture.id} ${f.teams.home.name} v ${f.teams.away.name}`, `/fixtures/players?fixture=${f.fixture.id}`));
      const me = r.flatMap((t) => (t.players || []).map((p) => ({ ...p, team: t.team }))).find((p) => p.player?.id === id);
      const tf = teamFixtures.find((t) => t.id === f.fixture.id);
      if (tf) {
        tf.playersReturned = r.reduce((n, t) => n + (t.players || []).length, 0);
        tf.played = !!me && (me.statistics?.[0]?.games?.minutes ?? 0) > 0 ? `yes (${me.statistics[0].games.minutes} min)` : me ? 'in squad, no minutes' : '';
        if (!me && !/friendl/i.test(f.league?.name || '')) {
          // no player stats for this match: line-ups and events are separate data and often exist even then
          const lu = arr(await safe(`  line-ups ${f.fixture.id}`, `/fixtures/lineups?fixture=${f.fixture.id}`));
          const ev = arr(await safe(`  events ${f.fixture.id}`, `/fixtures/events?fixture=${f.fixture.id}`));
          const inXI = lu.some((t) => (t.startXI || []).some((x) => x.player?.id === id)), onBench = lu.some((t) => (t.substitutes || []).some((x) => x.player?.id === id));
          const evMine = ev.filter((e) => e.player?.id === id || e.assist?.id === id).map((e) => `${e.time?.elapsed}' ${e.type} ${e.detail}${e.assist?.id === id ? ' (assist/on)' : ''}`);
          tf.lineupsPublished = lu.length > 0; tf.events = evMine;
          tf.played = inXI ? `starting XI (no player stats)${evMine.length ? ': ' + evMine.join(', ') : ''}` : onBench ? `bench (no player stats)${evMine.length ? ': ' + evMine.join(', ') : ''}` : lu.length ? 'NOT in the match squad' : `no line-up data; players returned: ${tf.playersReturned}${evMine.length ? '; events: ' + evMine.join(', ') : ''}`;
        } else if (!me) tf.played = `not in match data (players returned: ${tf.playersReturned})`;
      }
      if (me) matches.push({ fixture: f.fixture.id, date: f.fixture.date, league: f.league?.name, home: f.teams.home.name, away: f.teams.away.name, goals: f.goals, stats: me.statistics?.[0] });
    }
  }
}

const p = arr(profile)[0]?.player || arr(stats[Math.max(...seasons)])[0]?.player || {};
const name = (p.name || `player-${id}`).replace(/[^\w]+/g, '-');
const dir = `player-report/${id}-${name}`;
await mkdir(dir, { recursive: true });
await writeFile(`${dir}/player.json`, JSON.stringify({ id, fetchedAt: new Date().toISOString(), profile, seasons, teams, transfers, trophies, sidelined, stats, matches, teamFixtures }, null, 2));

// ---- readable report
const v = (x) => (x === null || x === undefined ? '' : x);
const L = [];
L.push(`# ${p.firstname || ''} ${p.lastname || p.name || ''}`.trim(), '');
L.push(`Fetched ${new Date().toLocaleString('en-GB')} · ${calls} API calls · player id ${id}`, '');
L.push('## Profile', '');
for (const [k, val] of [['Name', p.name], ['Born', `${v(p.birth?.date)} ${v(p.birth?.place)} ${v(p.birth?.country)}`.trim()], ['Age', p.age], ['Nationality', p.nationality], ['Height', p.height], ['Weight', p.weight], ['Shirt number', p.number], ['Position', p.position], ['Injured', p.injured]]) if (val !== '' && val != null) L.push(`- **${k}:** ${val}`);
L.push('', '## Season stats', '');
L.push('| Season | Club | League | Apps | Starts | Mins | Goals | Assists | Yellow | Red | Rating |', '|---|---|---|---|---|---|---|---|---|---|---|');
for (const s of Object.keys(stats).sort((a, b) => b - a)) for (const r of arr(stats[s])) for (const b of r.statistics || []) L.push(`| ${s} | ${v(b.team?.name)} | ${v(b.league?.name)} | ${v(b.games?.appearences)} | ${v(b.games?.lineups)} | ${v(b.games?.minutes)} | ${v(b.goals?.total)} | ${v(b.goals?.assists)} | ${v(b.cards?.yellow)} | ${v(b.cards?.red)} | ${v(b.games?.rating ? Number(b.games.rating).toFixed(2) : '')} |`);
L.push('', '## Clubs and national teams', '');
for (const t of arr(teams)) L.push(`- ${t.team?.name}${t.team?.national ? ' (national)' : ''}: seasons ${(t.seasons || []).join(', ')}`);
L.push('', '## Transfers', '');
for (const t of arr(transfers).flatMap((x) => x.transfers || [])) L.push(`- ${v(t.date)} · ${v(t.type)} · ${v(t.teams?.out?.name)} → ${v(t.teams?.in?.name)}`);
L.push('', '## Trophies', '');
for (const t of arr(trophies)) L.push(`- ${v(t.season)} · ${v(t.league)} · ${v(t.country)} · ${v(t.place)}`);
L.push('', '## Sidelined (injuries and suspensions)', '');
for (const s of arr(sidelined)) L.push(`- ${v(s.type)}: ${v(s.start)} to ${v(s.end)}`);
if (matches.length) {
  L.push('', '## Match by match (latest season)', '', '| Date | Match | Score | Mins | Rating | Goals | Assists | Shots (on) | Pass | Tackles | Cards |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const m of matches) { const s = m.stats || {}; L.push(`| ${String(m.date).slice(0, 10)} | ${m.home} v ${m.away} | ${m.goals?.home}-${m.goals?.away} | ${v(s.games?.minutes)} | ${v(s.games?.rating)} | ${v(s.goals?.total)} | ${v(s.goals?.assists)} | ${v(s.shots?.total)} (${v(s.shots?.on)}) | ${v(s.passes?.total)} | ${v(s.tackles?.total)} | ${v(s.cards?.yellow)}Y ${v(s.cards?.red)}R |`); }
}
if (teamFixtures.length) {
  L.push('', '## Every fixture his club played this season (all competitions)', '', '| Date | Competition | Round | Match | Score | Status | Did he play? |', '|---|---|---|---|---|---|---|');
  for (const t of teamFixtures.sort((a, b) => String(a.date).localeCompare(String(b.date)))) L.push(`| ${String(t.date).slice(0, 10)} | ${v(t.league)} | ${v(t.round)} | ${t.home} v ${t.away} | ${t.goals?.home ?? ''}-${t.goals?.away ?? ''} | ${t.status} | ${v(t.played)} |`);
  const byComp = {}; for (const t of teamFixtures) byComp[t.league] = (byComp[t.league] || 0) + 1;
  L.push('', 'Games per competition: ' + Object.entries(byComp).map(([k, n]) => `${k} ${n}`).join(' · '));
}
await writeFile(`${dir}/report.md`, L.join('\n'));
log(`\nDone. ${calls} calls. Saved to ${dir}/ (report.md is the readable one, player.json has everything raw).`);
