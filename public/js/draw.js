// Statto Sweepstake - random, balanced player draw (pure, no DOM, testable in Node).
//
// pool.players: [{ id, name, number, photo, side: 'home'|'away', role: 'GK'|'DEF'|'MID'|'ATT', bench: true|false|null }]
//   bench === null  -> lineups not known yet (squad list): anyone can be a starter or a sub
//   bench === false -> in the starting XI; bench === true -> named substitute
// config: { starters: 3, subs: 1, includeGK: false }
// Returns { picks: [{ memberId, playerId, slot: 'starter'|'sub', role, side }], summary }

export const ROLES = ['DEF', 'MID', 'ATT'];

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function roleDemand(memberCount, config) {
  const seq = config.includeGK ? ['DEF', 'MID', 'ATT', 'GK'] : ROLES.slice();
  const s = config.starters;
  const base = Math.floor(s / seq.length);
  const extra = s % seq.length;
  // per member: list of roles. Extra roles rotate between members so totals stay as even as possible.
  const perMember = [];
  for (let m = 0; m < memberCount; m++) {
    const roles = [];
    for (const r of seq) for (let k = 0; k < base; k++) roles.push(r);
    for (let k = 0; k < extra; k++) roles.push(seq[(m + k) % seq.length]);
    perMember.push(roles);
  }
  return perMember;
}

export function checkFeasible(pool, memberCount, config) {
  const demand = roleDemand(memberCount, config);
  const need = {};
  demand.flat().forEach((r) => (need[r] = (need[r] || 0) + 1));
  const known = pool.players.some((p) => p.bench !== null && p.bench !== undefined);
  const starterPool = pool.players.filter((p) => !known || p.bench === false);
  for (const r of Object.keys(need)) {
    const have = starterPool.filter((p) => p.role === r).length;
    if (have < need[r]) {
      return { ok: false, message: `Not enough ${label(r)} for ${memberCount} friends: need ${need[r]}, only ${have} available. Try fewer starters each.` };
    }
  }
  const subNeed = memberCount * config.subs;
  const subPool = subCandidates(pool, new Set(), config, known);
  const used = memberCount * config.starters;
  if (subPool.length - Math.min(used, 0) < subNeed) {
    return { ok: false, message: `Not enough substitutes for ${memberCount} friends (need ${subNeed}, have ${subPool.length}).` };
  }
  if (known === false) {
    const total = memberCount * (config.starters + config.subs);
    if (total > pool.players.length) return { ok: false, message: 'Not enough players in the squads for that many friends.' };
  }
  return { ok: true };
}

function label(r) {
  return { DEF: 'defenders', MID: 'midfielders', ATT: 'attackers', GK: 'goalkeepers' }[r] || r;
}

function subCandidates(pool, taken, config, known) {
  return pool.players.filter((p) => {
    if (taken.has(p.id)) return false;
    if (!config.includeGK && p.role === 'GK') return false;
    return known ? p.bench === true : true;
  });
}

function attempt(pool, memberIds, config, rng) {
  const known = pool.players.some((p) => p.bench !== null && p.bench !== undefined);
  const order = shuffle(memberIds, rng);
  const demand = roleDemand(order.length, config);
  const taken = new Set();
  const picks = [];
  const sideCount = new Map(order.map((m) => [m, { home: 0, away: 0 }]));

  const starterPool = pool.players.filter((p) => !known || p.bench === false);
  const bucket = (list, role) => ({
    home: shuffle(list.filter((p) => p.role === role && p.side === 'home' && !taken.has(p.id)), rng),
    away: shuffle(list.filter((p) => p.role === role && p.side === 'away' && !taken.has(p.id)), rng),
  });

  // Starters: role by role, giving each friend a player from the side they have fewer of.
  const needByRole = {};
  demand.forEach((roles, i) => roles.forEach((r) => (needByRole[r] = (needByRole[r] || []).concat(order[i]))));
  for (const role of shuffle(Object.keys(needByRole), rng)) {
    const b = bucket(starterPool, role);
    for (const memberId of shuffle(needByRole[role], rng)) {
      const sc = sideCount.get(memberId);
      let side = sc.home === sc.away ? (rng() < 0.5 ? 'home' : 'away') : sc.home < sc.away ? 'home' : 'away';
      if (!b[side].length) side = side === 'home' ? 'away' : 'home';
      const p = b[side].pop();
      if (!p) throw new Error(`Ran out of ${label(role)}`);
      taken.add(p.id);
      sc[p.side]++;
      picks.push({ memberId, playerId: p.id, slot: 'starter', role: p.role, side: p.side });
    }
  }

  // Subs: same balancing, any outfield role.
  for (let k = 0; k < config.subs; k++) {
    for (const memberId of shuffle(order, rng)) {
      const cand = subCandidates(pool, taken, config, known);
      const sc = sideCount.get(memberId);
      let want = sc.home === sc.away ? (rng() < 0.5 ? 'home' : 'away') : sc.home < sc.away ? 'home' : 'away';
      let list = cand.filter((p) => p.side === want);
      if (!list.length) list = cand;
      if (!list.length) throw new Error('Ran out of substitutes');
      const p = list[Math.floor(rng() * list.length)];
      taken.add(p.id);
      sc[p.side]++;
      picks.push({ memberId, playerId: p.id, slot: 'sub', role: p.role, side: p.side });
    }
  }

  // Imbalance score: how uneven each friend's home/away split is, then how uneven total counts are.
  let score = 0;
  for (const sc of sideCount.values()) score += Math.abs(sc.home - sc.away);
  return { picks, score };
}

export function runDraw({ pool, memberIds, config, rng = Math.random, attempts = 300 }) {
  const cfg = { starters: 3, subs: 1, includeGK: false, ...config };
  const feas = checkFeasible(pool, memberIds.length, cfg);
  if (!feas.ok) throw new Error(feas.message);
  let best = null;
  for (let i = 0; i < attempts; i++) {
    const r = attempt(pool, memberIds, cfg, rng);
    if (!best || r.score < best.score) best = r;
    if (best.score <= (cfg.starters + cfg.subs) % 2 * memberIds.length) break; // as even as parity allows
  }
  return { picks: best.picks, summary: { imbalance: best.score } };
}

// ---------------------------------------------------------------------------
// Whole-squad deal: every player goes to someone, as evenly as possible.
// Leftovers (fewer than one per person) are left out at random so nobody gets an extra player.
// Players are dealt group by group (role x side) round-robin, so each person's role and side mix stays even.
export function dealAll({ pool, memberIds, rng = Math.random, includeGK = true }) {
  const k = memberIds.length;
  if (!k) throw new Error('Nobody to deal to.');
  let players = pool.players.filter((p) => includeGK || p.role !== 'GK');
  if (players.length < k) throw new Error('Not enough players for that many people.');
  players = shuffle(players, rng);
  players = players.slice(0, Math.floor(players.length / k) * k); // drop the random remainder
  const groups = new Map();
  for (const p of players) {
    const key = `${p.role}-${p.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const order = shuffle(memberIds, rng);
  let ptr = 0;
  const picks = [];
  for (const list of shuffle([...groups.values()], rng)) {
    for (const p of list) {
      picks.push({ memberId: order[ptr % k], playerId: p.id, slot: p.bench === true ? 'sub' : 'starter', role: p.role, side: p.side });
      ptr++;
    }
  }
  return { picks, summary: { each: players.length / k, leftOut: pool.players.filter((p) => includeGK || p.role !== 'GK').length - players.length } };
}

// ---------------------------------------------------------------------------
// Draft helpers (snake order: 1..k, then k..1, ...)
export function draftTurn(order, pickCount) {
  const k = order.length;
  const round = Math.floor(pickCount / k);
  let idx = pickCount % k;
  if (round % 2 === 1) idx = k - 1 - idx;
  return order[idx];
}

/** How many picks each person gets in a draft. */
export function draftEach(poolSize, memberCount, config) {
  const max = Math.floor(poolSize / memberCount);
  if (config.limit === 'all') return max;
  return Math.max(1, Math.min(max, (config.starters || 0) + (config.subs || 0)));
}

/** The computer's pick: random, but leaning towards players likely to score points (attackers, then midfielders). */
export function cpuPick(available, rng = Math.random) {
  const weight = { ATT: 3, MID: 2, DEF: 1, GK: 0.4 };
  const total = available.reduce((t, p) => t + (weight[p.role] ?? 1), 0);
  let r = rng() * total;
  for (const p of available) { r -= weight[p.role] ?? 1; if (r <= 0) return p; }
  return available[available.length - 1];
}

const CPU_NAMES = ['Gaffer Bot', 'Stat-O-Matic', 'Robo-Ref', 'Captain Algorithm', 'The Mighty Byte', 'Pixel Pundit', 'Bot Ronaldo', 'Cyber Cloughie'];
export const cpuNames = (n) => CPU_NAMES.slice(0, n);
