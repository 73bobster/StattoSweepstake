// Shared by the Pages Function and the home poller (tools/poller.mjs): turns API-Football fixture objects into our compact shape.
// API-Football sometimes returns HTML-escaped text (O&apos;Donnell); store and show it as plain text.
const ENT = { '&apos;': "'", '&#39;': "'", '&#x27;': "'", '&quot;': '"', '&amp;': '&' };
export const unescapeDeep = (v) => typeof v === 'string' ? v.replace(/&(apos|#39|#x27|quot|amp);/g, (m) => ENT[m]) : Array.isArray(v) ? v.map(unescapeDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unescapeDeep(x)])) : v;

export const ROLE = { Goalkeeper: 'GK', Defender: 'DEF', Midfielder: 'MID', Attacker: 'ATT', G: 'GK', D: 'DEF', M: 'MID', F: 'ATT' };
export const finished = (s) => ['FT', 'AET', 'PEN'].includes(s);

export const normFixtureRow = (f) => ({
  id: f.fixture.id,
  kickoff: f.fixture.date,
  status: { short: f.fixture.status.short, long: f.fixture.status.long, elapsed: f.fixture.status.elapsed },
  league: { id: f.league.id, name: f.league.name, country: f.league.country, logo: f.league.logo, round: f.league.round },
  teams: {
    home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
    away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
  },
  goals: f.goals,
});

export function normLineups(lineups, homeId) {
  if (!lineups?.length) return null;
  const out = {};
  for (const l of lineups) {
    const side = l.team.id === homeId ? 'home' : 'away';
    out[side] = {
      formation: l.formation,
      coach: l.coach?.name,
      startXI: l.startXI.map((p) => p.player.id),
      subs: l.substitutes.map((p) => p.player.id),
      players: [
        ...l.startXI.map((p) => ({ ...p.player, bench: false })),
        ...l.substitutes.map((p) => ({ ...p.player, bench: true })),
      ].map((p) => ({ id: p.id, name: p.name, number: p.number, role: ROLE[p.pos] || 'MID', bench: p.bench })),
    };
  }
  return out.home && out.away ? out : null;
}

export function normState(f) {
  return {
    ...normFixtureRow(f),
    events: (f.events || []).map((e) => ({
      x: e.time.elapsed, e: e.time.extra, team: e.team.id, pid: e.player?.id ?? null, pname: e.player?.name ?? null,
      aid: e.assist?.id ?? null, aname: e.assist?.name ?? null, type: e.type, detail: e.detail,
    })),
    lineups: normLineups(f.lineups, f.teams.home.id),
  };
}

