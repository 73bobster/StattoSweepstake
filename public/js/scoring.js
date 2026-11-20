// Statto Sweepstake - scoring + awards (pure, no DOM, testable in Node).
//
// state (normalised match state, see supabase/functions/football):
//   { status:{short,long,elapsed}, goals:{home,away}, teams:{home:{id,name},away:{id,name}},
//     events:[{ x:elapsed, e:extra, team:teamId, pid, pname, aid, aname, type, detail }],
//     lineups:{ home:{startXI:[id..], subs:[id..]}, away:{...} } | null }

export const DEFAULT_RULES = {
  goal:      { label: 'Goal',                  points: 2,  on: true },
  penalty:   { label: 'Penalty scored',        points: 2,  on: true },
  assist:    { label: 'Assist',                points: 1,  on: true },
  ownGoal:   { label: 'Own goal',              points: -2, on: true },
  penMissed: { label: 'Penalty missed',        points: -1, on: true },
  yellow:    { label: 'Yellow card',           points: -1, on: true },
  red:       { label: 'Red card',              points: -3, on: true },
  cleanSheet:{ label: 'Clean sheet (GK/DEF who played)', points: 2, on: true },
};

export const DEFAULT_AWARDS = {
  firstScorer:  { label: 'First goalscorer',          on: true },
  firstBooking: { label: 'First booking',             on: true },
  mostScorers:  { label: 'Most different goalscorers',on: true },
  mostBookings: { label: 'Most bookings',             on: true },
  topPoints:    { label: 'Most points',               on: true },
  woodenSpoon:  { label: 'Wooden spoon (fewest points)', on: false },
};

const FINISHED = new Set(['FT', 'AET', 'PEN']);
export const isFinished = (state) => !!state && FINISHED.has(state.status?.short);
export const isLive = (state) => !!state && ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT'].includes(state.status?.short);
export const hasStarted = (state) => !!state && !['NS', 'TBD', 'PST', 'CANC'].includes(state.status?.short);

const evOrder = (a, b) => (a.x ?? 0) - (b.x ?? 0) || (a.e ?? 0) - (b.e ?? 0);

/** Remove goals that VAR later cancelled (best effort: cancels the latest earlier goal by the same team). */
export function cleanEvents(events = []) {
  const evs = events.slice().sort(evOrder);
  const voided = new Set();
  evs.forEach((ev, i) => {
    if (ev.type === 'Var' && /cancel|disallow/i.test(ev.detail || '')) {
      for (let j = i - 1; j >= 0; j--) {
        if (evs[j].type === 'Goal' && evs[j].team === ev.team && !voided.has(j) && (ev.x - evs[j].x) <= 8) {
          voided.add(j);
          break;
        }
      }
    }
  });
  return evs.filter((_, i) => !voided.has(i));
}

function classify(ev) {
  const d = (ev.detail || '').toLowerCase();
  if (ev.type === 'Goal') {
    if (d.includes('own')) return 'ownGoal';
    if (d.includes('missed')) return 'penMissed';
    if (d.includes('penalty')) return 'penalty';
    return 'goal';
  }
  if (ev.type === 'Card') {
    if (d.includes('red') || d.includes('second yellow')) return 'red';
    return 'yellow';
  }
  return null;
}

export function playedIds(state) {
  const set = new Set();
  const l = state?.lineups;
  if (l) ['home', 'away'].forEach((s) => (l[s]?.startXI || []).forEach((id) => set.add(id)));
  (state?.events || []).forEach((ev) => { if (ev.type === 'subst' && ev.aid) set.add(ev.aid); });
  return set;
}

/**
 * Compute the leaderboard.
 * rules: DEFAULT_RULES-shaped; members: [{id,name}]; picks: [{memberId,playerId,playerName,slot,role,side,teamId}]
 */
export function computeScores({ rules, awards, members, picks, state }) {
  const events = cleanEvents(state?.events || []);
  const ownerOf = new Map(picks.map((p) => [p.playerId, p]));
  const board = new Map(members.map((m) => [m.id, { memberId: m.id, name: m.name, points: 0, lines: [], goals: 0, scorers: new Set(), bookings: 0 }]));
  const feed = [];

  const add = (pick, key, minuteLabel, extraLabel) => {
    const r = rules[key];
    const row = board.get(pick.memberId);
    if (!row) return;
    const pts = r && r.on ? r.points : 0;
    row.points += pts;
    row.lines.push({ playerId: pick.playerId, playerName: pick.playerName, key, label: r?.label || key, points: pts, minute: minuteLabel });
  };

  let firstScorer = null;
  let firstBooking = null;

  for (const ev of events) {
    const kind = classify(ev);
    const minute = ev.x != null ? `${ev.x}${ev.e ? '+' + ev.e : ''}'` : '';
    const owner = ev.pid ? ownerOf.get(ev.pid) : null;
    if (kind) {
      feed.push({ ...ev, kind, minute, ownerMemberId: owner?.memberId || null });
      if (owner) {
        add(owner, kind, minute);
        const row = board.get(owner.memberId);
        if (row) {
          if (kind === 'goal' || kind === 'penalty') { row.goals++; row.scorers.add(ev.pid); }
          if (kind === 'yellow' || kind === 'red') row.bookings++;
        }
      }
      if ((kind === 'goal' || kind === 'penalty') && !firstScorer) firstScorer = { ev, owner };
      if ((kind === 'yellow' || kind === 'red') && !firstBooking) firstBooking = { ev, owner };
    }
    if (ev.type === 'Goal' && !/own|missed/i.test(ev.detail || '') && ev.aid) {
      const a = ownerOf.get(ev.aid);
      if (a) add(a, 'assist', minute);
    }
  }

  // Clean sheets once the match is finished
  if (isFinished(state) && rules.cleanSheet?.on) {
    const played = playedIds(state);
    const lineupKnown = !!state.lineups;
    const conceded = { home: state.goals?.away ?? null, away: state.goals?.home ?? null };
    for (const p of picks) {
      if (!['GK', 'DEF'].includes(p.role)) continue;
      if (conceded[p.side] !== 0) continue;
      const did = lineupKnown ? played.has(p.playerId) : p.slot === 'starter';
      if (did) add(p, 'cleanSheet', 'FT');
    }
  }

  const rows = [...board.values()].map((r) => ({ ...r, scorers: r.scorers.size }));
  rows.sort((a, b) => b.points - a.points || b.goals - a.goals || a.name.localeCompare(b.name));
  let rank = 0, prev = null;
  rows.forEach((r, i) => { if (prev === null || r.points !== prev) rank = i + 1; r.rank = rank; prev = r.points; });

  const nameOf = (id) => members.find((m) => m.id === id)?.name;
  const topBy = (key, dir = 1) => {
    const max = Math.max(...rows.map((r) => r[key] * dir));
    if (!rows.length || max <= 0 && key !== 'points') return null;
    return rows.filter((r) => r[key] * dir === max).map((r) => r.name);
  };
  const out = {};
  const A = awards || DEFAULT_AWARDS;
  const fin = isFinished(state);
  if (A.firstScorer?.on) out.firstScorer = firstScorer ? { winner: firstScorer.owner ? [nameOf(firstScorer.owner.memberId)] : [], detail: `${firstScorer.ev.pname} ${firstScorer.ev.x}'`, unowned: !firstScorer.owner, final: true } : { winner: null, detail: 'No goals yet' };
  if (A.firstBooking?.on) out.firstBooking = firstBooking ? { winner: firstBooking.owner ? [nameOf(firstBooking.owner.memberId)] : [], detail: `${firstBooking.ev.pname} ${firstBooking.ev.x}'`, unowned: !firstBooking.owner, final: true } : { winner: null, detail: 'No bookings yet' };
  if (A.mostScorers?.on) out.mostScorers = { winner: topBy('scorers'), detail: 'different players scoring', final: fin };
  if (A.mostBookings?.on) out.mostBookings = { winner: topBy('bookings'), detail: 'cards picked up', final: fin };
  if (A.topPoints?.on) out.topPoints = { winner: rows.length && hasAnyPoints(rows) ? rows.filter((r) => r.points === rows[0].points).map((r) => r.name) : null, detail: 'points', final: fin };
  if (A.woodenSpoon?.on) {
    const min = Math.min(...rows.map((r) => r.points));
    out.woodenSpoon = { winner: rows.length && hasAnyPoints(rows) ? rows.filter((r) => r.points === min).map((r) => r.name) : null, detail: 'points', final: fin };
  }
  return { rows, awards: out, feed };
}

function hasAnyPoints(rows) {
  return rows.some((r) => r.points !== 0 || r.lines.length);
}
