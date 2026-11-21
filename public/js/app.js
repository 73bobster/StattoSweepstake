import { createApi } from './api.js';
import { runDraw, checkFeasible, dealAll, draftTurn, draftEach, cpuPick, cpuNames } from './draw.js';
import { computeScores, DEFAULT_RULES, DEFAULT_AWARDS, APPEARANCE_KEYS, isFinished, isLive, hasStarted } from './scoring.js';

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

const MODES = {
  onephone: ['📱', 'One phone', 'You run it all and tell your mates the scores. They need nothing.'],
  cpu: ['🤖', 'Vs the computer', 'You against virtual rivals dealt their own players.'],
  friends: ['👥', 'Friends’ phones', 'Everyone joins with an invite link and watches live.'],
};
/** Settings of a sweepstake, with defaults for games made before modes existed. */
const cfgOf = (dc = {}) => ({ mode: 'friends', pick: 'random', limit: 'limited', lineup: 'auto', starters: 3, subs: 1, includeGK: false, ...dc });
const LINEUP_TXT = { squad: 'Full squads, deal any time', xi: 'Starting XI (about 1 hr before kick-off)', auto: 'Line-ups if out, else squads' };
function setAppearance(rules, on) { APPEARANCE_KEYS.forEach((k) => { if (rules[k]) rules[k].on = on; }); }
const parseNames = (t) => [...new Set(String(t || '').split(/[\n,]/).map((x) => x.trim().slice(0, 30)).filter(Boolean))].slice(0, 11);

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
    if (V.data.sweep.status === 'drawn') [['board', '🏆', 'Leaderboard'], ['teams', '👥', 'Mates'], ['feed', '📣', 'Live feed'], ['rules', '⚙️', 'Scoring']].forEach(([k, i, l]) => items.push(['tab', i, l, k, V.tab === k]));
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

function squadsSection() {
  const st = S.squadStatus;
  const rows = st?.leagues?.length ? st.leagues.map((l) => `<div class="kv"><span>${esc(l.name)}</span><b>${l.loaded}/${l.expected}</b></div>`).join('') : '<div class="small muted">Checking…</div>';
  return `<div class="sec">Player squads</div>
    <div class="card flat">${rows}
      <div class="small muted" style="margin-top:6px">${st?.complete ? 'All squads are stored. Games deal players from here, with no live look-ups.' : S.seeding ? 'Loading squads in the background (a few every minute). Keep the app open.' : S.squadErr ? esc(S.squadErr) : 'Squads are stored once and reused. The free data plan limits how many we can fetch per day, so this finishes over a day or two.'}</div>
      ${!st?.complete && !S.seeding ? `<button class="soft block" data-act="loadsquads" style="margin-top:8px">Load squads now</button>` : ''}</div>`;
}
const FF_LEAGUES = { 39: 'Premier League', 40: 'Championship', 179: 'Scottish Premiership', 180: 'Scottish Championship' };
function footballDataSection() {
  const f = S.ff || {};
  return `<div class="sec">Football data</div>
    <div class="card flat"><div class="small muted">Loads clubs, players and season stats into the shared football database (one-off; carries on where it stopped if interrupted).</div>
      <div class="small" id="ffmsg" style="margin-top:6px">${esc(f.err ? 'Stopped: ' + f.err : f.msg || '')}</div>
      ${f.running ? '' : `<button class="soft block" data-act="loadfootball" style="margin-top:8px">${f.done ? 'Check for more' : 'Load football data'}</button>`}</div>`;
}
async function runFootballLoad() {
  if (S.ff?.running) return;
  const say = (msg) => { S.ff.msg = msg; const el = document.getElementById('ffmsg'); if (el) el.textContent = msg; };
  S.ff = { running: true, msg: 'Planning…' }; refreshSettings();
  try {
    const plan = await S.api.ffPlan();
    for (const l of plan.leagues) { say(`Setting up ${FF_LEAGUES[l]}`); await S.api.ffStep({ step: 'league', league: l }); }
    for (const t of plan.todo) {
      const lbl = `${FF_LEAGUES[t.league]} ${t.season}/${String(t.season + 1).slice(2)}`;
      say(`${lbl}: clubs`); await S.api.ffStep({ step: 'teams', ...t });
      let page = 1, total = 1;
      while (page <= total) { say(`${lbl}: players ${page}/${total}`); const r = await S.api.ffStep({ step: 'players', ...t, page }); total = r.total; page++; }
    }
    const p2 = await S.api.ffPlan();
    let n = 0; for (const team of p2.numbers) { say(`Shirt numbers ${++n}/${p2.numbers.length}`); await S.api.ffStep({ step: 'numbers', team }); }
    const c = (await S.api.ffPlan()).counts;
    S.ff = { done: true, msg: `Done: ${c.players} players, ${c.clubs} clubs, ${c.stats} season records.` };
  } catch (e) { S.ff = { err: e.message, msg: S.ff?.msg }; }
  refreshSettings();
}
function refreshSettings() { if (document.querySelector('.modal-back')) { closeModal(); document.body.insertAdjacentHTML('beforeend', settingsModal()); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Keep our own copy of the squads topped up (Premier League, Championship, Scottish Premiership and Championship). */
async function ensureSquads() {
  if (S.api.mode !== 'neon' || S.seeding || !S.user) return;
  try {
    S.squadErr = '';
    let st = await S.api.squadStatus(); S.squadStatus = st; refreshSettings();
    if (st.complete) return;
    S.seeding = true; refreshSettings();
    for (let i = 0; i < 40 && S.user; i++) {
      st = await S.api.seedSquads(); S.squadStatus = st; refreshSettings();
      if (st.complete) break;
      if (st.paused) { S.squadErr = st.paused === 'budget' ? 'Paused for today to save the free data allowance - it carries on tomorrow.' : st.paused; break; }
      if (st.busy) await wait(30000);
    }
  } catch (e) { S.squadErr = e.message; } finally { S.seeding = false; refreshSettings(); }
}

function settingsModal() {
  const u = S.user; const t = localStorage.getItem('statto_theme') || 'light'; const ac = localStorage.getItem('statto_accent') || 'Blue';
  return `<div class="modal-back" data-act="closesettings"><div class="modal">
    <div class="row between"><h2 style="text-transform:none;font-size:22px">Settings</h2><button class="soft sm" data-act="closesettings">✕</button></div>
    <div class="sec">Appearance</div>
    <div class="small muted">Theme</div><div class="chips" style="flex-wrap:wrap">${THEMES.map(([k, l]) => `<div class="chip ${t === k ? 'on' : ''}" data-act="theme" data-k="${k}">${l}</div>`).join('')}</div>
    <div class="small muted" style="margin-top:10px">App colour</div><div class="chips" style="flex-wrap:wrap">${ACCENTS.map(([n, a, b]) => `<div class="swatch ${ac === n ? 'on' : ''}" title="${n}" data-act="accent" data-k="${n}" style="background:linear-gradient(135deg,${a} 50%,${b} 50%)"></div>`).join('')}</div>
    ${S.api.mode === 'neon' ? squadsSection() : ''}
    ${S.api.mode === 'neon' && !u.guest ? footballDataSection() : ''}
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
/** Status pill for a game in the list: lobby/drafting while setting up, otherwise by kick-off time (approximate: 2h15 of play). */
function gameStatus(s) {
  if (s.status === 'setup') return 'Lobby';
  if (s.status === 'drafting') return 'Drafting';
  const ko = Date.parse(s.fixture?.kickoff);
  if (Number.isNaN(ko)) return 'Drawn';
  const mins = (Date.now() - ko) / 60000;
  return mins < 0 ? 'Not started' : mins < 135 ? 'Live' : 'Finished';
}
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
        <div class="row between"><b>${esc(s.name)}</b><span class="row" style="gap:6px"><span class="pill">${gameStatus(s)}</span>${s.isHost ? `<button class="ghost sm" data-act="delsweep" data-id="${s.id}" title="Delete" aria-label="Delete sweepstake">🗑</button>` : ''}</span></div>
        <div class="row muted small" style="margin-top:6px">${crest(s.fixture.teams.home)}${s.name === `${s.fixture.teams.home.name} v ${s.fixture.teams.away.name}` ? ' v ' : ` ${esc(s.fixture.teams.home.name)} v `}${crest(s.fixture.teams.away)}${s.name === `${s.fixture.teams.home.name} v ${s.fixture.teams.away.name}` ? '' : ` ${esc(s.fixture.teams.away.name)}`}</div>
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
// Defaults = the quickest set-up: one phone, random deal, full squads from both teams.
const N = { date: ymd(new Date()), fixtures: null, q: '', all: false, sel: null, name: '', starters: 3, subs: 1, gk: false, rules: clone(DEFAULT_RULES), awards: clone(DEFAULT_AWARDS), dname: '',
  mode: 'onephone', names: '', cpu: 2, pick: 'random', limit: 'limited', lineup: 'squad' };
setAppearance(N.rules, true);

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
    <div class="sec">2 · Who's playing?</div>
    <div class="opts">${Object.entries(MODES).map(([k, [ic, t, d]]) => `<button class="opt ${N.mode === k ? 'on' : ''}" data-act="mode" data-k="${k}"><span class="ic">${ic}</span><span><b>${t}</b><span class="d">${d}</span></span></button>`).join('')}</div>
    <div class="card stack" style="margin-top:10px">
      <div><label class="lbl">Sweepstake name</label><input type="text" id="sname" maxlength="40" placeholder="${esc(sel.teams.home.name)} v ${esc(sel.teams.away.name)}" value="${esc(N.name)}"></div>
      <div><label class="lbl">Your name</label><input type="text" id="dname" maxlength="30" value="${esc(N.dname)}"></div>
      ${N.mode === 'onephone' ? `<div><label class="lbl">Your mates' names - one per line</label><textarea id="nnames" placeholder="Dave&#10;Sam&#10;Priya">${esc(N.names)}</textarea><div class="small muted" style="margin-top:4px">You score the game on this phone and pass the news on. Up to 10 mates.</div></div>` : ''}
      ${N.mode === 'cpu' ? `<div class="row between"><div><b>Computer rivals</b><div class="small muted">${esc(cpuNames(N.cpu).join(', '))}</div></div>${stepper('cpu', N.cpu)}</div>` : ''}
      ${N.mode === 'friends' ? `<div class="small muted">You'll get an invite link to send round. You deal the players once everyone is in.</div>` : ''}
    </div>
    <div class="sec">3 · How it's played</div>
    <div class="card stack">
      <div><div class="small muted" style="margin-bottom:6px">Getting players</div><div class="tabs">${[['random', '🎲 Random deal'], ['draft', '🧢 Draft (take turns)']].map(([k, l]) => `<button class="${N.pick === k ? 'on' : ''}" data-act="opt" data-o="pick" data-k="${k}">${l}</button>`).join('')}</div></div>
      <div><div class="small muted" style="margin-bottom:6px">How many players</div><div class="tabs">${[['limited', 'A few each'], ['all', 'Whole squads']].map(([k, l]) => `<button class="${N.limit === k ? 'on' : ''}" data-act="opt" data-o="limit" data-k="${k}">${l}</button>`).join('')}</div></div>
      ${N.limit === 'limited' ? `
      <div class="row between"><div><b>Starters each</b><div class="small muted">${N.pick === 'random' ? 'Spread across defence, midfield & attack' : 'Any players you like'}</div></div>${stepper('starters', N.starters)}</div>
      <div class="row between"><div><b>Subs each</b><div class="small muted">${N.pick === 'random' ? 'Random bench player' : 'Counted in the picks above'}</div></div>${stepper('subs', N.subs)}</div>
      ${N.pick === 'random' ? `<div class="row between"><div><b>Include goalkeepers</b><div class="small muted">Adds a keeper to the role rotation</div></div><input type="checkbox" class="toggle" data-act="gk" ${N.gk ? 'checked' : ''}></div>` : ''}` : `<div class="small muted">Every player in both squads is shared out evenly. A few at random sit out if they don't divide exactly.</div>`}
      <div><div class="small muted" style="margin-bottom:6px">Which players</div><div class="tabs">${[['squad', 'Full squads'], ['xi', 'Starting XI']].map(([k, l]) => `<button class="${N.lineup === k ? 'on' : ''}" data-act="opt" data-o="lineup" data-k="${k}">${l}</button>`).join('')}</div>
        <div class="small muted" style="margin-top:6px">${N.lineup === 'squad' ? 'Deal any time. Points for starting (+1) and coming on (+1), and a penalty for being subbed off (-1).' : 'Wait until the line-ups are announced (about an hour before kick-off), then only players in the matchday squad are dealt.'}</div></div>
    </div>
    <div class="sec">4 · Scoring</div>
    ${rulesEditor(N.rules, N.awards, 'n')}
    <div class="sticky-cta"><button class="block" data-act="create" ${S.busy ? 'disabled' : ''}>${N.mode === 'friends' ? 'Create & get invite link' : N.pick === 'draft' ? 'Create & start the draft' : 'Create & deal the players'}</button></div>` : ''}
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
  captureNew();
  const members = N.mode === 'onephone' ? parseNames(N.names).map((n) => ({ name: n, kind: 'local' })) : N.mode === 'cpu' ? cpuNames(N.cpu).map((n) => ({ name: n, kind: 'cpu' })) : [];
  if (N.mode === 'onephone' && !members.length) return toast('Add at least one mate’s name');
  S.busy = true; renderNew();
  try {
    if (dname !== S.user.name) S.user = await S.api.auth.setName(dname);
    const drawConfig = { mode: N.mode, pick: N.pick, limit: N.limit, lineup: N.lineup, starters: N.starters, subs: N.subs, includeGK: N.gk };
    const s = await S.api.createSweepstake({ name, displayName: dname, fixture: sel, rules: N.rules, awards: N.awards, drawConfig, members });
    N.sel = null; N.name = '';
    if (N.mode !== 'friends') S.autoDeal = s.id; // no one to wait for: deal straight away
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
  if (S.autoDeal === id) { S.autoDeal = null; if (V.data.sweep.status === 'setup') await doDraw(); }
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

async function shareUpdate() {
  const { sweep } = V.data; const res = V.res; const st = V.state; const fx = sweep.fixture;
  if (!res) return;
  const score = st?.goals && st.goals.home != null ? `${fx.teams.home.name} ${st.goals.home}-${st.goals.away} ${fx.teams.away.name}` : `${fx.teams.home.name} v ${fx.teams.away.name}`;
  const status = isFinished(st) ? 'Full time' : isLive(st) ? (st.status.short === 'HT' ? 'Half time' : `${st.status.elapsed ?? ''}'`) : 'Not started';
  const lines = res.rows.map((r) => `${r.rank}. ${r.name} - ${r.points} pts`);
  const last = res.feed.slice(-3).reverse().map((e) => `${{ goal: '⚽', penalty: '⚽', ownGoal: '😬', penMissed: '❌', yellow: '🟨', red: '🟥' }[e.kind]} ${e.minute} ${e.pname}${e.ownerMemberId ? ' (' + V.data.members.find((m) => m.id === e.ownerMemberId)?.name + ')' : ''}`);
  const text = `${sweep.name}\n${score} (${status})\n\n${lines.join('\n')}${last.length ? '\n\nLatest:\n' + last.join('\n') : ''}`;
  if (navigator.share) { try { await navigator.share({ text }); return; } catch { /* cancelled */ } }
  await navigator.clipboard?.writeText(text); toast('Update copied - paste it in your group chat');
}

/** What to say before there is anything to show: not started, kick-off due, postponed... (empty string once the match has started). */
function waitTxt(fx = V.data?.sweep?.fixture, st = V.state) {
  const sh = st?.status?.short;
  if (sh === 'PST') return 'Match postponed';
  if (sh === 'CANC') return 'Match cancelled';
  if (hasStarted(st) || !fx?.kickoff) return '';
  const mins = Math.round((Date.parse(st?.kickoff || fx.kickoff) - Date.now()) / 60000);
  if (Number.isNaN(mins)) return 'Match not started yet';
  if (mins > 0) return `Match not started yet · kick-off ${mins >= 120 ? 'in ' + Math.round(mins / 60) + ' hours' : mins >= 60 ? 'in about an hour' : 'in ' + mins + ' min'}`;
  return mins > -3 ? 'Kick-off time - waiting for the first update' : 'Match due to start - waiting for the first update';
}
function matchHeader(fx, st) {
  const live = isLive(st), fin = isFinished(st), started = hasStarted(st);
  const sc = st?.goals && st.goals.home != null ? `<div class="score">${st.goals.home} - ${st.goals.away}</div>` : `<div class="score muted">v</div>`;
  const status = fin ? '<span class="pill">Full time</span>' : live ? `<span class="pill live">${st.status.short === 'HT' ? 'Half time' : (st.status.elapsed ?? '') + "'"}</span>` : st && started ? `<span class="pill">${esc(st.status.long)}</span>` : waitTxt(fx, st).startsWith('Match due') ? `<span class="pill">Due to start</span>` : `<span class="pill">${dayStr(fx.kickoff)} · ${timeStr(st?.kickoff || fx.kickoff)}</span>`;
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
  else if (sweep.status === 'drafting') { body = draftView(sweep, members, picks, isHost); queueMicrotask(cpuTurn); }
  else {
    const res = computeScores({ rules: sweep.rules, awards: sweep.awards, members, picks, state: st });
    V.res = res;
    body = '<div style="height:12px"></div>'
      + (V.tab === 'board' ? board(res, sweep) : V.tab === 'teams' ? mates(res, members, picks, sweep) : V.tab === 'feed' ? feed(res, members, sweep, st) : rulesTab(sweep, isHost, st));
  }
  const demoKick = S.api.mode === 'demo' && !hasStarted(st) ? `<button class="soft block" data-act="demokick" style="margin-top:10px">▶ Kick off demo match (plays out in ~3 min)</button>` : '';
  $app.innerHTML = shell(`
    ${matchHeader(fx, st)}${demoKick}
    ${V.stateErr ? `<div class="banner err" style="margin-top:10px">${esc(V.stateErr)}</div>` : ''}
    ${body}`, { title: sweep.name, sub: `Invite code ${sweep.code}` });
}

const members0 = () => V.data?.members || [];
const kindBadge = (m) => (m?.kind === 'cpu' ? '<span class="badge cpu">CPU</span>' : '');

function summaryText(dc) {
  const c = cfgOf(dc);
  const many = c.limit === 'all' ? 'The whole squads are shared out evenly' : `Each player gets <b style="color:var(--text)">${c.starters} starter${c.starters === 1 ? '' : 's'}</b>${c.pick === 'random' ? ' (spread across defence, midfield and attack' + (c.includeGK ? ', plus a keeper in the rotation' : '') + ')' : ''} and <b style="color:var(--text)">${c.subs} sub${c.subs === 1 ? '' : 's'}</b>${c.pick === 'random' ? ', split as evenly as possible between both teams' : ''}`;
  return `${c.pick === 'draft' ? 'Snake draft, taking turns.' : 'Random deal.'} ${many}. <span class="muted">${LINEUP_TXT[c.lineup]}.</span>`;
}

function lobby(sweep, members, isHost, st) {
  const link = inviteLink(sweep.code);
  const dc = cfgOf(sweep.drawConfig);
  const feas = V.pool && dc.pick === 'random' && dc.limit === 'limited' ? checkFeasible(V.pool, members.length, dc) : { ok: true };
  const friends = dc.mode === 'friends';
  const locals = members.filter((m) => m.kind === 'local'), cpus = members.filter((m) => m.kind === 'cpu');
  return `
    ${friends ? `<div class="card stack" style="margin-top:12px">
      <div class="center small muted">Invite your friends with this code</div>
      <div class="code">${esc(sweep.code)}</div>
      <div class="row"><button class="grow" data-act="share">Share invite link</button><button class="soft" data-act="copy" data-t="${esc(link)}">Copy</button></div>
      <div class="small muted center" style="word-break:break-all">${esc(link)}</div>
    </div>` : ''}
    <div class="card" style="margin-top:12px">
      <div class="row between"><b>${friends ? 'In the game' : MODES[dc.mode]?.[1] || 'Players'} (${members.length})</b>${friends ? '<span class="small muted">updates live</span>' : ''}</div>
      ${members.map((m) => `<div class="member"><span class="avatar">${esc(initials(m.name))}</span><span class="grow">${esc(m.name)}</span>${kindBadge(m)}${m.isHost ? '<span class="badge">HOST</span>' : ''}</div>`).join('')}
      ${isHost && dc.mode === 'onephone' ? (V.namesEdit ? `<div class="stack" style="margin-top:8px"><textarea id="lnames">${esc(V.namesText ?? locals.map((m) => m.name).join('\n'))}</textarea><div class="row"><button class="grow" data-act="savenames">Save names</button><button class="ghost" data-act="cancelnames">Cancel</button></div></div>` : `<div style="margin-top:8px"><button class="soft sm" data-act="editnames">✏️ Change mates’ names</button></div>`) : ''}
      ${isHost && dc.mode === 'cpu' ? `<div class="row between" style="margin-top:8px"><span class="small muted">Computer rivals</span>${stepper('lcpu', cpus.length)}</div>` : ''}
    </div>
    <div class="card" style="margin-top:12px"><div class="small muted">${summaryText(sweep.drawConfig)}</div></div>
    ${V.pool ? `<div class="banner ${V.pool.source === 'lineups' ? 'info' : ''}" style="margin-top:12px">${V.pool.source === 'lineups' ? '✅ Using the confirmed line-ups.' : dc.lineup === 'squad' ? 'Using the full squads.' : '⚠️ Line-ups aren\'t out yet, so this uses the full squads - some players may not make the matchday squad. Line-ups usually land about an hour before kick-off; you can redraw then.'}</div>` : ''}
    ${V.poolErr ? `<div class="banner err" style="margin-top:12px">${esc(V.poolErr)}${isHost && dc.lineup === 'xi' ? `<div style="margin-top:8px"><button class="soft sm" data-act="usesquads">Use full squads instead</button></div>` : ''}</div>` : ''}
    ${!feas.ok ? `<div class="banner err" style="margin-top:12px">${esc(feas.message)}</div>` : ''}
    ${isHost ? `<div class="sticky-cta stack"><button class="block" data-act="draw" ${members.length < 2 || S.busy ? 'disabled' : ''}>${members.length < 2 ? 'Waiting for friends…' : S.busy ? 'Working…' : dc.pick === 'draft' ? '🧢 Start the draft' : '🎲 Deal the players'}</button>${friends ? '<div class="small muted center">Everyone who has joined is in. New joiners are blocked once the players are dealt.</div>' : ''}</div>`
    : `<p class="muted center" style="margin-top:16px">Waiting for the host to ${dc.pick === 'draft' ? 'start the draft' : 'run the draw'}…</p>`}`;
}

/** Fetch the player pool the way this game wants it (full squads, or confirmed line-ups only). */
async function fetchPool(sweep) {
  const dc = cfgOf(sweep.drawConfig);
  const res = await S.api.getPool(sweep.fixture, true, dc.lineup === 'squad');
  if (dc.lineup === 'xi' && res.source !== 'lineups') throw new Error('The line-ups aren’t out yet - they usually land about an hour before kick-off. Try again then, or switch to full squads.');
  return res;
}

async function doDraw() {
  const { sweep, members } = V.data;
  const dc = cfgOf(sweep.drawConfig);
  S.busy = true; V.poolErr = ''; renderSweep();
  try {
    const poolRes = await fetchPool(sweep);
    V.pool = poolRes;
    const players = poolRes.players;
    const ids = members.map((m) => m.id);
    if (dc.pick === 'draft') {
      const each = draftEach(players.length, ids.length, dc);
      if (each < 1) throw new Error('Not enough players for that many people.');
      const order = ids.slice().sort(() => Math.random() - 0.5);
      const pool = players.map((p) => ({ id: p.id, name: p.name, number: p.number ?? null, photo: p.photo || null, side: p.side, teamId: p.teamId ?? null, role: p.role, bench: p.bench ?? null }));
      await S.api.startDraft(sweep.id, order, pool, each);
      await refreshSweep(); toast('🧢 Draft started');
    } else {
      const { picks } = dc.limit === 'all' ? dealAll({ pool: { players }, memberIds: ids }) : runDraw({ pool: { players }, memberIds: ids, config: dc });
      const byId = new Map(players.map((p) => [p.id, p]));
      const rows = picks.map((p) => { const pl = byId.get(p.playerId); return { memberId: p.memberId, playerId: p.playerId, playerName: pl.name, number: pl.number ?? null, photo: pl.photo || null, side: pl.side, teamId: pl.teamId ?? null, role: pl.role, slot: p.slot }; });
      await S.api.saveDraw(sweep.id, rows);
      await refreshSweep(); V.tab = 'teams';
      toast('🎲 Players dealt!');
    }
  } catch (e) { V.poolErr = e.message; toast(e.message); }
  S.busy = false; renderSweep();
}

// ---- draft
const ROLE_ORDER = { ATT: 0, MID: 1, DEF: 2, GK: 3 };
function draftView(sweep, members, picks, isHost) {
  const dc = cfgOf(sweep.drawConfig); const order = dc.order || []; const each = dc.each || 1; const total = order.length * each;
  const n = picks.length; const turnId = draftTurn(order, n); const turnM = members.find((m) => m.id === turnId);
  const mine = turnM && (turnM.userId === S.user.id || (isHost && turnM.kind !== 'cpu'));
  const taken = new Set(picks.map((p) => p.playerId));
  const fx = sweep.fixture; const f = V.dfilter || { side: 'all', role: 'all' };
  const avail = (sweep.pool || []).filter((p) => !taken.has(p.id) && (f.side === 'all' || p.side === f.side) && (f.role === 'all' || p.role === f.role))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.number ?? 99) - (b.number ?? 99));
  const upcoming = Array.from({ length: Math.min(order.length, total - n) }, (_, i) => draftTurn(order, n + i));
  const res = computeScores({ rules: sweep.rules, awards: sweep.awards, members, picks, state: V.state });
  const chip = (k, v, label, on) => `<div class="chip ${on ? 'on' : ''}" data-act="dfilter" data-f="${k}" data-v="${v}">${esc(label)}</div>`;
  return `
    <div class="card turn stack" style="margin-top:12px">
      <div class="row between"><b>🧢 Draft · pick ${Math.min(n + 1, total)} of ${total}</b><span class="small muted">${each} each</span></div>
      <div style="font-size:20px;font-weight:800">${turnM ? (turnM.userId === S.user.id ? 'Your pick!' : `${esc(turnM.name)} is picking${turnM.kind === 'cpu' ? '…' : ''}`) : '…'}</div>
      <div class="mini">${upcoming.map((id, i) => `<div class="chip ${i === 0 ? 'cur' : ''}">${esc(members.find((m) => m.id === id)?.name || '?')}</div>`).join('')}</div>
      <div class="small muted">Snake order: the order reverses each round so nobody gets all the first picks.${isHost && turnM && turnM.userId !== S.user.id && turnM.kind !== 'cpu' ? ' As host you can pick for them.' : ''}</div>
    </div>
    <div class="chips" style="margin-top:12px;flex-wrap:wrap">${chip('side', 'all', 'Both teams', f.side === 'all')}${chip('side', 'home', fx.teams.home.name, f.side === 'home')}${chip('side', 'away', fx.teams.away.name, f.side === 'away')}</div>
    <div class="chips" style="margin:8px 0;flex-wrap:wrap">${['all', 'ATT', 'MID', 'DEF', 'GK'].map((r) => chip('role', r, r === 'all' ? 'All positions' : r, f.role === r)).join('')}</div>
    <div class="card dlist">${avail.map((p) => `<div class="dplayer">${p.photo ? `<img class="photo" src="${esc(p.photo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<div class="shirt">${esc(p.number ?? '')}</div>`}
      <div class="grow"><b>${esc(p.name)}</b><div class="small muted">${esc(fx.teams[p.side].name)}${p.number ? ' · #' + esc(p.number) : ''}</div></div>
      <span class="badge ${p.role}">${p.role}</span>${p.bench === true ? '<span class="badge sub">SUB</span>' : ''}
      <button class="sm" data-act="dpick" data-id="${p.id}" ${mine && !S.busy ? '' : 'disabled'}>Pick</button></div>`).join('') || '<p class="muted center">No players match that filter.</p>'}</div>
    <h3 style="margin:22px 2px 8px">Picked so far</h3>
    ${n ? teams(res, members, picks, sweep) : '<p class="muted center small">Nobody has picked yet.</p>'}`;
}

async function doDraftPick(playerId, memberId) {
  const { sweep, members, picks } = V.data;
  const turnId = draftTurn(sweep.drawConfig.order, picks.length);
  S.busy = true; renderSweep();
  try { await S.api.draftPick(sweep.id, memberId || turnId, playerId); await refreshSweep(); if (V.data.sweep.status === 'drawn') { V.tab = 'teams'; toast('✅ Draft complete - good luck!'); } }
  catch (e) { toast(e.message); await refreshSweep().catch(() => {}); }
  S.busy = false; renderSweep();
}

/** The host's device makes the computer's picks, after a short beat so it feels like it's thinking. */
function cpuTurn() {
  const d = V.data; if (!d || d.sweep.status !== 'drafting' || S.busy || V.cpuTimer) return;
  const isHost = d.sweep.creatorId === S.user.id; if (!isHost) return;
  const turn = d.members.find((m) => m.id === draftTurn(d.sweep.drawConfig.order, d.picks.length));
  if (!turn || turn.kind !== 'cpu') return;
  V.cpuTimer = setTimeout(async () => {
    V.cpuTimer = null;
    const cur = V.data; if (!cur || cur.sweep.status !== 'drafting' || S.route?.[0] !== 's') return;
    const taken = new Set(cur.picks.map((p) => p.playerId));
    const choice = cpuPick(cur.sweep.pool.filter((p) => !taken.has(p.id)));
    if (choice) await doDraftPick(choice.id, turn.id);
  }, 900);
}

function board(res, sweep) {
  const fin = isFinished(V.state);
  return `
    <div class="row" style="margin-bottom:10px"><button class="soft sm grow" data-act="shareupdate">📋 Share an update with the group</button></div>
    <div class="stack">${res.rows.map((r) => `
      <div class="card" data-act="toggle" data-id="${r.memberId}" style="cursor:pointer">
        <div class="rank ${r.rank === 1 && r.points > 0 ? 'first' : ''}"><div class="pos">${r.rank}</div>
          <div><b>${esc(r.name)}</b> ${kindBadge(members0().find((m) => m.id === r.memberId))}<div class="small muted">${r.goals} goal${r.goals === 1 ? '' : 's'} · ${r.bookings} booking${r.bookings === 1 ? '' : 's'}</div></div>
          <div class="pts ${r.points > 0 ? 'pos' : r.points < 0 ? 'neg' : ''}">${r.points}</div></div>
        ${V.open.has(r.memberId) ? `<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px">${r.lines.length ? r.lines.map((l) => `<div class="line"><span>${esc(l.minute)} · <b>${esc(l.playerName)}</b> · ${esc(l.label)}</span><span class="${l.points >= 0 ? 'p-pos' : 'p-neg'}">${fmtPts(l.points)}</span></div>`).join('') : `<div class="small muted">${esc(waitTxt() || 'Nothing yet.')}</div>`}</div>` : ''}
      </div>`).join('')}</div>
    <h3 style="margin:22px 2px 8px">Side prizes ${fin ? '' : '<span class="small" style="text-transform:none">· live, not final</span>'}</h3>
    <div class="card">${Object.entries(res.awards).map(([k, a]) => `<div class="award"><div><b>${esc(sweep.awards[k].label)}</b><div class="small muted">${esc(a.detail || '')}${a.unowned ? ' · player not in anyone’s hand' : ''}</div></div><div class="w ${a.winner?.length ? (a.final ? 'gold' : '') : 'muted'}">${a.winner?.length ? esc(a.winner.join(' & ')) : '—'}</div></div>`).join('') || '<p class="muted small">No side prizes switched on.</p>'}</div>`;
}


/** Mates as buttons; tap one to see their players, who to root for, and points so far. */
function mates(res, members, picks, sweep) {
  const fx = sweep.fixture;
  const me = members.find((m) => m.userId === S.user.id);
  const sel = members.find((m) => m.id === V.mate) || (me && members.find((m) => m.id === me.id)) || members[0];
  V.mate = sel?.id;
  const row = (id) => res.rows.find((r) => r.memberId === id);
  const byMember = (id) => picks.filter((p) => p.memberId === id).sort((a, b) => (a.slot === 'sub') - (b.slot === 'sub') || a.side.localeCompare(b.side));
  const btns = res.rows.slice().sort((a, b) => members.findIndex((m) => m.id === a.memberId) - members.findIndex((m) => m.id === b.memberId)).map((r) => {
    const m = members.find((x) => x.id === r.memberId);
    return `<button class="opt ${m.id === sel.id ? 'on' : ''}" data-act="mate" data-id="${m.id}" style="padding:10px 12px;width:auto"><span class="avatar">${esc(initials(m.name))}</span><span><b style="font-size:14px">${esc(m.name)}</b><span class="d">${r.points} pt${r.points === 1 ? '' : 's'}${r.rank === 1 && r.points > 0 ? ' · 👑' : ''}</span></span></button>`;
  }).join('');
  const mine = byMember(sel.id); const r = row(sel.id);
  const ptsOf = (pid) => (r?.lines || []).filter((l) => l.playerId === pid);
  const total = r?.points ?? 0;
  const byTeam = ['home', 'away'].map((side) => ({ side, list: mine.filter((p) => p.side === side) })).filter((g) => g.list.length);
  return `
    <div class="small muted" style="margin:2px 2px 8px">Tap a mate to see who they’re rooting for.</div>
    <div class="chips" style="flex-wrap:wrap;gap:8px">${btns}</div>
    <div class="card" style="margin-top:12px">
      <div class="row between"><div class="row"><span class="avatar">${esc(initials(sel.name))}</span><b style="font-size:17px">${esc(sel.name)}</b>${kindBadge(sel)}</div><b class="pts ${total > 0 ? 'pos' : total < 0 ? 'neg' : ''}" style="font-size:28px">${total}</b></div>
      <div class="small muted" style="margin:4px 0 6px">${mine.length} player${mine.length === 1 ? '' : 's'} · points so far</div>
      ${byTeam.map((g) => `<div class="row small muted" style="margin:10px 0 2px">${crest(fx.teams[g.side])}<b style="color:var(--text)">Root for ${esc(fx.teams[g.side].name)}</b></div>
        ${g.list.map((p) => {
          const ls = ptsOf(p.playerId); const pp = ls.reduce((t, l) => t + l.points, 0);
          return `<div class="player">${p.photo ? `<img class="photo" src="${esc(p.photo)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'shirt',textContent:'${esc(p.number ?? '')}'}))">` : `<div class="shirt">${esc(p.number ?? '')}</div>`}
            <div class="grow"><b>${esc(p.playerName)}</b><div class="small muted">${ls.length ? ls.map((l) => `${esc(l.minute)} ${esc(l.label)} (${fmtPts(l.points)})`).join(' · ') : esc(waitTxt() || 'Nothing yet')}</div></div>
            <span class="badge ${p.role}">${p.role}</span>${p.slot === 'sub' ? '<span class="badge sub">SUB</span>' : ''}
            <b class="${pp > 0 ? 'p-pos' : pp < 0 ? 'p-neg' : 'muted'}" style="min-width:28px;text-align:right">${pp ? fmtPts(pp) : '0'}</b></div>`;
        }).join('')}`).join('')}
      <div style="margin-top:12px"><button class="soft block" data-act="tellmate" data-id="${sel.id}">📣 Tell ${esc(sel.name)} who to root for</button></div>
    </div>`;
}

async function tellMate(id) {
  const { sweep, members, picks } = V.data; const fx = sweep.fixture; const m = members.find((x) => x.id === id); if (!m) return;
  const r = V.res?.rows.find((x) => x.memberId === id);
  const lines = ['home', 'away'].map((side) => {
    const list = picks.filter((p) => p.memberId === id && p.side === side);
    return list.length ? `${fx.teams[side].name}: ${list.map((p) => p.playerName + (p.slot === 'sub' ? ' (sub)' : '')).join(', ')}` : null;
  }).filter(Boolean);
  const text = `${m.name}, for ${fx.teams.home.name} v ${fx.teams.away.name} you're rooting for:\n${lines.join('\n')}${r ? `\n\nYou have ${r.points} point${r.points === 1 ? '' : 's'} so far.` : ''}`;
  if (navigator.share) { try { await navigator.share({ text }); return; } catch { /* cancelled */ } }
  await navigator.clipboard?.writeText(text); toast(`Copied - paste it to ${m.name}`);
}

function teams(res, members, picks, sweep) {
  const pts = new Map();
  res.rows.forEach((r) => r.lines.forEach((l) => pts.set(l.playerId, (pts.get(l.playerId) || 0) + l.points)));
  const fx = sweep.fixture;
  return `<div class="stack">${members.map((m) => {
    const mine = picks.filter((p) => p.memberId === m.id).sort((a, b) => (a.slot === 'sub') - (b.slot === 'sub'));
    const total = res.rows.find((r) => r.memberId === m.id)?.points ?? 0;
    return `<div class="card"><div class="row between"><div class="row"><span class="avatar">${esc(initials(m.name))}</span><b>${esc(m.name)}</b>${kindBadge(m)}</div><b class="pts ${total > 0 ? 'pos' : total < 0 ? 'neg' : ''}" style="font-size:26px">${total}</b></div>
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
  const when = V.stateErr ? '' : st ? `<p class="small muted center">Shared live feed · refreshes about every 5 minutes (free API plan)</p>` : '';
  return when + `<div class="card">${items.map((e) => {
    const o = members.find((m) => m.id === e.ownerMemberId); const pts = sweep.rules[e.kind];
    return `<div class="ev"><div class="min">${esc(e.minute)}</div><div>${icon[e.kind]}</div><div><b>${esc(e.pname || '')}</b> <span class="muted">${lbl[e.kind]}</span>
      <div class="small ${o ? '' : 'muted'}">${o ? `${esc(o.name)}’s player <span class="${pts?.points >= 0 ? 'p-pos' : 'p-neg'}">${fmtPts(pts?.on ? pts.points : 0)}</span>` : 'Nobody’s player'}${e.aname && e.kind === 'goal' ? ` · assist ${esc(e.aname)}` : ''}</div></div></div>`;
  }).join('') || `<p class="muted center">${esc(waitTxt(sweep.fixture, st) || 'No goals or cards yet. Events appear here as they happen.')}</p>`}</div>
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
      ${!locked && !editing ? `<button class="danger block" data-act="reopen">Reopen the draw (redraw players)</button>` : ''}
      ${!editing ? `<button class="danger block" data-act="delsweep" data-id="${V.id}" style="margin-top:8px">Delete this sweepstake</button>` : ''}</div>` : '<p class="small muted center" style="margin-top:12px">Only the host can change the scoring.</p>'}`;
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
    case 'loadsquads': ensureSquads(); return;
    case 'loadfootball': runFootballLoad(); return;
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
    case 'step': {
      if (d.k === 'lcpu') { const cur = V.data.members.filter((m) => m.kind === 'cpu').length; const nn = Math.max(1, Math.min(7, cur + Number(d.d))); if (nn !== cur) { await S.api.setMembers(V.id, cpuNames(nn).map((n) => ({ name: n, kind: 'cpu' }))); await refreshSweep(); renderSweep(); } return; }
      const k = d.k, dlt = Number(d.d); const lim = { starters: [1, 8], subs: [0, 3], cpu: [1, 7] }[k]; N[k] = Math.max(lim[0], Math.min(lim[1], N[k] + dlt)); captureNew(); return renderNew(); }
    case 'create': return createSweep();
    case 'mode': captureNew(); N.mode = d.k; return renderNew();
    case 'opt': { captureNew(); N[d.o] = d.k; if (d.o === 'lineup') setAppearance(N.rules, d.k === 'squad'); return renderNew(); }
    case 'rulestep': { const t = d.s === 'n' ? N.rules : V.edit.rules; t[d.k].points = Math.max(-10, Math.min(10, t[d.k].points + Number(d.d))); captureNew(); return d.s === 'n' ? renderNew() : renderSweep(); }
    // sweep
    case 'tab': V.tab = d.k; return renderSweep();
    case 'toggle': V.open.has(d.id) ? V.open.delete(d.id) : V.open.add(d.id); return renderSweep();
    case 'share': { const link = inviteLink(V.data.sweep.code); const text = `Join my Statto Sweepstake for ${V.data.sweep.fixture.teams.home.name} v ${V.data.sweep.fixture.teams.away.name}! Code ${V.data.sweep.code}`; if (navigator.share) { try { await navigator.share({ title: 'Statto Sweepstake', text, url: link }); return; } catch { /* cancelled */ } } await navigator.clipboard?.writeText(`${text} ${link}`); return toast('Invite copied'); }
    case 'copy': await navigator.clipboard?.writeText(d.t); return toast('Link copied');
    case 'draw': return doDraw();
    case 'dpick': return doDraftPick(Number(d.id));
    case 'dfilter': V.dfilter = { ...(V.dfilter || { side: 'all', role: 'all' }), [d.f]: d.v }; return renderSweep();
    case 'shareupdate': return shareUpdate();
    case 'mate': V.mate = d.id; return renderSweep();
    case 'tellmate': return tellMate(d.id);
    case 'editnames': V.namesEdit = true; V.namesText = undefined; return renderSweep();
    case 'cancelnames': V.namesEdit = false; V.namesText = undefined; return renderSweep();
    case 'savenames': { const names = parseNames(document.getElementById('lnames').value); if (!names.length) return toast('Add at least one name'); await S.api.setMembers(V.id, names.map((n) => ({ name: n, kind: 'local' }))); V.namesEdit = false; V.namesText = undefined; await refreshSweep(); return renderSweep(); }
    case 'usesquads': { const sw = V.data.sweep; const dc = { ...cfgOf(sw.drawConfig), lineup: 'squad' }; const rules = clone(sw.rules); setAppearance(rules, true); await S.api.updateSetup(V.id, dc, rules); V.poolErr = ''; await refreshSweep(); return renderSweep(); }
    case 'refresh': await pollState(true); return renderSweep();
    case 'demokick': await S.api.startDemoMatch(); await pollState(); return;
    case 'editrules': V.edit = { rules: clone(V.data.sweep.rules), awards: clone(V.data.sweep.awards) }; return renderSweep();
    case 'cancelrules': V.edit = null; return renderSweep();
    case 'saverules': await S.api.updateRules(V.id, V.edit.rules, V.edit.awards); V.edit = null; await refreshSweep(); toast('Scoring updated'); return renderSweep();
    case 'delsweep': if (confirm('Delete this sweepstake for everyone? The players, points and invite code are removed and it can’t be undone.')) {
      try { await S.api.deleteSweep(d.id); toast('Sweepstake deleted'); if (location.hash.startsWith('#/s/')) go('#/'); else viewHome(); } catch (e) { toast(e.message); } } return;
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
  if (ev.target.id === 'nnames') N.names = ev.target.value;
  if (ev.target.id === 'lnames') V.namesText = ev.target.value;
});
function captureNew() { const s = document.getElementById('sname'), d = document.getElementById('dname'), t = document.getElementById('nnames'); if (s) N.name = s.value; if (d) N.dname = d.value; if (t) N.names = t.value; }
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'gname') doGuest(); if (ev.key === 'Enter' && (ev.target.id === 'aemail' || ev.target.id === 'apass')) doPassword(AUTH.mode === 'signup'); if (ev.key === 'Enter' && ev.target.id === 'joincode') document.querySelector('[data-act=joincode]')?.click(); });
document.addEventListener('focusin', (ev) => { S.focusQ = ev.target.id === 'fxq'; });

function closeModal() { document.querySelector('.modal-back')?.remove(); }

// ------------------------------------------------------------------ boot
(async function boot() {
  applyLook(); matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyLook);
  S.api = await createApi(window.STATTO_CONFIG || {});
  S.user = await S.api.auth.getUser();
  S.api.auth.onChange((u) => { const had = !!S.user; S.user = u; if (!!u !== had) route(); if (u && !had) ensureSquads(); });
  window.addEventListener('hashchange', route);
  route();
  if (S.user) setTimeout(ensureSquads, 1500);
})();
