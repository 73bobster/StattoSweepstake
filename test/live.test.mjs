import assert from 'node:assert/strict';
import { normLive, LIVE_LEAGUES } from '../functions/_lib/normalize.js';

const f = {
  fixture: { id: 5, date: '2026-11-21T15:00:00+00:00', status: { short: '1H', long: 'First Half', elapsed: 30 } },
  league: { id: 179, name: 'Premiership', country: 'Scotland', logo: 'x', round: 'R1' },
  teams: { home: { id: 257, name: 'Rangers', logo: 'a' }, away: { id: 247, name: 'Celtic', logo: 'b' } },
  goals: { home: 1, away: 0 },
  events: [{ time: { elapsed: 12, extra: null }, team: { id: 257 }, player: { id: 9, name: 'A Striker' }, assist: { id: 10, name: 'B Winger' }, type: 'Goal', detail: 'Normal Goal' }],
  lineups: [{ team: { id: 257 }, startXI: [], substitutes: [] }],
};
const r = normLive(f);
assert.equal(r.fixture_id, 5);
assert.equal(r.league_id, 179);
assert.equal(r.state.goals.home, 1);
assert.equal(r.state.events[0].pname, 'A Striker');
assert.equal(r.state.lineups, undefined, 'line-ups are not kept on the live board');
assert.ok(LIVE_LEAGUES.has(179) && LIVE_LEAGUES.has(39) && !LIVE_LEAGUES.has(140));
console.log('live board row ok');
