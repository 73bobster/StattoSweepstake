import { createApi } from './api.js';
import { runDraw, checkFeasible } from './draw.js';
import { computeScores, DEFAULT_RULES, DEFAULT_AWARDS, isFinished, isLive, hasStarted } from './scoring.js';

const $app = document.getElementById('app');
const S = { api: null, user: null, route: null, busy: false, error: '', toastTimer: null, poll: null, unsub: null };
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => (n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const FEATURED = [39, 40, 179, 180, 2, 3, 848, 140, 135, 78, 61, 88, 94, 1, 4, 5, 9, 45, 48, 143, 181, 253];

// ------------------------------------------------------------------ helpers
function crest(t, lg) {
  const cls = lg ? 'lg' : '';
  return t?.logo ? `<img class="crest ${cls}" src="${esc(t.logo)}" alt="" loading="lazy">` : `<span class="crest-ph ${cls}">${esc(initials(t?.name))}</span>`;
}
const timeStr = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayStr = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; document.body.appendChild(el);
  clearTimeout(S.toastTimer); S.toastTimer = setTimeout(() => el.remove(), 4500);
}
function inviteLink(code) { return `${location.origin}${location.pathname}#/join/${code}`; }
const go = (h) => { if (location.hash === h) route(); else location.hash = h; };
const fmtPts = (n) => (n > 0 ? '+' + n : String(n));

// ------------------------------------------------------------------ router
async function route() {
  S.unsub?.(); S.unsub = null; clearInterval(S.poll); S.poll = null;
  S.error = '';
  const h = location.hash.replace(/^#/, '') || '/';
  const parts = h.split('/').filter(Boolean);
  S.route = parts;
  try {
    if (parts[0] === 'join') return await viewJoin(parts[1]);
    if (!S.user) return viewWelcome();
    const pending = localStorage.getItem('statto_pending_join');
    if (pending) { localStorage.removeItem('statto_pending_join'); return go('#/join/' + pending); }
    if (parts[0] === 'new') return await viewNew();
    if (parts[0] === 's') return await viewSweep(parts[1]);
    return await viewHome();
  } catch (e) {
    console.error(e);
    $app.innerHTML = shell(`<div class="banner err">${esc(e.message || e)}</div><p><button class="ghost" data-act="home">Back home</button></p>`);
  }
}

const THEMES = [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Match my device']];
const ACCENTS = [['Blue', '#2b4cdb', '#d8283c'], ['Red', '#c8102e', '#ffffff'], ['Green', '#1f6f43', '#ffffff'], ['Black & gold', '#16181d', '#f5c518'], ['Sky', '#3b8fe0', '#1b2a49'], ['Claret', '#7b1e3a', '#8fd0ea'], ['Orange', '#e8730c', '#16181d'], ['Navy', '#14274e', '#ffffff']];
function applyLook() {
  const t = localStorage.getItem('statto_theme') || 'light';
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const [, a, b] = ACCENTS.find((x) => x[0] === (localStorage.getItem('statto_accent') || 'Blue')) || ACCENTS[0];
  document.documentElement.style.setProperty('--accent', a); document.documentElement.style.setProperty('--accent2', b);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', a);
}

function navItems() {
  const r = S.route || [];
  if (r[0] === 's' && V.data) {
    const items = [['home', '🏠', 'My games']];
    if (V.data.sweep.status === 'drawn') [['board', '🏆', 'Leaderboard'], ['teams', '👥', 'Teams'], ['feed', '📣', 'Live feed'], ['rules', '⚙️', 'Scoring']].forEach(([k, i, l]) => items.push(['tab', i, l, k, V.tab === k]));
    else items.push(['tab', '🎟️', 'Lobby', 'board', true]);
    return items;
  }
  return [['home', '🏠', 'My games', null, !r.length || r[0] === ''], ['new', '➕', 'New sweepstake', null, r[0] === 'new']];
}

function shell(inner, opts = {}) {
  const u = S.user;
  const nav = u ? navItems() : [];
  return `
    <div class="appbar"><div class="appbar-in">
      <div class="logo" data-act="home">S</div>
      <div class="grow"><div class="eyebrow">Statto Sweepstake</div><div class="ttl">${esc(opts.title || 'My games')}</div>${opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : ''}</div>
      ${u ? `<button class="iconbtn" data-act="settings" aria-label="Settings">⚙︎</button>` : ''}
    </div></div>
    <div class="layout ${u ? 'has-nav' : ''}">
      ${u ? `<nav class="nav">${nav.map(([act, ic, label, k, on]) => `<button class="navitem ${on ? 'on' : ''}" data-act="${act}" ${k ? `data-k="${k}"` : ''}><span class="ic">${ic}</span><span>${esc(label)}</span></button>`).join('')}</nav>` : ''}
      <main class="main">
        ${S.api.mode === 'demo' ? `<div class="banner info" style="margin-bottom:12px">Demo mode: runs in this browser only, with a simulated match. Set <b>neonUrl</b> in <b>config.js</b> for real fixtures and friends on other devices.</div>` : ''}
        ${inner}
      </main>
    </div>`;
}

function settingsModal() {
  const u = S.user; const t = localStorage.getItem('statto_theme') || 'light'; const ac = localStorage.getItem('statto_accent') || 'Blue';
  return `<div class="modal-back" data-act="closesettings"><div class="modal">
    <div class="row between"><h2 style="text-transform:none;font-size:22px">Settings</h2><button class="soft sm" data-act="closesettings">✕</button></div>
    <div class="sec">Appearance</div>
    <div class="small muted">Theme</div><div class="chips" style="flex-wrap:wrap">${THEMES.map(([k, l]) => `<div class="chip ${t === k ? 'on' : ''}" data-act="theme" data-k="${k}">${l}</div>`).join('')}</div>
    <div class="small muted" style="margin-top:10px">App colour</div><div class="chips" style="flex-wrap:wrap">${ACCENTS.map(([n, a, b]) => `<div class="swatch ${ac === n ? 'on' : ''}" title="${n}" data-act="accent" data-k="${n}" style="background:linear-gradient(135deg,${a} 50%,${b} 50%)"></div>`).join('')}</div>
    <div class="sec">Account</div>
    <div class="card flat"><div class="kv"><span>Signed in as</span><b>${esc(u.name || '—')}</b></div><div class="kv"><span>Email</span><b>${u.guest ? 'Guest (no email)' : esc(u.email || '')}</b></div></div>
    ${u.guest ? `<p class="small muted">You're playing as a guest on this device. Create an account from the sign-in page to keep your games on every device.</p>` : ''}
    <button class="logoff block" data-act="logoff" style="margin-top:12px">Log off</button>
  </div></div>`;
}

// ------------------------------------------------------------------ welcome / auth
const AUTH = { mode: 'signin' };
function viewWelcome(joinCode) {
  const joining = joinCode || (S.route?.[0] === 'join' ? S.route[1] : null);
  const up = AUTH.mode === 'signup';
  $app.innerHTML = shell(`
    <div class="authwrap">
      ${joining ? `<div class="banner info">You've been invited to a sweepstake (code <b>${esc(String(joining).toUpperCase())}</b>). Pick how you want to play.</div>` : `<div class="hero"><h1>Statto<br>Sweepstake</h1><p>Pick a match. We deal everyone a random, evenly-balanced set of players. Goals score, cards cost.</p></div>`}
      <div class="card stack">
        <div class="sec" style="margin-top:0">No account needed</div>
        <div><label class="lbl">Your name</label><input type="text" id="gname" maxlength="30" placeholder="e.g. Robbo" autocomplete="nickname"></div>
        <button class="block" data-act="guest">Play as a guest</button>
      </div>
      <div class="card stack" style="margin-top:12px">
        <div class="tabs">${[['signin', 'Log in'], ['signup', 'Create account']].map(([k, l]) => `<button class="${AUTH.mode === k ? 'on' : ''}" data-act="authmode" data-k="${k}">${l}</button>`).join('')}</div>
        ${up ? `<div><label class="lbl">Name</label><input type="text" id="aname" maxlength="30" autocomplete="name"></div>` : ''}
        <div><label class="lbl">Email</label><input type="email" id="aemail" autocomplete="email"></div>
        <div><label class="lbl">Password</label><input type="password" id="apass" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="8"></div>
        <button class="block" data-act="${up ? 'signup' : 'signin'}">${up ? 'Create account' : 'Log in'}</button>
        <div class="or">or</div>
        <button class="soft block" data-act="google">Continue with Google</button>
        <div id="authmsg" class="small muted center"></div>
      </div>
    </div>`, { title: 'Welcome' });
}

async function doGuest() {
  const name = document.getElementById('gname').value.trim();
  if (!name) return flashAuth('Pop your name in first.', true);
  try { flashAuth('Setting you up…'); S.user = await S.api.auth.signInGuest(name); route(); } catch (e) { flashAuth(e.message, true); }
}
async function doPassword(up) {
  const email = document.getElementById('aemail').value.trim(), pw = document.getElementById('apass').value, name = document.getElementById('aname')?.value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return flashAuth('Enter a valid email address.', true);
  if (pw.length < 8) return flashAuth('Password needs at least 8 characters.', true);
  if (up && !name) return flashAuth('Add your name.', true);
  try { flashAuth('One moment…'); S.user = up ? await S.api.auth.signUpPassword(name, email, pw) : await S.api.auth.signInPassword(email, pw); route(); } catch (e) { flashAuth(e.message, true); }
}
function flashAuth(msg, err) { const el = document.getElementById('authmsg'); if (el) { el.textContent = msg; el.style.color = err ? 'var(--red)' : 'var(--muted)'; } }

// ------------------------------------------------------------------ home
async function viewHome() {
  $app.innerHTML = shell('<div class="spinner"></div>', { title: 'My games' });
  const mine = await S.api.listMine();
  $app.innerHTML = shell(`
    <div class="row"><button class="grow" data-act="new">＋ New sweepstake</button></div>
    <div class="card stack" style="margin-top:12px">
      <label class="lbl" style="margin:0">Got an invite code?</label>
      <div class="row"><input type="text" id="joincode" placeholder="ABC123" maxlength="6" style="text-transform:uppercase;letter-spacing:.2em"><button class="soft" data-act="joincode">Join</button></div>
    </div>
    <div class="sec">${mine.length ? 'Your sweepstakes' : ''}</div>
    <div class="stack">${mine.map((s) => `
      <div class="card" data-act="open" data-id="${s.id}" style="cursor:pointer">
        <div class="row between"><b>${esc(s.name)}</b><span class="pill">${s.status === 'setup' ? 'Lobby' : 'Drawn'}</span></div>
        <div class="row muted small" style="margin-top:6px">${crest(s.fixture.teams.home)} ${esc(s.fixture.teams.home.name)} v ${crest(s.fixture.teams.away)} ${esc(s.fixture.teams.away.name)}</div>
        <div class="small muted" style="margin-top:4px">${dayStr(s.fixture.kickoff)} · ${timeStr(s.fixture.kickoff)}${s.isHost ? ' · you are the host' : ''}</div>
      </div>`).join('') || '<p class="muted center">Nothing yet. Start one and invite your mates.</p>'}</div>`, { title: 'My games', sub: 'Your sweepstakes' });
}

// ------------------------------------------------------------------ join
async function viewJoin(code) {
  code = (code || '').toUpperCase();
  if (!S.user) return viewWelcome(code);
  const prev = await S.api.preview(code).catch(() => null);
  if (!prev) { $app.innerHTML = shell(`<div class="banner err">Couldn't find that invite code. Check it with the host.</div><p><button class="ghost" data-act="home">Back</button></p>`, { title: 'Join' }); return; }
  const pre = (S.user.name || '').trim();
  if (pre) return doJoin(code, pre);
  $app.innerHTML = shell(`
    <div class="card stack"><div><b>${esc(prev.name)}</b><div class="small muted">${esc(prev.fixture.teams.home.name)} v ${esc(prev.fixture.teams.away.name)}</div></div><label class="lbl">Your name for this game</label><input type="text" id="jname" maxlength="30" placeholder="e.g. Robbo">
    <button class="block" data-act="dojoin" data-code="${code}">Join the sweepstake</button></div>`, { title: "You're invited" });
}
async function doJoin(code, name) {
  try {
    const id = await S.api.join(code, name);
    go('#/s/' + id);
  } catch (e) {
    $app.innerHTML = shell(`<div class="banner err">${esc(e.message)}</div><p><button class="ghost" data-act="home">Back</button></p>`, { title: 'Join' });
  }
}

// ------------------------------------------------------------------ new sweepstake
const N = { date: ymd(new Date()), fixtures: null, q: '', all: false, sel: null, name: '', starters: 3, subs: 1, gk: false, rules: clone(DEFAULT_RULES), awards: clone(DEFAULT_AWARDS), dname: '' };

async function viewNew() {
  N.dname ||= S.user.name || '';
  renderNew();
  await loadFixtures();
}
async function loadFixtures() {
  N.fixtures = null; renderNew();
  try { N.fixtures = await S.api.listFixtures(N.date); N.err = ''; } catch (e) { N.fixtures = []; N.err = e.message; }
  renderNew();
}
function renderNew() {
  if (S.route?.[0] !== 'new') return;
  const days = Array.from({ length: 8 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; });
  let list = (N.fixtures || []).slice().sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const q = N.q.trim().toLowerCase();
  const featuredCount = list.filter((f) => FEATURED.includes(f.league.id)).length;
  if (q) list = list.filter((f) => `${f.teams.home.name} ${f.teams.away.name} ${f.league.name} ${f.league.country}`.toLowerCase().includes(q));
  else if (!N.all && featuredCount) list = list.filter((f) => FEATURED.includes(f.league.id));
  const total = list.length; list = list.slice(0, 120);
  const groups = {};
  list.forEach((f) => (groups[f.league.id] ||= { l: f.league, items: [] }).items.push(f));
  const gs = Object.values(groups).sort((a, b) => (FEATURED.indexOf(a.l.id) + 1 || 999) - (FEATURED.indexOf(b.l.id) + 1 || 999) || a.l.name.localeCompare(b.l.name));
  const sel = N.sel;
  const cfg = { starters: N.starters, subs: N.subs, includeGK: N.gk };

  $app.innerHTML = shell(`
    <div class="sec" style="margin-top:0">1 · Pick a match</div>
    <div class="chips">${days.map((d) => `<div class="chip ${ymd(d) === N.date ? 'on' : ''}" data-act="date" data-d="${ymd(d)}">${d.toLocaleDateString([], { weekday: 'short' })}<small>${d.getDate()} ${d.toLocaleDateString([], { month: 'short' })}</small></div>`).join('')}</div>
    <input type="search" id="fxq" placeholder="Search team or league" value="${esc(N.q)}" style="margin:10px 0">
    ${N.err ? `<div class="banner err">${esc(N.err)}</div>` : ''}
    ${N.fixtures === null ? '<div class="spinner"></div>' : `
      ${gs.map((g) => `<div class="league">${g.l.logo ? `<img class="crest" style="width:18px;height:18px" src="${esc(g.l.logo)}" alt="">` : ''}${esc(g.l.name)}<span class="muted small" style="text-transform:none">${esc(g.l.country || '')}</span></div>
        <div class="gap-s">${g.items.map((f) => `<button class="fx ${sel?.id === f.id ? 'on' : ''}" data-act="pickfx" data-id="${f.id}"><span class="t">${timeStr(f.kickoff)}</span><span class="tm"><div>${crest(f.teams.home)} ${esc(f.teams.home.name)}</div><div>${crest(f.teams.away)} ${esc(f.teams.away.name)}</div></span>${f.status.short !== 'NS' ? `<span class="pill">${esc(f.status.short)}</span>` : ''}</button>`).join('')}</div>`).join('')}
      ${!total ? `<p class="muted center">No matches found for this day${q ? ' and search' : ''}.</p>` : ''}
      ${!q && !N.all && featuredCount && (N.fixtures.length > featuredCount) ? `<p class="center"><button class="ghost sm" data-act="showall">Show all ${N.fixtures.length} matches worldwide</button></p>` : ''}
      ${total > 120 ? `<p class="muted small center">Showing the first 120 of ${total} - search to narrow it down.</p>` : ''}`}
    ${sel ? `
    <div class="sec">2 · Set it up</div>
    <div class="card stack">
      <div><label class="lbl">Sweepstake name</label><input type="text" id="sname" maxlength="40" placeholder="${esc(sel.teams.home.name)} v ${esc(sel.teams.away.name)}" value="${esc(N.name)}"></div>
      <div><label class="lbl">Your name</label><input type="text" id="dname" maxlength="30" value="${esc(N.dname)}"></div>
      <div class="row between"><div><b>Starters each</b><div class="small muted">Spread across defence, midfield & attack</div></div>${stepper('starters', N.starters)}</div>
      <div class="row between"><div><b>Subs each</b><div class="small muted">Random bench player</div></div>${stepper('subs', N.subs)}</div>
      <div class="row between"><div><b>Include goalkeepers</b><div class="small muted">Adds a keeper to the role rotation</div></div><input type="checkbox" class="toggle" data-act="gk" ${N.gk ? 'checked' : ''}></div>
    </div>
    <div class="sec">3 · Scoring</div>
    ${rulesEditor(N.rules, N.awards, 'n')}
    <div class="sticky-cta"><button class="block" data-act="create" ${S.busy ? 'disabled' : ''}>Create & get invite link</button></div>` : ''}
  `, { title: 'New sweepstake', sub: 'Pick a match, set the rules' });
  const q2 = document.getElementById('fxq'); if (q2 && S.focusQ) { q2.focus(); q2.setSelectionRange(q2.value.length, q2.value.length); }
}
const stepper = (k, v) => `<div class="stepper"><button class="soft sm" data-act="step" data-k="${k}" data-d="-1">−</button><span class="v">${v}</span><button class="soft sm" data-act="step" data-k="${k}" data-d="1">＋</button></div>`;

function rulesEditor(rules, awards, scope) {
  return `
    <div class="card">
      <div class="small muted" style="margin-bottom:6px">Points for events involving a player you're dealt</div>
      ${Object.entries(rules).map(([k, r]) => `<div class="row between" style="padding:7px 0;border-top:1px solid var(--line)">
        <div class="row grow"><input type="checkbox" class="toggle" data-act="ruleon" data-s="${scope}" data-k="${k}" ${r.on ? 'checked' : ''}><span class="${r.on ? '' : 'muted'}">${esc(r.label)}</span></div>
        <div class="stepper" style="${r.on ? '' : 'opacity:.35;pointer-events:none'}"><button class="soft sm" data-act="rulestep" data-s="${scope}" data-k="${k}" data-d="-1">−</button><span class="v ${r.points > 0 ? 'p-pos' : r.points < 0 ? 'p-neg' : ''}">${fmtPts(r.points)}</span><button class="soft sm" data-act="rulestep" data-s="${scope}" data-k="${k}" data-d="1">＋</button></div></div>`).join('')}
    </div>
    <div class="card" style="margin-top:10px">
      <div class="small muted" style="margin-bottom:6px">Side prizes - who takes the pot for each?</div>
      ${Object.entries(awards).map(([k, a]) => `<div class="row" style="padding:7px 0;border-top:1px solid var(--line)"><input type="checkbox" class="toggle" data-act="awardon" data-s="${scope}" data-k="${k}" ${a.on ? 'checked' : ''}><span class="${a.on ? '' : 'muted'}">${esc(a.label)}</span></div>`).join('')}
    </div>`;
}

async function createSweep() {
  const sel = N.sel; if (!sel) return;
  const name = (document.getElementById('sname')?.value || '').trim() || `${sel.teams.home.name} v ${sel.teams.away.name}`;
  const dname = (document.getElementById('dname')?.value || '').trim();
  if (!dname) return toast('Add your name first');
  S.busy = true; renderNew();
  try {
    if (dname !== S.user.name) S.user = await S.api.auth.setName(dname);
    const s = await S.api.createSweepstake({ name, displayName: dname, fixture: sel, rules: N.rules, awards: N.awards, drawConfig: { starters: N.starters, subs: N.subs, includeGK: N.gk } });
    N.sel = null; N.name = '';
    S.busy = false; go('#/s/' + s.id);
  } catch (e) { S.busy = false; toast(e.message); renderNew(); }
}

// ------------------------------------------------------------------ sweepstake screen
const V = { tab: 'board', open: new Set(), edit: null, pool: null, seen: null };

async function viewSweep(id) {
  $app.innerHTML = shell('<div class="spinner"></div>', { title: 'Sweepstake' });
  V.id = id; V.edit = null; V.pool = null; V.seen = null;
  await refreshSweep();
  V.state = await S.api.getState(V.data.sweep.fixtureId).catch(() => null);
  V.seen = V.state?.events?.length ?? 0;
  renderSweep();
  S.unsub = S.api.subscribe(id, V.data.sweep.fixtureId, async (kind, payload) => {
    if (kind === 'state') { if (payload) applyState(payload); else await pollState(); }
    else { const before = JSON.stringify(V.data); await refreshSweep().catch(() => {}); if (JSON.stringify(V.data) !== before) renderSweepSafe(); }
  });
  const tick = async () => { if (document.hidden) return; if (!V.state || !isFinished(V.state)) await pollState(); };
  S.poll = setInterval(tick, S.api.mode === 'demo' ? 3000 : 60000);
  tick();
}
async function refreshSweep() { V.data = await S.api.load(V.id); }
async function pollState(force) {
  try { applyState(await S.api.getState(V.data.sweep.fixtureId, force)); } catch (e) { V.stateErr = e.message; if (force) toast(e.message); }
}
function applyState(st) {
  const prevCount = V.seen ?? 0;
  const changed = JSON.stringify(st) !== JSON.stringify(V.state);
  V.state = st; V.stateErr = '';
  if (!changed) return;
  const evs = st.events || [];
  if (evs.length > prevCount && V.data?.sweep.status === 'drawn') announce(evs.slice(prevCount));
  V.seen = evs.length;
  renderSweepSafe();
}
function renderSweepSafe() { if (S.route?.[0] === 's') { const a = document.activeElement; if (!(a && a.tagName === 'INPUT' && $app.contains(a))) renderSweep(); } }
function announce(newEvents) {
  const { sweep, members, picks } = V.data;
  const after = computeScores({ rules: sweep.rules, awards: sweep.awards, members, picks, state: V.state });
  for (const ev of newEvents) {
    const k = after.feed.find((f) => f.x === ev.x && f.pid === ev.pid && f.type === ev.type && f.detail === ev.detail);
    if (!k) continue;
    const owner = members.find((m) => m.id === k.ownerMemberId);
    const icon = { goal: '⚽', penalty: '⚽', ownGoal: '😬', penMissed: '❌', yellow: '🟨', red: '🟥' }[k.kind];
    const pts = owner ? ` → ${owner.name} ${fmtPts(sweep.rules[k.kind]?.on ? sweep.rules[k.kind].points : 0)}` : '';
    toast(`${icon} ${k.minute} ${k.pname}${pts}`);
    break;
  }
}

function matchHeader(fx, st) {
  const live = isLive(st), fin = isFinished(st), started = hasStarted(st);
  const sc = st?.goals && st.goals.home != null ? `<div class="score">${st.goals.home} - ${st.goals.away}</div>` : `<div class="score muted">v</div>`;
  const status = fin ? '<span class="pill">Full time</span>' : live ? `<span class="pill live">${st.status.short === 'HT' ? 'Half time' : (st.status.elapsed ?? '') + "'"}</span>` : st && started ? `<span class="pill">${esc(st.status.long)}</span>` : `<span class="pill">${dayStr(fx.kickoff)} · ${timeStr(st?.kickoff || fx.kickoff)}</span>`;
  return `<div class="card match">
    <div class="small muted" style="margin-bottom:8px">${esc(fx.league?.name || '')}</div>
    <div class="teams"><div>${crest(fx.teams.home, true)}<div class="tn">${esc(fx.teams.home.name)}</div></div><div>${sc}<div style="margin-top:8px">${status}</div></div><div>${crest(fx.teams.away, true)}<div class="tn">${esc(fx.teams.away.name)}</div></div></div></div>`;
}

function renderSweep() {
  if (S.route?.[0] !== 's' || !V.data) return;
  const { sweep, members, picks } = V.data;
  const me = members.find((m) => m.userId === S.user.id);
  const isHost = sweep.creatorId ? sweep.creatorId === S.user.id : !!me?.isHost;
  const st = V.state; const fx = sweep.fixture;
  let body = '';
  if (sweep.status === 'setup') body = lobby(sweep, members, isHost, st);
  else {
    const res = computeScores({ rules: sweep.rules, awards: sweep.awards, members, picks, state: st });
    V.res = res;
    body = '<div style="height:12px"></div>'
      + (V.tab === 'board' ? board(res, sweep) : V.tab === 'teams' ? teams(res, members, picks, sweep) : V.tab === 'feed' ? feed(res, members, sweep, st) : rulesTab(sweep, isHost, st));
  }
  const demoKick = S.api.mode === 'demo' && !hasStarted(st) ? `<button class="soft block" data-act="demokick" style="margin-top:10px">▶ Kick off demo match (plays out in ~3 min)</button>` : '';
  $app.innerHTML = shell(`
    ${matchHeader(fx, st)}${demoKick}
    ${V.stateErr ? `<div class="banner err" style="margin-top:10px">${esc(V.stateErr)}</div>` : ''}
    ${body}`, { title: sweep.name, sub: `Invite code ${sweep.code}` });
}

function lobby(sweep, members, isHost, st) {
  const link = inviteLink(sweep.code);
  const dc = sweep.drawConfig;
  const feas = V.pool ? checkFeasible(V.pool, members.length, dc) : { ok: true };
  return `
    <div class="card stack" style="margin-top:12px">
      <div class="center small muted">Invite your friends with this code</div>
      <div class="code">${esc(sweep.code)}</div>
      <div class="row"><button class="grow" data-act="share">Share invite link</button><button class="soft" data-act="copy" data-t="${esc(link)}">Copy</button></div>
      <div class="small muted center" style="word-break:break-all">${esc(link)}</div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="row between"><b>In the game (${members.length})</b><span class="small muted">updates live</span></div>
      ${members.map((m) => `<div class="member"><span class="avatar">${esc(initials(m.name))}</span><span class="grow">${esc(m.name)}</span>${m.isHost ? '<span class="badge">HOST</span>' : ''}</div>`).join('')}
    </div>
    <div class="card" style="margin-top:12px"><div class="small muted">Each friend gets <b style="color:var(--text)">${dc.starters} starter${dc.starters === 1 ? '' : 's'}</b> (spread across defence, midfield and attack${dc.includeGK ? ', plus a keeper in the rotation' : ''}) and <b style="color:var(--text)">${dc.subs} sub${dc.subs === 1 ? '' : 's'}</b>, split as evenly as possible between both teams.</div></div>
    ${V.pool ? `<div class="banner ${V.pool.source === 'lineups' ? 'info' : ''}" style="margin-top:12px">${V.pool.source === 'lineups' ? '✅ Using the confirmed line-ups.' : '⚠️ Line-ups aren\'t out yet, so the draw uses the full squads - some players may not make the matchday squad. Line-ups usually land about an hour before kick-off; you can redraw then.'}</div>` : ''}
    ${!feas.ok ? `<div class="banner err" style="margin-top:12px">${esc(feas.message)}</div>` : ''}
    ${isHost ? `<div class="sticky-cta stack"><button class="block" data-act="draw" ${members.length < 2 || S.busy ? 'disabled' : ''}>🎲 ${members.length < 2 ? 'Waiting for friends…' : S.busy ? 'Drawing…' : 'Draw the players'}</button><div class="small muted center">Everyone who has joined is in. New joiners are blocked after the draw.</div></div>`
    : `<p class="muted center" style="margin-top:16px">Waiting for the host to run the draw…</p>`}`;
}

async function doDraw() {
  const { sweep, members } = V.data;
  S.busy = true; renderSweep();
  try {
    const poolRes = await S.api.getPool(sweep.fixture, true);
    V.pool = poolRes;
    const pool = { players: poolRes.players };
    const { picks } = runDraw({ pool, memberIds: members.map((m) => m.id), config: sweep.drawConfig });
    const byId = new Map(poolRes.players.map((p) => [p.id, p]));
    const rows = picks.map((p) => { const pl = byId.get(p.playerId); return { memberId: p.memberId, playerId: p.playerId, playerName: pl.name, number: pl.number ?? null, photo: pl.photo || null, side: pl.side, teamId: pl.teamId ?? null, role: pl.role, slot: p.slot }; });
    await S.api.saveDraw(sweep.id, rows);
    await refreshSweep(); V.tab = 'teams';
    toast('🎲 Players dealt!');
  } catch (e) { toast(e.message); }
  S.busy = false; renderSweep();
}

function board(res, sweep) {
  const fin = isFinished(V.state);
  return `
    <div class="stack">${res.rows.map((r) => `
      <div class="card" data-act="toggle" data-id="${r.memberId}" style="cursor:pointer">
        <div class="rank ${r.rank === 1 && r.points > 0 ? 'first' : ''}"><div class="pos">${r.rank}</div>
          <div><b>${esc(r.name)}</b><div class="small muted">${r.goals} goal${r.goals === 1 ? '' : 's'} · ${r.bookings} booking${r.bookings === 1 ? '' : 's'}</div></div>
          <div class="pts ${r.points > 0 ? 'pos' : r.points < 0 ? 'neg' : ''}">${r.points}</div></div>
        ${V.open.has(r.memberId) ? `<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px">${r.lines.length ? r.lines.map((l) => `<div class="line"><span>${esc(l.minute)} · <b>${esc(l.playerName)}</b> · ${esc(l.label)}</span><span class="${l.points >= 0 ? 'p-pos' : 'p-neg'}">${fmtPts(l.points)}</span></div>`).join('') : '<div class="small muted">Nothing yet.</div>'}</div>` : ''}
      </div>`).join('')}</div>
    <h3 style="margin:22px 2px 8px">Side prizes ${fin ? '' : '<span class="small" style="text-transform:none">· live, not final</span>'}</h3>
    <div class="card">${Object.entries(res.awards).map(([k, a]) => `<div class="award"><div><b>${esc(sweep.awards[k].label)}</b><div class="small muted">${esc(a.detail || '')}${a.unowned ? ' · player not in anyone’s hand' : ''}</div></div><div class="w ${a.winner?.length ? (a.final ? 'gold' : '') : 'muted'}">${a.winner?.length ? esc(a.winner.join(' & ')) : '—'}</div></div>`).join('') || '<p class="muted small">No side prizes switched on.</p>'}</div>`;
}

function teams(res, members, picks, sweep) {
  const pts = new Map();
  res.rows.forEach((r) => r.lines.forEach((l) => pts.set(l.playerId, (pts.get(l.playerId) || 0) + l.points)));
  const fx = sweep.fixture;
  return `<div class="stack">${members.map((m) => {
    const mine = picks.filter((p) => p.memberId === m.id).sort((a, b) => (a.slot === 'sub') - (b.slot === 'sub'));
    const total = res.rows.find((r) => r.memberId === m.id)?.points ?? 0;
    return `<div class="card"><div class="row between"><div class="row"><span class="avatar">${esc(initials(m.name))}</span><b>${esc(m.name)}</b></div><b class="pts ${total > 0 ? 'pos' : total < 0 ? 'neg' : ''}" style="font-size:26px">${total}</b></div>
      <div style="margin-top:8px">${mine.map((p) => {
        const pp = pts.get(p.playerId) || 0; const team = fx.teams[p.side];
        return `<div class="player">${p.photo ? `<img class="photo" src="${esc(p.photo)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'shirt',textContent:'${esc(p.number ?? '')}'}))">` : `<div class="shirt">${esc(p.number ?? '')}</div>`}
          <div class="grow"><b>${esc(p.playerName)}</b><div class="small muted">${esc(team.name)}</div></div>
          <span class="badge ${p.role}">${p.role}</span>${p.slot === 'sub' ? '<span class="badge sub">SUB</span>' : ''}
          <b class="${pp > 0 ? 'p-pos' : pp < 0 ? 'p-neg' : 'muted'}" style="min-width:28px;text-align:right">${pp ? fmtPts(pp) : '0'}</b></div>`;
      }).join('')}</div></div>`;
  }).join('')}</div>`;
}

function feed(res, members, sweep, st) {
  const items = res.feed.slice().reverse();
  const icon = { goal: '⚽', penalty: '⚽', ownGoal: '😬', penMissed: '❌', yellow: '🟨', red: '🟥' };
  const lbl = { goal: 'Goal', penalty: 'Penalty', ownGoal: 'Own goal', penMissed: 'Penalty missed', yellow: 'Yellow card', red: 'Red card' };
  const when = V.stateErr ? '' : st ? `<p class="small muted center">Shared live feed · refreshes about every 2 minutes (free API plan)</p>` : '';
  return when + `<div class="card">${items.map((e) => {
    const o = members.find((m) => m.id === e.ownerMemberId); const pts = sweep.rules[e.kind];
    return `<div class="ev"><div class="min">${esc(e.minute)}</div><div>${icon[e.kind]}</div><div><b>${esc(e.pname || '')}</b> <span class="muted">${lbl[e.kind]}</span>
      <div class="small ${o ? '' : 'muted'}">${o ? `${esc(o.name)}’s player <span class="${pts?.points >= 0 ? 'p-pos' : 'p-neg'}">${fmtPts(pts?.on ? pts.points : 0)}</span>` : 'Nobody’s player'}${e.aname && e.kind === 'goal' ? ` · assist ${esc(e.aname)}` : ''}</div></div></div>`;
  }).join('') || '<p class="muted center">No goals or cards yet. Events appear here as they happen.</p>'}</div>
  <div class="center" style="margin-top:12px"><button class="ghost sm" data-act="refresh">↻ Refresh now</button></div>`;
}

function rulesTab(sweep, isHost, st) {
  const editing = !!V.edit;
  const rules = V.edit?.rules || sweep.rules, awards = V.edit?.awards || sweep.awards;
  const locked = hasStarted(st);
  return `${editing ? rulesEditor(rules, awards, 'e') : `<div class="card">${Object.values(rules).map((r) => `<div class="award"><span class="${r.on ? '' : 'muted'}">${esc(r.label)}</span><span class="w ${r.on ? (r.points >= 0 ? 'p-pos' : 'p-neg') : 'muted'}">${r.on ? fmtPts(r.points) : 'off'}</span></div>`).join('')}</div>
    <div class="card" style="margin-top:10px">${Object.values(awards).map((a) => `<div class="award"><span class="${a.on ? '' : 'muted'}">${esc(a.label)}</span><span class="w muted">${a.on ? 'on' : 'off'}</span></div>`).join('')}</div>`}
    ${isHost ? `<div class="stack" style="margin-top:14px">
      ${editing ? `<button class="block" data-act="saverules">Save scoring</button><button class="ghost block" data-act="cancelrules">Cancel</button>` : `<button class="soft block" data-act="editrules">Edit scoring</button>`}
      ${!locked && !editing ? `<button class="danger block" data-act="reopen">Reopen the draw (redraw players)</button>` : ''}</div>` : '<p class="small muted center" style="margin-top:12px">Only the host can change the scoring.</p>'}`;
}

// ------------------------------------------------------------------ events (delegation)
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act;
  if (el.type === 'checkbox') return; // handled on change
  const d = el.dataset;
  switch (act) {
    case 'home': return go('#/');
    case 'settings': closeModal(); return document.body.insertAdjacentHTML('beforeend', settingsModal());
    case 'closesettings': if (el.classList.contains('modal-back') && ev.target !== el) return; return closeModal();
    case 'theme': localStorage.setItem('statto_theme', d.k); applyLook(); closeModal(); return document.body.insertAdjacentHTML('beforeend', settingsModal());
    case 'accent': localStorage.setItem('statto_accent', d.k); applyLook(); closeModal(); return document.body.insertAdjacentHTML('beforeend', settingsModal());
    case 'logoff': closeModal(); await S.api.auth.signOut(); S.user = null; return go('#/');
    case 'authmode': AUTH.mode = d.k; return viewWelcome();
    case 'signin': return doPassword(false);
    case 'signup': return doPassword(true);
    case 'google': try { await S.api.auth.signInGoogle(); } catch (e) { flashAuth(e.message, true); } return;
    case 'guest': return doGuest();
    case 'new': return go('#/new');
    case 'open': return go('#/s/' + d.id);
    case 'joincode': { const c = document.getElementById('joincode').value.trim().toUpperCase(); if (c) go('#/join/' + c); return; }
    case 'dojoin': { const n = document.getElementById('jname').value.trim(); if (!n) return toast('Add your name'); S.user = await S.api.auth.setName(n).catch(() => S.user); return doJoin(d.code, n); }
    // new
    case 'date': N.date = d.d; N.sel = null; return loadFixtures();
    case 'showall': N.all = true; return renderNew();
    case 'pickfx': N.sel = N.fixtures.find((f) => String(f.id) === d.id); N.name = ''; renderNew(); return setTimeout(() => document.getElementById('sname')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    case 'step': { const k = d.k, dlt = Number(d.d); const lim = { starters: [1, 8], subs: [0, 3] }[k]; N[k] = Math.max(lim[0], Math.min(lim[1], N[k] + dlt)); captureNew(); return renderNew(); }
    case 'create': return createSweep();
    case 'rulestep': { const t = d.s === 'n' ? N.rules : V.edit.rules; t[d.k].points = Math.max(-10, Math.min(10, t[d.k].points + Number(d.d))); captureNew(); return d.s === 'n' ? renderNew() : renderSweep(); }
    // sweep
    case 'tab': V.tab = d.k; return renderSweep();
    case 'toggle': V.open.has(d.id) ? V.open.delete(d.id) : V.open.add(d.id); return renderSweep();
    case 'share': { const link = inviteLink(V.data.sweep.code); const text = `Join my Statto Sweepstake for ${V.data.sweep.fixture.teams.home.name} v ${V.data.sweep.fixture.teams.away.name}! Code ${V.data.sweep.code}`; if (navigator.share) { try { await navigator.share({ title: 'Statto Sweepstake', text, url: link }); return; } catch { /* cancelled */ } } await navigator.clipboard?.writeText(`${text} ${link}`); return toast('Invite copied'); }
    case 'copy': await navigator.clipboard?.writeText(d.t); return toast('Link copied');
    case 'draw': return doDraw();
    case 'refresh': await pollState(true); return renderSweep();
    case 'demokick': await S.api.startDemoMatch(); await pollState(); return;
    case 'editrules': V.edit = { rules: clone(V.data.sweep.rules), awards: clone(V.data.sweep.awards) }; return renderSweep();
    case 'cancelrules': V.edit = null; return renderSweep();
    case 'saverules': await S.api.updateRules(V.id, V.edit.rules, V.edit.awards); V.edit = null; await refreshSweep(); toast('Scoring updated'); return renderSweep();
    case 'reopen': if (confirm('Reopen the draw? Everyone’s players will be cleared and you can redraw.')) { await S.api.reopen(V.id); await refreshSweep(); renderSweep(); } return;
  }
});
document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-act]'); if (!el) return; const d = el.dataset;
  if (d.act === 'gk') { N.gk = el.checked; captureNew(); renderNew(); }
  if (d.act === 'ruleon') { const t = d.s === 'n' ? N.rules : V.edit.rules; t[d.k].on = el.checked; d.s === 'n' ? renderNew() : renderSweep(); }
  if (d.act === 'awardon') { const t = d.s === 'n' ? N.awards : V.edit.awards; t[d.k].on = el.checked; d.s === 'n' ? renderNew() : renderSweep(); }
});
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'fxq') { N.q = ev.target.value; S.focusQ = true; clearTimeout(S.qt); S.qt = setTimeout(renderNew, 150); }
  if (ev.target.id === 'joincode') ev.target.value = ev.target.value.toUpperCase();
});
function captureNew() { const s = document.getElementById('sname'), d = document.getElementById('dname'); if (s) N.name = s.value; if (d) N.dname = d.value; }
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'gname') doGuest(); if (ev.key === 'Enter' && (ev.target.id === 'aemail' || ev.target.id === 'apass')) doPassword(AUTH.mode === 'signup'); if (ev.key === 'Enter' && ev.target.id === 'joincode') document.querySelector('[data-act=joincode]')?.click(); });
document.addEventListener('focusin', (ev) => { S.focusQ = ev.target.id === 'fxq'; });

function closeModal() { document.querySelector('.modal-back')?.remove(); }

// ------------------------------------------------------------------ boot
(async function boot() {
  applyLook(); matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyLook);
  S.api = await createApi(window.STATTO_CONFIG || {});
  S.user = await S.api.auth.getUser();
  S.api.auth.onChange((u) => { const had = !!S.user; S.user = u; if (!!u !== had) route(); });
  window.addEventListener('hashchange', route);
  route();
})();
