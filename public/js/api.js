// Data layer. Two interchangeable backends:
//  - Neon (live): Neon Auth for sign-in, the Neon Data API (Postgres + row-level security) for data,
//    and the /api/football Cloudflare Pages Function for API-Football (the key never reaches the browser)
//  - Demo (no setup): localStorage + a scripted fake match, so the whole flow can be tried instantly

import { draftTurn } from './draw.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const GUEST_DOMAIN = '@guest.statto.app';

export async function createApi(cfg = {}) {
  if (cfg.neonUrl) return createNeonApi(cfg);
  return createDemoApi();
}

// ---------------------------------------------------------------- Neon
async function createNeonApi(cfg) {
  const { createClient } = await import('https://esm.sh/@neon/neon-js');
  const client = createClient(cfg.neonUrl);
  const auth = client.auth;
  const must = (r) => { if (r.error) throw new Error(r.error.message || String(r.error)); return r.data; };
  const toUser = (u) => u && ({ id: u.id, name: u.name || (u.email ? u.email.split('@')[0] : ''), email: u.email, guest: !!u.email?.endsWith(GUEST_DOMAIN) });
  const listeners = [];
  const notify = async () => { const u = await api.auth.getUser(); listeners.forEach((f) => f(u)); return u; };

  const mapPick = (p) => ({ id: p.id, memberId: p.member_id, playerId: p.player_id, playerName: p.player_name, number: p.number, photo: p.photo, side: p.side, teamId: p.team_id, role: p.role, slot: p.slot });
  const mapMember = (m) => ({ id: m.id, userId: m.user_id, name: m.display_name, isHost: m.is_host, kind: m.kind || 'user' });
  const mapSweep = (s) => ({ id: s.id, code: s.code, name: s.name, creatorId: s.creator_id, fixtureId: s.fixture_id, fixture: s.fixture, rules: s.rules, awards: s.awards, drawConfig: s.draw_config, status: s.status, pool: s.pool || null });

  async function fn(body) {
    const { data } = await auth.getSession();
    const token = data?.session?.token;
    const r = await fetch('/api/football', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || `Football service error (${r.status})`);
    return j;
  }

  const api = {
    mode: 'neon',
    auth: {
      async getUser() {
        const { data } = await auth.getSession();
        if (data?.session && data?.user) return toUser(data.user);
        // Returning guest: quietly sign back in with the credentials we created for them
        try {
          const g = JSON.parse(localStorage.getItem('statto_guest') || 'null');
          if (g) { const r = await auth.signIn.email({ email: g.email, password: g.password }); if (!r.error) return toUser(r.data.user); }
        } catch { /* ignore */ }
        return null;
      },
      async signInGuest(name) {
        const email = `guest-${uid().replace(/-/g, '').slice(0, 16)}${GUEST_DOMAIN}`;
        const password = uid() + uid();
        must(await auth.signUp.email({ email, password, name }));
        localStorage.setItem('statto_guest', JSON.stringify({ email, password }));
        return notify();
      },
      async signInPassword(email, password) { must(await auth.signIn.email({ email, password })); localStorage.removeItem('statto_guest'); return notify(); },
      async signUpPassword(name, email, password) { must(await auth.signUp.email({ email, password, name })); localStorage.removeItem('statto_guest'); return notify(); },
      async signInGoogle() { must(await auth.signIn.social({ provider: 'google', callbackURL: location.origin + location.pathname })); },
      async setName(name) { must(await auth.updateUser({ name })); return this.getUser(); },
      async signOut() { localStorage.removeItem('statto_guest'); await auth.signOut(); listeners.forEach((f) => f(null)); },
      onChange(cb) { listeners.push(cb); },
    },
    listFixtures: async (date) => (await fn({ action: 'fixtures', date })).fixtures,
    getPool: (fx, force, squadOnly) => fn({ action: 'pool', fixtureId: fx.id, homeId: fx.teams.home.id, awayId: fx.teams.away.id, force, squadOnly: !!squadOnly }),
    getState: async (fixtureId, force) => (await fn({ action: 'state', fixtureId, force })).state,
    async createSweepstake({ name, displayName, fixture, rules, awards, drawConfig, members = [] }) {
      return mapSweep(must(await client.rpc('create_sweepstake', { p_name: name, p_display_name: displayName, p_fixture_id: fixture.id, p_fixture: fixture, p_rules: rules, p_awards: awards, p_draw_config: drawConfig, p_members: members })));
    },
    squadStatus: () => fn({ action: 'squadStatus' }),
    seedSquads: () => fn({ action: 'seedSquads' }),
    updateSetup: async (id, drawConfig, rules) => must(await client.rpc('update_setup', { p_sweepstake: id, p_draw_config: drawConfig, p_rules: rules })),
    setMembers: async (id, members) => must(await client.rpc('set_virtual_members', { p_sweepstake: id, p_members: members })),
    startDraft: async (id, order, pool, each) => must(await client.rpc('start_draft', { p_sweepstake: id, p_order: order, p_pool: pool, p_each: each })),
    draftPick: async (id, memberId, playerId) => must(await client.rpc('draft_pick', { p_sweepstake: id, p_member: memberId, p_player: playerId })),
    async preview(code) {
      const r = must(await client.rpc('preview_sweepstake', { p_code: code }))?.[0];
      return r ? { id: r.id, name: r.name, fixture: r.fixture, status: r.status, memberCount: Number(r.member_count) } : null;
    },
    join: async (code, name) => must(await client.rpc('join_sweepstake', { p_code: code, p_display_name: name })),
    async listMine() {
      const rows = must(await client.from('members').select('sweepstake_id, is_host, sweepstakes(id,code,name,creator_id,fixture_id,fixture,rules,awards,draw_config,status,created_at)').order('joined_at', { ascending: false }));
      return rows.filter((r) => r.sweepstakes).map((r) => ({ ...mapSweep(r.sweepstakes), isHost: r.is_host }));
    },
    async load(id) {
      const [s, m, p] = await Promise.all([
        client.from('sweepstakes').select('*').eq('id', id).single(),
        client.from('members').select('*').eq('sweepstake_id', id).order('joined_at'),
        client.from('picks').select('*').eq('sweepstake_id', id),
      ]);
      return { sweep: mapSweep(must(s)), members: must(m).map(mapMember), picks: must(p).map(mapPick) };
    },
    async saveDraw(id, picks) {
      must(await client.rpc('save_draw', { p_sweepstake: id, p_picks: picks.map((p) => ({ member_id: p.memberId, player_id: p.playerId, player_name: p.playerName, number: p.number, photo: p.photo, side: p.side, team_id: p.teamId, role: p.role, slot: p.slot })) }));
    },
    reopen: async (id) => must(await client.rpc('reopen_draw', { p_sweepstake: id })),
    updateRules: async (id, rules, awards) => must(await client.rpc('update_rules', { p_sweepstake: id, p_rules: rules, p_awards: awards })),
    // Friends see joins, the draw and match events within a few seconds (cheap polling of the shared tables).
    subscribe(sweepId, fixtureId, onChange) {
      let stop = false;
      const tick = async () => {
        if (stop || document.hidden) return;
        onChange('sweep');
        try { const r = await client.from('fixture_state').select('state').eq('fixture_id', fixtureId).maybeSingle(); if (r.data?.state) onChange('state', r.data.state); } catch { /* ignore */ }
      };
      const t = setInterval(tick, 6000);
      return () => { stop = true; clearInterval(t); };
    },
  };
  return api;
}

// ---------------------------------------------------------------- Demo
const DEMO_KEY = 'statto_demo_v1';
const DEMO_FIXTURE_ID = 999001;
const SIM_MS_PER_MIN = 2000; // 90 minutes in ~3 minutes

function demoFixture(startedAt) {
  return {
    id: DEMO_FIXTURE_ID,
    kickoff: new Date(startedAt || Date.now() + 3600e3).toISOString(),
    status: { short: 'NS', long: 'Not Started', elapsed: null },
    league: { id: 0, name: 'Demo League', country: 'Anywhere', logo: '', round: 'Matchday 1' },
    teams: {
      home: { id: 1, name: 'Demo Rovers', logo: '' },
      away: { id: 2, name: 'Sample United', logo: '' },
    },
    goals: { home: null, away: null },
  };
}

function demoPlayers() {
  const names = ['Alvarez', 'Brennan', 'Cole', 'Diallo', 'Evans', 'Fraser', 'Gomez', 'Hughes', 'Ito', 'Jansen', 'Kane', 'Lopez', 'Murphy', 'Novak', 'Okafor', 'Petrov', 'Quinn', 'Rossi'];
  const roles = ['GK', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'ATT', 'ATT', 'GK', 'DEF', 'MID', 'MID', 'ATT', 'ATT', 'DEF'];
  const out = [];
  [['home', 0], ['away', 100]].forEach(([side, off]) => names.forEach((n, i) => out.push({
    id: off + i + 1, name: (side === 'home' ? 'H. ' : 'A. ') + n, number: i + 1, photo: '', role: roles[i], bench: i >= 11, side, teamId: side === 'home' ? 1 : 2,
  })));
  return out;
}

const DEMO_EVENTS = [
  { m: 7, team: 1, pid: 3, pname: 'H. Cole', type: 'Card', detail: 'Yellow Card' },
  { m: 18, team: 1, pid: 10, pname: 'H. Jansen', aid: 8, aname: 'H. Hughes', type: 'Goal', detail: 'Normal Goal' },
  { m: 33, team: 2, pid: 106, pname: 'A. Fraser', type: 'Card', detail: 'Yellow Card' },
  { m: 41, team: 2, pid: 111, pname: 'A. Kane', type: 'Goal', detail: 'Penalty' },
  { m: 58, team: 1, pid: 11, pname: 'H. Kane', aid: 7, aname: 'H. Gomez', type: 'Goal', detail: 'Normal Goal' },
  { m: 63, team: 2, pid: 104, pname: 'A. Diallo', type: 'Card', detail: 'Red Card' },
  { m: 70, team: 1, pid: 103, pname: 'A. Cole', type: 'Goal', detail: 'Own Goal' },
  { m: 77, team: 1, pid: 6, aid: 14, pname: 'H. Fraser', aname: 'H. Novak', type: 'subst', detail: 'Substitution 1' },
  { m: 85, team: 1, pid: 10, pname: 'H. Jansen', type: 'Goal', detail: 'Missed Penalty' },
];

function demoState(startedAt) {
  const fx = demoFixture(startedAt);
  const players = demoPlayers();
  const lineups = {};
  for (const side of ['home', 'away']) {
    const ps = players.filter((p) => p.side === side);
    lineups[side] = { formation: '4-4-2', startXI: ps.filter((p) => !p.bench).map((p) => p.id), subs: ps.filter((p) => p.bench).map((p) => p.id) };
  }
  if (!startedAt) return { ...fx, events: [], lineups };
  const min = Math.floor((Date.now() - startedAt) / SIM_MS_PER_MIN);
  const events = DEMO_EVENTS.filter((e) => e.m <= min).map((e) => ({ x: e.m, e: null, team: e.team, pid: e.pid, pname: e.pname, aid: e.aid ?? null, aname: e.aname ?? null, type: e.type, detail: e.detail }));
  const goals = { home: 0, away: 0 };
  events.forEach((e) => {
    if (e.type !== 'Goal' || /missed/i.test(e.detail)) return;
    const own = /own/i.test(e.detail);
    goals[(e.team === 1) !== own ? 'home' : 'away']++;
  });
  const short = min >= 90 ? 'FT' : min >= 46 ? '2H' : '1H';
  return { ...fx, kickoff: new Date(startedAt).toISOString(), status: { short, long: short === 'FT' ? 'Match Finished' : 'In play', elapsed: Math.min(min, 90) }, goals, events, lineups };
}

function createDemoApi() {
  const read = () => { try { return JSON.parse(localStorage.getItem(DEMO_KEY)) || {}; } catch { return {}; } };
  const db = () => { const d = read(); d.sweeps ||= []; d.members ||= []; d.picks ||= []; return d; };
  const write = (d) => { localStorage.setItem(DEMO_KEY, JSON.stringify(d)); window.dispatchEvent(new Event('statto-demo')); };
  const sessionUser = () => { try { return JSON.parse(sessionStorage.getItem('statto_demo_user')); } catch { return null; } };
  const listeners = [];
  const code = () => Math.random().toString(36).slice(2, 8).toUpperCase();

  return {
    mode: 'demo',
    auth: {
      async getUser() { return sessionUser(); },
      async signInGuest(name) { const u = { id: uid(), name, email: null, guest: true }; sessionStorage.setItem('statto_demo_user', JSON.stringify(u)); listeners.forEach((f) => f(u)); return u; },
      async setName(name) { const u = { ...sessionUser(), name }; sessionStorage.setItem('statto_demo_user', JSON.stringify(u)); return u; },
      async signInPassword(email) { const u = { id: 'e-' + email, name: email.split('@')[0], email, guest: false }; sessionStorage.setItem('statto_demo_user', JSON.stringify(u)); listeners.forEach((f) => f(u)); return u; },
      async signUpPassword(name, email) { const u = { id: 'e-' + email, name, email, guest: false }; sessionStorage.setItem('statto_demo_user', JSON.stringify(u)); listeners.forEach((f) => f(u)); return u; },
      async signInGoogle() { throw new Error('Google sign-in needs the live Neon setup (config.js)'); },
      async signOut() { sessionStorage.removeItem('statto_demo_user'); listeners.forEach((f) => f(null)); },
      onChange(cb) { listeners.push(cb); },
    },
    async listFixtures() {
      const { events, lineups, ...row } = demoState(db().matchStart);
      return [row];
    },
    async getPool(fx, force, squadOnly) { return squadOnly ? { source: 'squads', players: demoPlayers().map((p) => ({ ...p, bench: null })) } : { source: 'lineups', players: demoPlayers() }; },
    async getState() { return demoState(db().matchStart); },
    async startDemoMatch() { const d = db(); d.matchStart = Date.now(); write(d); },
    async createSweepstake({ name, displayName, fixture, rules, awards, drawConfig, members = [] }) {
      const u = sessionUser(); const d = db();
      const s = { id: uid(), code: code(), name, creatorId: u.id, fixtureId: fixture.id, fixture, rules, awards, drawConfig, status: 'setup', pool: null };
      d.sweeps.push(s);
      d.members.push({ id: uid(), sweepId: s.id, userId: u.id, name: displayName, isHost: true, kind: 'user' });
      members.filter((m) => (m.name || '').trim()).forEach((m) => d.members.push({ id: uid(), sweepId: s.id, userId: 'v:' + uid(), name: m.name.trim().slice(0, 30), isHost: false, kind: m.kind === 'cpu' ? 'cpu' : 'local' }));
      write(d); return s;
    },
    async squadStatus() { return { leagues: [], complete: true }; },
    async seedSquads() { return { leagues: [], complete: true }; },
    async updateSetup(id, drawConfig, rules) { const d = db(); const s = d.sweeps.find((x) => x.id === id); s.drawConfig = drawConfig; s.rules = rules; write(d); },
    async setMembers(id, members) {
      const d = db(); d.members = d.members.filter((m) => !(m.sweepId === id && m.kind && m.kind !== 'user'));
      members.filter((m) => (m.name || '').trim()).forEach((m) => d.members.push({ id: uid(), sweepId: id, userId: 'v:' + uid(), name: m.name.trim().slice(0, 30), isHost: false, kind: m.kind === 'cpu' ? 'cpu' : 'local' }));
      write(d);
    },
    async startDraft(id, order, pool, each) {
      const d = db(); const s = d.sweeps.find((x) => x.id === id);
      d.picks = d.picks.filter((p) => p.sweepId !== id);
      s.status = 'drafting'; s.pool = pool; s.drawConfig = { ...s.drawConfig, order, each }; write(d);
    },
    async draftPick(id, memberId, playerId) {
      const d = db(); const s = d.sweeps.find((x) => x.id === id);
      if (s.status !== 'drafting') throw new Error('The draft is not running');
      const n = d.picks.filter((p) => p.sweepId === id).length;
      if (draftTurn(s.drawConfig.order, n) !== memberId) throw new Error('It is not their turn');
      const pl = s.pool.find((p) => p.id === playerId);
      if (!pl || d.picks.some((p) => p.sweepId === id && p.playerId === playerId)) throw new Error('Already picked');
      d.picks.push({ id: uid(), sweepId: id, memberId, playerId, playerName: pl.name, number: pl.number ?? null, photo: pl.photo || null, side: pl.side, teamId: pl.teamId ?? null, role: pl.role, slot: pl.bench === true ? 'sub' : 'starter' });
      if (n + 1 >= s.drawConfig.order.length * s.drawConfig.each) s.status = 'drawn';
      write(d);
    },
    async preview(c) { const d = db(); const s = d.sweeps.find((x) => x.code === c.toUpperCase()); return s ? { id: s.id, name: s.name, fixture: s.fixture, status: s.status, memberCount: d.members.filter((m) => m.sweepId === s.id).length } : null; },
    async join(c, name) {
      const u = sessionUser(); const d = db(); const s = d.sweeps.find((x) => x.code === c.toUpperCase());
      if (!s) throw new Error('Invite code not found');
      if (d.members.some((m) => m.sweepId === s.id && m.userId === u.id)) return s.id;
      if (s.status !== 'setup') throw new Error('The draw has already happened - ask the host to reopen it');
      d.members.push({ id: uid(), sweepId: s.id, userId: u.id, name, isHost: false, kind: 'user' });
      write(d); return s.id;
    },
    async listMine() { const u = sessionUser(); const d = db(); return d.members.filter((m) => m.userId === u.id).map((m) => ({ ...d.sweeps.find((s) => s.id === m.sweepId), isHost: m.isHost })).filter((s) => s.id); },
    async load(id) { const d = db(); const sweep = d.sweeps.find((s) => s.id === id); if (!sweep) throw new Error('Sweepstake not found'); return { sweep, members: d.members.filter((m) => m.sweepId === id), picks: d.picks.filter((p) => p.sweepId === id) }; },
    async saveDraw(id, picks) {
      const d = db(); d.picks = d.picks.filter((p) => p.sweepId !== id).concat(picks.map((p) => ({ ...p, id: uid(), sweepId: id })));
      d.sweeps.find((s) => s.id === id).status = 'drawn'; write(d);
    },
    async reopen(id) { const d = db(); d.picks = d.picks.filter((p) => p.sweepId !== id); const s = d.sweeps.find((x) => x.id === id); s.status = 'setup'; s.pool = null; write(d); },
    async updateRules(id, rules, awards) { const d = db(); const s = d.sweeps.find((x) => x.id === id); s.rules = rules; s.awards = awards; write(d); },
    subscribe(sweepId, fixtureId, onChange) {
      const h = () => onChange('sweep');
      window.addEventListener('statto-demo', h); window.addEventListener('storage', h);
      const t = setInterval(() => onChange('state'), 2000);
      return () => { window.removeEventListener('statto-demo', h); window.removeEventListener('storage', h); clearInterval(t); };
    },
  };
}
