import assert from 'node:assert/strict';
import { dealAll, draftTurn, draftEach, cpuPick, cpuNames } from '../public/js/draw.js';
import { computeScores, DEFAULT_RULES, DEFAULT_AWARDS } from '../public/js/scoring.js';

let seed = 7;
const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const mk = (n, bench) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: 'P' + i, side: i % 2 ? 'home' : 'away', role: ['GK', 'DEF', 'DEF', 'MID', 'MID', 'ATT'][i % 6], bench }));

// dealAll: equal counts, unique players, leftovers dropped
for (const n of [2, 3, 4, 5, 7]) for (const size of [44, 50, 53]) {
  const pool = { players: mk(size, null) };
  const ids = Array.from({ length: n }, (_, i) => 'm' + i);
  const { picks, summary } = dealAll({ pool, memberIds: ids, rng });
  assert.equal(new Set(picks.map((p) => p.playerId)).size, picks.length);
  const counts = ids.map((m) => picks.filter((p) => p.memberId === m).length);
  assert.equal(Math.max(...counts), Math.min(...counts), `equal counts ${n}/${size} ${counts}`);
  assert.equal(summary.each * n + summary.leftOut, size);
  // role spread stays tight
  for (const role of ['DEF', 'MID', 'ATT']) {
    const c = ids.map((m) => picks.filter((p) => p.memberId === m && p.role === role).length);
    assert.ok(Math.max(...c) - Math.min(...c) <= 2, `role ${role} spread ${c}`);
  }
}
// bench flag -> slot
const known = { players: [...mk(22, false), ...mk(14, true).map((p) => ({ ...p, id: p.id + 100 }))] };
const dk = dealAll({ pool: known, memberIds: ['a', 'b'], rng });
const byId = new Map(known.players.map((p) => [p.id, p]));
dk.picks.forEach((p) => assert.equal(p.slot, byId.get(p.playerId).bench ? 'sub' : 'starter'));
assert.throws(() => dealAll({ pool: { players: mk(2) }, memberIds: ['a', 'b', 'c'], rng }));

// snake order
const order = ['a', 'b', 'c'];
assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((n) => draftTurn(order, n)), ['a', 'b', 'c', 'c', 'b', 'a', 'a', 'b']);
assert.equal(draftEach(50, 4, { limit: 'all' }), 12);
assert.equal(draftEach(50, 4, { limit: 'limited', starters: 3, subs: 1 }), 4);
assert.equal(draftEach(10, 4, { limit: 'limited', starters: 6, subs: 2 }), 2); // capped by pool

// cpu leans to attackers
const avail = [...Array(50)].map((_, i) => ({ id: i, role: i < 25 ? 'GK' : 'ATT' }));
let att = 0; for (let i = 0; i < 400; i++) if (cpuPick(avail, rng).role === 'ATT') att++;
assert.ok(att > 300, 'cpu prefers attackers ' + att);
assert.equal(cpuNames(3).length, 3);

// appearance points
const picks = [
  { memberId: 'm1', playerId: 1, playerName: 'Starter', slot: 'starter', role: 'MID', side: 'home' },
  { memberId: 'm1', playerId: 2, playerName: 'Sub on', slot: 'sub', role: 'ATT', side: 'home' },
  { memberId: 'm2', playerId: 3, playerName: 'Off', slot: 'starter', role: 'MID', side: 'away' },
  { memberId: 'm2', playerId: 9, playerName: 'Unused', slot: 'sub', role: 'DEF', side: 'away' },
];
const state = {
  status: { short: '2H', elapsed: 70 }, goals: { home: 0, away: 0 },
  lineups: { home: { startXI: [1], subs: [2] }, away: { startXI: [3], subs: [9] } },
  events: [{ x: 60, team: 10, pid: 1, pname: 'x', aid: 2, aname: 'Sub on', type: 'subst', detail: 'Substitution 1' }, { x: 62, team: 20, pid: 3, pname: 'Off', aid: 8, type: 'subst', detail: 'Substitution 1' }],
};
const members = [{ id: 'm1', name: 'A' }, { id: 'm2', name: 'B' }];
const off = computeScores({ rules: DEFAULT_RULES, awards: DEFAULT_AWARDS, members, picks, state });
assert.equal(off.rows.reduce((t, r) => t + r.lines.length, 0), 0, 'appearance rules are off by default');
const rules = JSON.parse(JSON.stringify(DEFAULT_RULES)); ['starts', 'subOn', 'subbedOff'].forEach((k) => (rules[k].on = true));
const on = computeScores({ rules, awards: DEFAULT_AWARDS, members, picks, state });
const pts = Object.fromEntries(on.rows.map((r) => [r.name, r.points]));
// A: Starter starts +1, goes off -1 (60'), Sub on +1 = 1 ; B: Off starts +1, goes off -1 = 0
assert.deepEqual(pts, { A: 1, B: 0 });
// not started yet -> no appearance points
const pre = computeScores({ rules, awards: DEFAULT_AWARDS, members, picks, state: { ...state, status: { short: 'NS' }, events: [] } });
assert.equal(pre.rows.reduce((t, r) => t + r.points, 0), 0);
console.log('modes tests passed');

// confirmed line-ups: every starter is always dealt, hands are equal in size, only bench players are ever left out
{
  const roles = (r) => Object.entries(r).flatMap(([role, n]) => Array.from({ length: n }, () => role));
  let id = 0;
  const side = (s, bench, spec) => roles(spec).map((role) => ({ id: ++id, name: 'X' + id, side: s, role, bench }));
  const lineup = { players: [...side('home', false, { GK: 1, DEF: 4, MID: 4, ATT: 2 }), ...side('away', false, { GK: 1, DEF: 4, MID: 4, ATT: 2 }), ...side('home', true, { GK: 1, DEF: 3, MID: 3, ATT: 2 }), ...side('away', true, { GK: 1, DEF: 3, MID: 3, ATT: 2 })] };
  for (let n = 2; n <= 8; n++) {
    const ids = Array.from({ length: n }, (_, i) => 'm' + i);
    const { picks } = dealAll({ pool: lineup, memberIds: ids, rng });
    assert.equal(picks.filter((p) => p.slot === 'starter').length, 22, `all starters dealt for ${n}`);
    const sizes = ids.map((m) => picks.filter((p) => p.memberId === m).length);
    assert.equal(Math.max(...sizes), Math.min(...sizes), `equal hands for ${n}: ${sizes}`);
    const st = ids.map((m) => picks.filter((p) => p.memberId === m && p.slot === 'starter').length);
    assert.ok(Math.max(...st) - Math.min(...st) <= 1, `starters within one for ${n}: ${st}`);
    for (const role of ['DEF', 'MID']) { const c = ids.map((m) => picks.filter((p) => p.memberId === m && p.slot === 'starter' && p.role === role).length); assert.ok(Math.max(...c) - Math.min(...c) <= 1, `${role} within one for ${n}: ${c}`); }
  }
}
console.log('lineup deal ok');
