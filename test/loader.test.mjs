// Runs the real loader SQL against an in-process Postgres (PGlite) using the real schema file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import * as fd from '../functions/_lib/footballdata.js';

const db = new PGlite();
await db.exec(readFileSync(new URL('../db/football-data/001_schema.sql', import.meta.url), 'utf8'));
const fsql = async (q, p = []) => (await db.query(q, p)).rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : String(v)])));

let calls = 0; const paths = [];
const pl = (id, name, fn, ln, team, pos, apps, lg = 39) => ({ player: { id, name, firstname: fn, lastname: ln, birth: { date: '1990-05-01', place: 'X', country: 'England' }, nationality: 'England', height: '185 cm', weight: '80 kg', photo: 'p.png' },
  statistics: [{ team: { id: team }, league: { id: lg }, games: { appearences: apps, lineups: apps - 1, minutes: apps * 80, position: pos, rating: '7.2345' }, substitutes: { in: 1, out: 2, bench: 3 }, goals: { total: 4, conceded: 0, assists: 2, saves: null }, cards: { yellow: 3, red: 0, yellowred: 1 }, penalty: { scored: 1, missed: 0, saved: null } }] });
const fake = {
  '/leagues?id=39': [{ league: { id: 39, name: 'Premier League' }, country: { name: 'England', code: 'GB-ENG' }, seasons: [{ year: 2013, start: '2013-08-01', end: '2014-05-01' }, { year: 2024, start: '2024-08-16', end: '2025-05-25', current: false }, { year: 2026, start: '2026-08-14', end: '2027-05-23', current: true }] }],
  '/teams?league=39&season=2024': [{ team: { id: 50, name: 'Manchester City', code: 'MCI', country: 'England', founded: 1880, national: false, logo: 'l' }, venue: { name: 'Etihad', city: 'Manchester', capacity: 53000 } }, { team: { id: 45, name: 'Everton', code: 'EVE', country: 'England', founded: 1878, logo: 'l' }, venue: { name: 'Goodison', city: 'Liverpool', capacity: 39000 } }],
  '/players?league=39&season=2024&page=1': { response: [pl(1, 'E. Haaland', 'Erling', 'Haaland', 50, 'Attacker', 30), pl(2, 'J. Pickford', 'Jordan', 'Pickford', 45, 'Goalkeeper', 38), pl(1, 'E. Haaland', 'Erling', 'Haaland', 50, 'Attacker', 30), pl(9, 'Other', 'O', 'Ther', 50, 'Midfielder', 5, 140)], paging: { current: 1, total: 2 } },
  '/players?league=39&season=2024&page=2': { response: [pl(3, 'Á. Núñez', 'Álvaro', 'Núñez', 999, 'Defender', 10)], paging: { current: 2, total: 2 } },
  '/players/squads?team=50': [{ players: [{ id: 1, name: 'E. Haaland', number: 9, position: 'Attacker', photo: 'p' }, { id: 77, name: 'New Signing', number: 77, position: 'Midfielder' }] }],
};
const ctx = { fsql, limit: 7500, usage: async () => calls,
  api: async (p) => { calls++; paths.push(p); return fake[p]; }, apiRaw: async (p) => { calls++; paths.push(p); return fake[p]; } };

// mapper
assert.equal(fd.nameKey('Álvaro  Núñez-Smith'), 'alvaro nunez smith');
const m = fd.mapPlayerItem(pl(1, 'E. Haaland', 'Erling', 'Haaland', 50, 'Attacker', 30), 39);
assert.equal(m.player.full_name, 'Erling Haaland'); assert.equal(m.player.height_cm, 185); assert.equal(m.player.position, 'ATT'); assert.equal(m.stats[0].rating, 7.23);
assert.equal(fd.mapPlayerItem(pl(9, 'x', 'a', 'b', 1, 'Attacker', 1, 140), 39).stats.length, 0);

// plan before anything
let p = await fd.plan(ctx);
assert.equal(p.leagues.length, 4); assert.equal(p.todo.length, 4 * (fd.LAST_SEASON - fd.FIRST_SEASON + 1)); assert.deepEqual(p.todo[0], { league: 39, season: fd.LAST_SEASON });

// league + seasons (out-of-range season 2013 skipped)
assert.deepEqual(await fd.stepLeague(ctx, 39), { league: 39, name: 'Premier League', seasons: 2 });
await fd.stepLeague(ctx, 39); // idempotent
assert.equal((await fsql('select count(*) as n from ref.competitions'))[0].n, '1');
assert.equal((await fsql('select count(*) as n from ref.competition_seasons'))[0].n, '2');
assert.equal((await fsql("select is_current from ref.competition_seasons where season = 2026"))[0].is_current, 'true');

// teams
await fd.stepTeams(ctx, 39, 2024); await fd.stepTeams(ctx, 39, 2024);
assert.equal((await fsql('select count(*) as n from ref.clubs'))[0].n, '2');
assert.equal((await fsql("select nation_code from ref.clubs where name = 'Everton'"))[0].nation_code, 'GB-ENG');
assert.equal((await fsql('select count(*) as n from ref.club_seasons'))[0].n, '2');

// players, page 1 (duplicate Haaland collapsed, other-league stats ignored) then page 2 (unknown club dropped, player kept)
let r1 = await fd.stepPlayers(ctx, 39, 2024, 1);
assert.deepEqual([r1.players, r1.rows, r1.done], [3, 2, false]);
let r2 = await fd.stepPlayers(ctx, 39, 2024, 2);
assert.equal(r2.done, true);
await fd.stepPlayers(ctx, 39, 2024, 1); // idempotent re-run
assert.equal((await fsql('select count(*) as n from ref.players'))[0].n, '4');
assert.equal((await fsql('select count(*) as n from ref.player_season_stats'))[0].n, '2');
assert.equal((await fsql('select count(*) as n from ref.squad_entries'))[0].n, '2');
const h = (await fsql("select p.full_name, p.birth_date::text as birth_date, p.height_cm, s.goals, s.appearances, s.starts, s.rating, s.extra->>'yellowred' as yr from ref.players p join ref.player_season_stats s on s.player_id = p.id where p.name_key = 'erling haaland'"))[0];
assert.deepEqual(h, { full_name: 'Erling Haaland', birth_date: '1990-05-01', height_cm: '185', goals: '4', appearances: '30', starts: '29', rating: '7.23', yr: '1' });

// plan now: 39/2024 done, numbers needed for 2026 clubs only (none yet in 2026)
p = await fd.plan(ctx);
assert.equal(p.leagues.length, 3); assert.ok(!p.todo.some((t) => t.league === 39 && t.season === 2024));

// numbers: attach 2026 club season and load squad numbers
await fsql("insert into ref.club_seasons select (select id from ref.competition_seasons where season = 2026), id from ref.clubs where name = 'Manchester City'");
p = await fd.plan(ctx); assert.deepEqual(p.numbers, ['50']);
await fd.stepNumbers(ctx, '50');
const sn = await fsql("select p.known_as, e.shirt_number from ref.squad_entries e join ref.players p on p.id = e.player_id where e.season = 2026 order by 1");
assert.deepEqual(sn, [{ known_as: 'E. Haaland', shirt_number: '9' }, { known_as: 'New Signing', shirt_number: '77' }]);
assert.equal((await fsql('select count(*) as n from ref.players'))[0].n, '5'); // Haaland matched, not duplicated
assert.deepEqual((await fd.plan(ctx)).numbers, []);

// guards
await assert.rejects(() => fd.stepTeams(ctx, 1, 2024), /Unknown league/);
await assert.rejects(() => fd.stepTeams(ctx, 39, 1990), /Season out of range/);
await assert.rejects(() => fd.stepNumbers(ctx, '1;drop'), /Bad team/);
await assert.rejects(() => fd.stepTeams({ ...ctx, usage: async () => 7000 }, 39, 2024), /budget reserve/);
assert.ok((await fsql('select sum(api_calls)::text as n from ref.load_log'))[0].n > 0);
console.log('loader tests passed; api calls:', calls);
