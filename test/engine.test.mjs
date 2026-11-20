import assert from 'node:assert/strict';
import { runDraw, checkFeasible } from '../public/js/draw.js';
import { computeScores, DEFAULT_RULES, DEFAULT_AWARDS } from '../public/js/scoring.js';

let seed = 42;
const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

function mkPool(known) {
  const players = [];
  let id = 1;
  for (const side of ['home', 'away']) {
    const spec = { GK: 1, DEF: 4, MID: 4, ATT: 2 };
    for (const [role, n] of Object.entries(spec)) for (let i = 0; i < n; i++) players.push({ id: id++, name: `${side}-${role}${i}`, side, role, bench: known ? false : null });
    if (known) {
      for (const role of ['GK', 'DEF', 'MID', 'MID', 'ATT', 'ATT', 'DEF']) players.push({ id: id++, name: `${side}-b${id}`, side, role, bench: true });
    } else {
      for (let i = 0; i < 12; i++) players.push({ id: id++, name: `${side}-x${i}`, side, role: ['DEF', 'MID', 'ATT'][i % 3], bench: null });
    }
  }
  return { players };
}

for (const known of [true, false]) {
  for (const n of [2, 3, 4, 5]) {
    for (const cfg of [{ starters: 3, subs: 1 }, { starters: 4, subs: 1 }, { starters: 2, subs: 0 }, { starters: 6, subs: 2 }]) {
      const pool = mkPool(known);
      const members = Array.from({ length: n }, (_, i) => 'm' + i);
      const feas = checkFeasible(pool, n, { includeGK: false, ...cfg });
      if (!feas.ok) continue;
      const { picks } = runDraw({ pool, memberIds: members, config: cfg, rng });
      // unique players
      assert.equal(new Set(picks.map((p) => p.playerId)).size, picks.length);
      // equal counts
      for (const m of members) {
        const mine = picks.filter((p) => p.memberId === m);
        assert.equal(mine.filter((p) => p.slot === 'starter').length, cfg.starters, 'starters');
        assert.equal(mine.filter((p) => p.slot === 'sub').length, cfg.subs, 'subs');
        const h = mine.filter((p) => p.side === 'home').length;
        assert.ok(Math.abs(h - (mine.length - h)) <= 1 + (cfg.starters + cfg.subs > 5 ? 1 : 0), `team balance ${known} ${n} ${JSON.stringify(cfg)} ${h}/${mine.length}`);
      }
      // role evenness among starters: each role count differs by at most 1 per friend across friends
      for (const role of ['DEF', 'MID', 'ATT']) {
        const counts = members.map((m) => picks.filter((p) => p.memberId === m && p.slot === 'starter' && p.role === role).length);
        assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `role spread ${role} ${counts}`);
      }
      if (known) {
        const byId = new Map(pool.players.map((p) => [p.id, p]));
        picks.forEach((p) => assert.equal(byId.get(p.playerId).bench, p.slot === 'sub'));
      }
    }
  }
}

// infeasible
assert.throws(() => runDraw({ pool: mkPool(true), memberIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], config: { starters: 3, subs: 1 }, rng }));

// randomness: different seeds give different draws
const p = mkPool(true);
const d1 = runDraw({ pool: p, memberIds: ['a', 'b'], config: {}, rng: Math.random }).picks.map((x) => x.playerId).join();
const d2 = runDraw({ pool: p, memberIds: ['a', 'b'], config: {}, rng: Math.random }).picks.map((x) => x.playerId).join();
assert.notEqual(d1, d2);

// ---- scoring ----
const members = [{ id: 'a', name: 'Rob' }, { id: 'b', name: 'Sam' }];
const picks = [
  { memberId: 'a', playerId: 10, playerName: 'Striker', slot: 'starter', role: 'ATT', side: 'home' },
  { memberId: 'a', playerId: 11, playerName: 'Keeper', slot: 'starter', role: 'GK', side: 'home' },
  { memberId: 'b', playerId: 20, playerName: 'Winger', slot: 'starter', role: 'ATT', side: 'away' },
  { memberId: 'b', playerId: 21, playerName: 'Sub', slot: 'sub', role: 'DEF', side: 'away' },
];
const state = {
  status: { short: 'FT' }, goals: { home: 2, away: 0 },
  lineups: { home: { startXI: [10, 11], subs: [] }, away: { startXI: [20], subs: [21] } },
  events: [
    { x: 5, team: 1, pid: 20, pname: 'Winger', type: 'Card', detail: 'Yellow Card' },
    { x: 30, team: 1, pid: 10, pname: 'Striker', aid: 20, aname: 'Winger', type: 'Goal', detail: 'Normal Goal' },
    { x: 55, team: 1, pid: 10, pname: 'Striker', type: 'Goal', detail: 'Penalty' },
    { x: 60, team: 1, pid: 99, pname: 'Unowned', type: 'Goal', detail: 'Normal Goal' },
    { x: 61, team: 1, type: 'Var', detail: 'Goal Disallowed' },
    { x: 70, team: 2, pid: 21, aid: 0, pname: 'Sub', type: 'subst', detail: 'Substitution 1' },
  ],
};
const res = computeScores({ rules: DEFAULT_RULES, awards: DEFAULT_AWARDS, members, picks, state });
const rob = res.rows.find((r) => r.name === 'Rob');
const sam = res.rows.find((r) => r.name === 'Sam');
assert.equal(rob.points, 2 + 2 + 2 /* clean sheet keeper only: GK */ - 0);  // goal 2 + pen 2 + clean sheet 2
assert.equal(sam.points, -1 + 1); // yellow -1, assist +1
assert.deepEqual(res.awards.firstBooking.winner, ['Sam']);
assert.deepEqual(res.awards.firstScorer.winner, ['Rob']);
assert.deepEqual(res.awards.topPoints.winner, ['Rob']);
assert.equal(res.rows[0].name, 'Rob');
console.log('engine tests passed');
