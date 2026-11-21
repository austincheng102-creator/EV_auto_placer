// Connects to the local engine (ws://127.0.0.1:8765) and executes requests inside the
// matching sportsbook tab, in the page's own context, so the site's cookies and
// session headers apply exactly as when you click "Place bet" yourself.
const PORT = 8765;
const BOOK_HOSTS = {
  betrivers: [/\.betrivers\.(ca|com)$/],
  fanduel: [/sportsbook\.fanduel\.(com|ca)$/],
  hardrock: [/(^|\.)hardrock\.bet$/, /(^|\.)hardrocksportsbook\.com$/],
  gambit: [/(^|\.)gambitodds\.com$/],
};

// Saved logins: kept in memory-only storage (gone when Chrome restarts or the extension reloads)
// and on disk, so an update that reloads the extension doesn't lose them. Hard Rock's location
// check only comes from a bet you place by hand, so losing it stopped every Hard Rock bet.
const store = {
  async get(keys) {
    const l = await chrome.storage.local.get(keys).catch(() => ({}));
    const s = (await chrome.storage.session?.get(keys).catch(() => ({}))) || {};
    for (const [k, v] of Object.entries(s)) if (v != null) l[k] = v;
    return l;
  },
  set(o) { chrome.storage.session?.set(o).catch(() => {}); chrome.storage.local.set(o).catch(() => {}); },
};

// Gambit's login token expires about hourly and the site refreshes it on its own. We
// watch the requests your open Gambit tab makes and reuse its current token, so the
// engine never needs a copied one.
// Only a real, unexpired token is kept, and never one that runs out sooner than the one we have:
// while the page reloads or renews its login it can send an empty or older token, which used to
// replace the good one and make every poll fail. The last few good tokens are kept so a refused
// one can fall back to the next.
let gambitAuth = null;
let gambitSpare = [];   // other recent tokens, newest first
const gambitTokenOk = (v) => {
  if (!v || /^(bearer\s*)?(null|undefined|)$/i.test(String(v).trim())) return false;
  const exp = jwtExp(v);
  return !exp || exp > Date.now() / 1000;
};
function takeGambitToken(v) {
  if (v === gambitAuth || !gambitTokenOk(v)) return;
  if (gambitAuth && gambitTokenOk(gambitAuth) && jwtExp(v) && jwtExp(gambitAuth) && jwtExp(v) < jwtExp(gambitAuth)) return;
  if (gambitAuth) gambitSpare = [gambitAuth, ...gambitSpare.filter((t) => t !== gambitAuth && t !== v)].slice(0, 3);
  gambitAuth = v;
  store.set({ gambitAuth, gambitSpare });
}
// Gambit refused this token: move to the newest spare that hasn't run out. With no spare we keep
// it (the page's next request brings a new one), so a one-off refusal can't leave us with none.
function dropGambitToken(v) {
  gambitSpare = gambitSpare.filter((t) => t !== v && gambitTokenOk(t));
  if (gambitAuth !== v || !gambitSpare.length) return false;
  gambitAuth = gambitSpare.shift();
  store.set({ gambitAuth, gambitSpare });
  return true;
}
store.get(['gambitAuth', 'gambitSpare']).then((v) => {
  if (!gambitAuth && v?.gambitAuth) { gambitAuth = v.gambitAuth; gambitSpare = v.gambitSpare || []; }
});
chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  const h = (d.requestHeaders || []).find((x) => x.name.toLowerCase() === 'authorization');
  if (h?.value) takeGambitToken(h.value);
}, { urls: ['https://api-sports.gambitodds.com/*'] }, ['requestHeaders', 'extraHeaders']);

// BetRivers (Kambi) works the same way: its bet-slip requests carry a login token in an
// Authorization header. We keep the latest one your BetRivers tab sent.
let kambiAuth = null;
store.get('kambiAuth').then((v) => { if (v?.kambiAuth && !kambiAuth) kambiAuth = v.kambiAuth; });
chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  const h = (d.requestHeaders || []).find((x) => x.name.toLowerCase() === 'authorization');
  if (h?.value && h.value !== kambiAuth) { kambiAuth = h.value; store.set({ kambiAuth }); }
}, { urls: ['https://*.kambicdn.org/*', 'https://*.kambicdn.com/*'] }, ['requestHeaders', 'extraHeaders']);

// BetRivers' own site API (bet history) wants the x-auth-token header the site sends.
let rsiAuth = null;
store.get('rsiAuth').then((v) => { if (v?.rsiAuth && !rsiAuth) rsiAuth = v.rsiAuth; });
chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  const h = (d.requestHeaders || []).find((x) => x.name.toLowerCase() === 'x-auth-token');
  if (h?.value && h.value !== rsiAuth) { rsiAuth = h.value; store.set({ rsiAuth }); }
}, { urls: ['https://*.betrivers.com/api/*'] }, ['requestHeaders', 'extraHeaders']);

// Hard Rock Bet sends no auth headers: its login token (sessionToken) and location-check
// token (geolocationDetails) ride in the form body of its own requests. We keep the latest
// ones your Hard Rock tab sent. The login token refreshes every few seconds; the location
// token is only sent when you place a bet, so place one bet by hand after logging in.
let hrAuth = { session: null, geo: null, geoAt: 0, sessionAt: 0 };
store.get('hrAuth').then((v) => { if (v?.hrAuth && !hrAuth.session) hrAuth = v.hrAuth; });
chrome.webRequest.onBeforeRequest.addListener((d) => {
  const f = d.requestBody?.formData;
  if (!f) return;
  const session = f.sessionToken?.[0], geo = f.geolocationDetails?.[0];
  if ((session && session !== hrAuth.session) || geo) {
    hrAuth = { ...hrAuth, ...(session && session !== hrAuth.session ? { session, sessionAt: Date.now() } : {}), ...(geo ? { geo, geoAt: Date.now() } : {}) };
    store.set({ hrAuth });
  }
}, { urls: ['https://*.hardrocksportsbook.com/*'] }, ['requestBody']);

// FanDuel: its bet requests carry the login in an x-authentication header (lasts about an hour,
// the page renews it) and, for placing, the location check in x-geo-packet (lasts 20 minutes).
// We keep the newest of each that your FanDuel tab sent. The page gets a fresh location check every 20 minutes
// and only sends it with a bet, so fd-geo.js also keeps a copy of each one the page receives.
let fdAuth = { auth: null, geo: null, authAt: 0 };
store.get('fdAuth').then((v) => { if (v?.fdAuth && !fdAuth.auth) fdAuth = v.fdAuth; });
const fdGeoExp = (tok) => {
  try { return Date.parse(JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).expires) || 0; } catch { return 0; }
};
chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  const get = (n) => (d.requestHeaders || []).find((x) => x.name.toLowerCase() === n)?.value;
  const auth = get('x-authentication'), geo = get('x-geo-packet');
  const next = { ...fdAuth };
  if (auth && /^eyJ/.test(auth) && auth !== fdAuth.auth && (!fdAuth.auth || jwtExp(auth) >= jwtExp(fdAuth.auth) || jwtExp(fdAuth.auth) < Date.now() / 1000)) { next.auth = auth; next.authAt = Date.now(); }
  if (geo && fdGeoExp(geo) > fdGeoExp(fdAuth.geo)) next.geo = geo;
  if (next.auth !== fdAuth.auth || next.geo !== fdAuth.geo) { fdAuth = next; store.set({ fdAuth }); }
}, { urls: ['https://*.sportsbook.fanduel.com/*'] }, ['requestHeaders', 'extraHeaders']);

// fd-geo.js has to be in the FanDuel page from the start to see its location checks.
async function registerFdGeo() {
  try {
    const have = await chrome.scripting.getRegisteredContentScripts({ ids: ['fd-geo'] });
    if (have.length) return;
    await chrome.scripting.registerContentScripts([{ id: 'fd-geo', js: ['fd-geo.js'], matches: ['https://*.sportsbook.fanduel.com/*'],
      runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true }]);
  } catch {}
}
registerFdGeo();
const readFdGeo = () => { try { return sessionStorage.getItem('evPlacerFdGeo'); } catch { return null; } };

// Read as text: the id is a number too big for JSON.parse to keep exact.
const hrAccountId = (tok) => {
  try { return (/"accountId"\s*:\s*"?(\d+)/.exec(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) || [])[1] || ''; } catch { return ''; }
};

// The csrf_token header some Hard Rock requests (balance) want is inside the login token.
const hrCsrf = (tok) => {
  try { return JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).csrfToken || ''; } catch { return ''; }
};

// Seconds since 1970 when a login token (JWT) runs out, or 0 if it isn't one.
const jwtExp = (tok) => {
  try { return Number(JSON.parse(atob(String(tok).replace(/^Bearer\s+/i, '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp) || 0; } catch { return 0; }
};

// ---- Gambit auto login (Chrome's saved password) ----
// When Gambit's session ends, its tab lands on the home page (/welcome) with a "Login" button.
// We open that login box and let Chrome's password manager fill it, then press Login.
// The extension never reads, keeps or sends your password: Chrome fills it and the Gambit page
// itself sends it, exactly as when you log in by hand.
// Catch: Chrome hides a filled-in password from page scripts until a real click or key press, so
// a script's click would log in with an empty password. So the clicks go through Chrome's
// debugger (chrome.debugger), which Chrome treats as real mouse/keyboard input. While it runs
// (a few seconds) Chrome shows a bar "EV Placer Bridge started debugging this browser"; it goes
// away by itself. Off with config.json "session": {"gambitAutoLogin": false}.
let settings = { gambitAutoLogin: true };
chrome.storage.local.get('settings').then((v) => { if (v?.settings) settings = { ...settings, ...v.settings }; }).catch(() => {});
let lastLogin = null;          // { at, ok, why } for the popup
let loginBusy = false;
let loginTriedAt = 0;
let loginFails = 0;            // failed tries in a row: wait longer between them
const say = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'login', book: 'gambit', ...o })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the Gambit page. Opens the login box if needed and says where its fields are.
async function gambitLoginForm(open) {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const pw = () => [...document.querySelectorAll('input[type=password]')].find(vis);
  const loginBtn = () => [...document.querySelectorAll('button, a')].find((b) => vis(b) && /^\s*(log\s?in|sign\s?in)\s*$/i.test(b.textContent || ''));
  if (!pw()) {
    const b = loginBtn();
    if (!b) return { state: 'logged-in' };          // no Login button and no form: nothing to do
    if (!open) return { state: 'logged-out' };
    b.click();
    for (let i = 0; i < 40 && !pw(); i++) await new Promise((r) => setTimeout(r, 250));
    if (!pw()) return { state: 'no-form' };
  }
  const p = pw();
  const scope = p.form || p.closest('form, [role=dialog]') || document;
  const user = scope.querySelector('input[name=username], input[type=email], input[autocomplete=username], input[type=text]');
  const btns = [...scope.querySelectorAll('button')].filter(vis);
  const submit = btns.find((b) => b.type === 'submit' && /log\s?in|sign\s?in/i.test(b.textContent || '')) || btns.find((b) => b.type === 'submit');
  p.scrollIntoView({ block: 'center' });
  const at = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .cf-turnstile');
  return { state: 'form', user: at(user), pass: at(p), submit: at(submit), userLen: (user?.value || '').length, passLen: p.value.length, captcha };
}

const dbgCmd = (target, method, params = {}) => Promise.race([
  new Promise((res, rej) => chrome.debugger.sendCommand(target, method, params, (r) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)))),
  sleep(5000).then(() => { throw new Error(`${method} got no answer`); }),
]);
async function realClick(target, p) {
  await dbgCmd(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await dbgCmd(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await dbgCmd(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
async function realKey(target, key, code, vk, text) {
  await dbgCmd(target, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  if (text) await dbgCmd(target, 'Input.dispatchKeyEvent', { type: 'char', key, code, text, windowsVirtualKeyCode: vk });
  await dbgCmd(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
// Runs in the Gambit page: presses a visible "Log out" / "Sign out" button if there is one.
function clickLogout() {
  const b = [...document.querySelectorAll('button, a, [role=menuitem]')].find((e) => e.getClientRects().length && /^\s*(log\s?out|sign\s?out)\s*$/i.test(e.textContent || ''));
  if (b) { b.click(); return true; }
  return false;
}
async function openWelcome(tabId) {
  await chrome.tabs.update(tabId, { url: 'https://www.gambitodds.com/welcome' });
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === 'complete') break;
  }
  await sleep(3000);
  const r = await inPage(tabId, false).catch(() => ({ state: 'no-page' }));
  return { ...r, url: 'https://www.gambitodds.com/welcome' };
}
// The Gambit page you use while logged in (not the home page), to go back to after logging in.
let gambitHomeUrl = null;
chrome.storage.local.get('gambitHomeUrl').then((v) => { if (v?.gambitHomeUrl) gambitHomeUrl = v.gambitHomeUrl; }).catch(() => {});
async function rememberGambitPage() {
  if (gambitRefused || !gambitTokenOk(gambitAuth)) return;
  const t = (await bookTabs()).find((x) => x.book === 'gambit' && /^https:\/\/(www\.)?gambitodds\.com\/./.test(x.url || '') && !/\/welcome/.test(x.url));
  if (t && t.url !== gambitHomeUrl) { gambitHomeUrl = t.url; chrome.storage.local.set({ gambitHomeUrl }).catch(() => {}); }
}
const inPage = async (tabId, open) => (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: gambitLoginForm, args: [open] }))[0]?.result || { state: 'no-page' };

async function autoLoginGambit(why) {
  if (!settings.gambitAutoLogin || loginBusy) return;
  // At most one try every 2 minutes; after 3 failures in a row, every 10 minutes (it keeps trying).
  const gap = loginFails >= 3 ? 10 * 60e3 : 2 * 60e3;
  if (Date.now() - loginTriedAt < gap) return;
  const t = (await bookTabs()).find((x) => x.book === 'gambit' && !/api/.test(new URL(x.url).hostname));
  if (!t) return say({ note: 'auto login: no Gambit tab open (open gambitodds.com in Chrome)' });
  if (t.discarded) return;
  if (!chrome.debugger) return say({ ok: false, why: 'the extension is missing the "debugger" permission: reload it in chrome://extensions' });
  loginBusy = true;
  const done = (ok, msg) => {
    lastLogin = { at: Date.now(), ok, why: msg };
    loginFails = ok ? 0 : loginFails + 1;
    say({ ok, why: msg });
  };
  const target = { tabId: t.id };
  let attached = false;
  try {
    let first = await inPage(t.id, false);
    if (first.state === 'no-page') return say({ note: `auto login: couldn't read the Gambit tab (${why}); trying again shortly` });
    if (first.state === 'logged-in') {
      const refused = gambitRefused >= 5 || /app found|refused|HTTP 40/.test(why);
      if (!refused) return;
      // The page still looks logged in but Gambit refuses its login. First a reload (it may renew).
      // If the tab was already reloaded and it still looks logged in, its saved login is dead: open
      // Gambit's home page, where the Login button is, and log in from there.
      const sinceReload = Date.now() - (reloadedAt.gambit || 0);
      if (sinceReload > 10 * 60e3) {
        if (await reloadTab('gambit', `Gambit refused the login (${why})`)) say({ note: 'auto login: Gambit tab still looks logged in, reloaded it first; logging in after that if needed' });
        return;
      }
      if (sinceReload < 10e3) return;     // the reload is still loading; the after-reload check runs soon
      loginTriedAt = Date.now();
      say({ start: true, why: `${why}; the Gambit tab still looks logged in after a reload, so opening Gambit's home page to log in` });
      first = await openWelcome(t.id);
      if (first.state === 'logged-in') {
        // Gambit's home page still thinks we're logged in: log out the dead login, then log in.
        const lo = (await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: clickLogout }).catch(() => []))[0]?.result;
        if (lo) { await sleep(3000); first = await inPage(t.id, false).catch(() => ({ state: 'no-page' })); }
        if (first.state !== 'logged-out') return done(false, `Gambit's home page shows no Login button${lo ? ' even after pressing Log out' : ' and no Log out button'} (page: ${first.url || t.url}). Send Claude a screenshot of the Gambit tab`);
      }
    } else {
      loginTriedAt = Date.now();
      say({ start: true, why });
    }
    if (first.state !== 'logged-out' && first.state !== 'form') return done(false, `unexpected Gambit page (${first.state})`);
    const before = gambitAuth;
    const f = await inPage(t.id, true);
    if (f.state !== 'form' || !f.pass) return done(false, f.state === 'no-form' ? 'clicked Login but no login box showed up' : `couldn't find the login box (${f.state})`);
    if (f.captcha) return done(false, 'Gambit is showing a "are you a robot" check: log in by hand');
    await new Promise((res, rej) => chrome.debugger.attach(target, '1.3', () => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res())));
    attached = true;
    await dbgCmd(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    // A real click in the password box: Chrome now lets the page see what it filled in.
    await realClick(target, f.pass);
    await sleep(500);
    let g = await inPage(t.id, true);
    if (!g.passLen && g.user) {
      // Chrome didn't fill it on its own: click the email box and pick the saved login from Chrome's list.
      await realClick(target, g.user);
      await sleep(800);
      await realKey(target, 'ArrowDown', 'ArrowDown', 40);
      await sleep(300);
      await realKey(target, 'Enter', 'Enter', 13, '\r');
      await sleep(800);
      g = await inPage(t.id, true);
    }
    if (g.state !== 'form') {
      // Picking the login with Enter can already submit it.
      if (g.state === 'logged-in') return done(true, 'logged back in to Gambit with Chrome\'s saved password');
      return done(false, `the login box closed unexpectedly (${g.state})`);
    }
    if (!g.passLen || !g.userLen) return done(false, `Chrome didn't fill in the saved ${!g.userLen ? 'email' : 'password'}. Check chrome://password-manager has a login for gambitodds.com`);
    if (!g.submit) return done(false, 'couldn\'t find the Login button in the login box');
    await realClick(target, g.submit);
    // Logged in when the page sends a new token or the login box goes away.
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      if (gambitAuth !== before && gambitTokenOk(gambitAuth)) return done(true, 'logged back in to Gambit with Chrome\'s saved password');
      const h = await inPage(t.id, false).catch(() => ({}));
      if (h.state === 'logged-in') return done(true, 'logged back in to Gambit with Chrome\'s saved password');
    }
    done(false, 'pressed Login but Gambit still shows the login box (wrong saved password, or Gambit wants a code)');
  } catch (e) {
    done(false, String(e?.message || e).includes('Another debugger') ? 'Chrome DevTools is open on the Gambit tab: close it' : `auto login failed: ${e?.message || e}`);
  } finally {
    if (attached) chrome.debugger.detach(target, () => void chrome.runtime.lastError);
    loginBusy = false;
    // Logged in from the home page: go back to the Gambit page you had open, so it keeps renewing the login.
    if (lastLogin?.ok && Date.now() - lastLogin.at < 30e3 && gambitHomeUrl) {
      setTimeout(async () => {
        const g = (await bookTabs()).find((x) => x.id === t.id);
        if (g && /\/welcome/.test(g.url || '')) chrome.tabs.update(t.id, { url: gambitHomeUrl }).catch(() => {});
      }, 4000);
    }
  }
}

let ws = null;
let status = 'disconnected';

const bookFor = (url) => {
  try {
    const h = new URL(url).hostname;
    return Object.keys(BOOK_HOSTS).find((b) => BOOK_HOSTS[b].some((re) => re.test(h)));
  } catch { return undefined; }
};

async function bookTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({ id: t.id, book: bookFor(t.url || ''), url: t.url, discarded: t.discarded, autoDiscardable: t.autoDiscardable })).filter((t) => t.book);
}

// Logouts come from the sites' own timers stopping: Gambit refreshes its token about hourly and
// Hard Rock every 10 seconds (its token lasts 28 minutes), but only while the tab's page is
// running. Chrome's Memory Saver unloads ("discards") tabs you haven't looked at in a while,
// which stops those timers. So: never let Chrome discard these tabs, and reload any it already did.
async function keepTabsLoaded() {
  for (const t of await bookTabs()) {
    if (t.autoDiscardable !== false) chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
    if (t.discarded) reloadTab(t.book, 'Chrome had unloaded the tab');
  }
}

// A reload lets the site renew its login from its cookies. Never while a bet is being sent from
// that tab (the reply would be lost), and at most once every 5 minutes per site.
const placing = {};      // book -> bets being sent from its tab right now
const reloadedAt = {};   // book -> ms
let lastReload = null;
let gambitRefused = 0;   // Gambit polls refused in a row
async function reloadTab(book, why) {
  if (placing[book] > 0 || Date.now() - (reloadedAt[book] || 0) < 5 * 60e3) return false;
  const t = (await bookTabs()).find((x) => x.book === book);
  if (!t) return false;
  reloadedAt[book] = Date.now();
  lastReload = { book, why, at: Date.now() };
  chrome.tabs.reload(t.id).catch(() => {});
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'reloaded', book, why }));
  // If the reload lands on Gambit's logged-out home page, log back in with Chrome's saved password.
  if (book === 'gambit') setTimeout(() => autoLoginGambit('after reloading the Gambit tab').catch(() => {}), 12e3);
  return true;
}

// Hard Rock logs you out after about 30 minutes with no mouse or keyboard use in its tab, even
// while its page keeps renewing the login (Austin's test, 2026-11-20: clicking around every 10
// minutes kept it logged in past 50 minutes). So every few minutes we give each site's tab a
// small, harmless sign of use: the pointer moves and Shift is tapped. Nothing is clicked or typed.
const NUDGE_MS = 4 * 60e3;
const NUDGE_BOOKS = ['hardrock', 'gambit'];
const nudgedAt = {};
function nudgePage() {
  const x = 40 + Math.round(Math.random() * 300), y = 40 + Math.round(Math.random() * 200);
  const targets = [window, document, document.body, document.elementFromPoint(x, y)].filter(Boolean);
  const mouse = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y + 80, view: window };
  for (const t of targets) {
    for (const type of ['pointermove', 'mousemove']) t.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, mouse));
    for (const type of ['keydown', 'keyup']) t.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'Shift', code: 'ShiftLeft', shiftKey: type === 'keydown' }));
  }
  window.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('focus'));
  return true;
}
async function nudgeTabs() {
  for (const t of await bookTabs()) {
    if (!NUDGE_BOOKS.includes(t.book) || t.discarded || Date.now() - (nudgedAt[t.id] || 0) < NUDGE_MS) continue;
    nudgedAt[t.id] = Date.now();
    chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: nudgePage }).catch(() => {});
  }
}

// Every 30 seconds: is each site still renewing its own login? If not, its page has stalled.
async function watchLogins() {
  await keepTabsLoaded();
  await nudgeTabs();
  const now = Date.now() / 1000;
  // A token that ran out over 10 minutes ago means reloading didn't bring the login back: you're
  // really logged out, so stop reloading (the app keeps alerting until you log in).
  // Gambit: only once its token has been out for a minute with no new one from the page. Reloading
  // earlier can land while the page is renewing its own login and knock it out.
  await rememberGambitPage().catch(() => {});
  // Gambit's tab sitting on its logged-out home page: log back in.
  if (settings.gambitAutoLogin && !loginBusy && (await bookTabs()).some((t) => t.book === 'gambit' && /gambitodds\.com\/welcome/.test(t.url || ''))) autoLoginGambit('the Gambit tab is on its logged-out home page').catch(() => {});
  const gExp = jwtExp(gambitAuth);
  if (gExp && now - gExp > 60 && now - gExp < 600) reloadTab('gambit', 'its login token ran out and the page hasn\'t renewed it');
  const fExp = jwtExp(fdAuth.auth);
  if (fExp && now - fExp > 60 && now - fExp < 600) reloadTab('fanduel', 'its login token ran out and the page hasn\'t renewed it');
  if (hrAuth.session && hrAuth.sessionAt && Date.now() - hrAuth.sessionAt > 4 * 60e3) {
    const exp = jwtExp(hrAuth.session);
    if (!exp || now - exp < 600) reloadTab('hardrock', exp && exp < now ? 'its login token ran out' : 'the page stopped renewing its login (it normally does every 10 seconds)');
  }
}

// Loud alert from the app (a site is logged out): a Windows/Mac notification that stays up until
// you close it, and a red "!" on the extension's icon.
let alertText = '';
function showAlert(m) {
  alertText = m.text || '';
  chrome.action?.setBadgeBackgroundColor?.({ color: '#d00' });
  chrome.action?.setBadgeText?.({ text: '!' });
  chrome.action?.setTitle?.({ title: `EV Placer: ${alertText}` });
  chrome.notifications?.create(`ev-${m.book || 'app'}`, {
    type: 'basic', iconUrl: ICON, title: m.title || 'EV Placer: logged out', message: alertText,
    priority: 2, requireInteraction: true,
  }, () => void chrome.runtime.lastError);
}
function clearAlert(m) {
  chrome.notifications?.clear(`ev-${m.book || 'app'}`, () => void chrome.runtime.lastError);
  if (m.all !== false) { alertText = ''; chrome.action?.setBadgeText?.({ text: '' }); chrome.action?.setTitle?.({ title: 'EV Placer Bridge' }); }
}
// A plain red square (notifications need an icon).
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALUlEQVR4nO3OIQEAAAjAsPdPRyOIgZmYX1P7KQEBAQEBAQEBAQEBAQEBge/AASEqPGpTs7PIAAAAAElFTkSuQmCC';

async function sendTabs() {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'tabs', tabs: (await bookTabs()).map(({ id, book }) => ({ id, book })) }));
}

// Runs in the page (MAIN world). Must be self-contained.
async function pageFetch(req) {
  try {
  const headers = { ...(req.headers || {}) };
  // Optional: copy auth headers the site keeps in localStorage/sessionStorage.
  for (const [h, spec] of Object.entries(req.storageHeaders || {})) {
    const store = spec.session ? sessionStorage : localStorage;
    let v = store.getItem(spec.key);
    if (v && spec.jsonPath) { try { v = spec.jsonPath.split('.').reduce((o, k) => o?.[k], JSON.parse(v)); } catch {} }
    if (v) headers[h] = (spec.prefix || '') + v;
  }
  const res = await fetch(req.url, {
    method: req.method || 'GET',
    headers,
    body: req.body == null ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    credentials: 'include',
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: json ? undefined : text.slice(0, 2000) };
  } catch (e) { return { status: 0, error: `in-tab request failed: ${e?.message || e}` }; }
}

// Same request made by the extension itself (it has permission for these sites, so the
// browser's cross-site rules don't block it). Used for Gambit, and as a fallback.
async function extFetch(req) {
  try {
    const res = await fetch(req.url, {
      method: req.method || 'GET', headers: req.headers || {}, credentials: 'include',
      body: req.body == null ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text: json ? undefined : text.slice(0, 2000) };
  } catch (e) { return { status: 0, error: `extension request failed: ${e?.message || e}` }; }
}

async function runInTab(tabId, request) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageFetch, args: [request] });
  if (!r || r.result === undefined) return { error: 'could not run in that tab (reload the tab and try again)' };
  return r.result;
}

async function handle(msg) {
  const reply = (o) => ws?.readyState === 1 && ws.send(JSON.stringify({ id: msg.id, ...o }));
  try {
    const { armed = false } = await chrome.storage.local.get('armed');
    if (msg.request.kind === 'place' && !armed) return reply({ error: 'extension is DISARMED (open the popup to arm)' });
    if (msg.request.kind === 'place') placing[msg.book] = (placing[msg.book] || 0) + 1;
    const matches = (await bookTabs()).filter((t) => t.book === msg.book);
    const tab = matches.find((t) => /^https:\/\/(www\.)?[^/]+\/?/.test(t.url || '') && !/api/.test(new URL(t.url).hostname)) || matches[0];
    if (!tab) return reply({ error: msg.book === 'gambit' ? 'no open Gambit tab (open gambitodds.com and log in)' : `no open ${msg.book} tab` });
    if (msg.request.useKambiAuth) {
      if (!kambiAuth) return reply({ error: 'BetRivers login token not seen yet: in the BetRivers tab, click any odds once (adds it to the slip), then remove it' });
      msg.request.headers = { ...(msg.request.headers || {}), authorization: kambiAuth };
    }
    if (msg.request.useRsiAuth) {
      if (!rsiAuth) return reply({ error: 'BetRivers login not seen yet: refresh the BetRivers tab (stay logged in)' });
      msg.request.headers = { ...(msg.request.headers || {}), 'x-auth-token': rsiAuth };
    }
    if (msg.request.useHardRockAuth) {
      if (!hrAuth.session) return reply({ error: 'Hard Rock login not seen yet: refresh the Hard Rock tab (stay logged in)' });
      const needsGeo = String(msg.request.body).includes('{{hrGeo}}');
      if (needsGeo && !hrAuth.geo) return reply({ error: 'Hard Rock location check not seen yet: place one small bet by hand in the Hard Rock tab first' });
      const acct = hrAccountId(hrAuth.session);
      if (!acct) return reply({ error: 'Hard Rock login token unreadable: refresh the Hard Rock tab' });
      const enc = encodeURIComponent;
      msg.request.body = String(msg.request.body)
        .replaceAll('{{hrSessionToken}}', enc(hrAuth.session))
        .replaceAll('{{hrGeo}}', enc(hrAuth.geo || ''))
        .replaceAll(enc('{{hrAccountId}}'), acct);
      // Some Hard Rock requests (My Bets) also carry the login token as a header.
      for (const [h, v] of Object.entries(msg.request.headers || {})) {
        if (typeof v === 'string' && v.includes('{{hrSessionToken}}')) msg.request.headers[h] = v.replaceAll('{{hrSessionToken}}', hrAuth.session);
        if (typeof v === 'string' && v.includes('{{hrCsrf}}')) msg.request.headers[h] = v.replaceAll('{{hrCsrf}}', hrCsrf(hrAuth.session));
      }
    }
    if (msg.request.useFanDuelAuth) {
      const tok = fdAuth.auth;
      if (!tok) return reply({ error: 'FanDuel login not seen yet: refresh the FanDuel tab (stay logged in)' });
      msg.request.headers['x-authentication'] = tok;
      if (msg.request.headers['x-geo-packet'] === '{{fdGeo}}') {
        // Newest location check: the one the page last received, or the one its last bet sent.
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: readFdGeo }).catch(() => []);
        const geo = [r?.result, fdAuth.geo].filter(Boolean).sort((a, b) => fdGeoExp(b) - fdGeoExp(a))[0];
        if (!geo || fdGeoExp(geo) < Date.now() + 15e3) return reply({ error: geo ? 'FanDuel location check ran out (it lasts 20 minutes): reload the FanDuel tab, or place one small bet by hand' : 'FanDuel location check not seen yet: reload the FanDuel tab (the FanDuel location app must be running), or place one small bet by hand' });
        msg.request.headers['x-geo-packet'] = geo;
      }
    }
    if (msg.request.useGambitAuth) {
      if (!gambitAuth) return reply({ error: 'no Gambit login seen yet: refresh your Gambit tab' });
      msg.request.headers = { ...(msg.request.headers || {}), authorization: gambitAuth };
    }
    // Gambit: fetch from the extension first (no page involved), then from inside the tab.
    // If Gambit refuses the token, try the other recent ones before giving up on this poll.
    if (msg.book === 'gambit') {
      const refused = (r) => r.status === 401 || r.status === 403;
      let a = await extFetch(msg.request);
      while (a.status === 401 && msg.request.headers.authorization === gambitAuth && dropGambitToken(gambitAuth)) {
        msg.request.headers.authorization = gambitAuth;
        a = await extFetch(msg.request);
      }
      if (!a.error && a.status && a.status < 400) { gambitRefused = 0; return reply(a); }
      const b = await runInTab(tab.id, msg.request);
      if (!b.error && b.status && b.status < 400) { gambitRefused = 0; return reply(b); }
      // Refused over and over (about 20s of polls): the page's login has stalled, a reload renews it.
      if (refused(a) && ++gambitRefused >= 10) reloadTab('gambit', `Gambit answered HTTP ${a.status} ${gambitRefused} times in a row (login not accepted)`);
      if (!b.error && b.status) return reply(b);
      return reply({ error: `Gambit: ${a.error || `HTTP ${a.status}`}; ${b.error || `HTTP ${b.status}`}` });
    }
    const r = await runInTab(tab.id, msg.request);
    if (r.error) return reply({ error: r.error });
    reply(r);
  } catch (e) { reply({ error: String(e?.message || e) }); }
  finally { if (msg.request?.kind === 'place') placing[msg.book] = Math.max(0, (placing[msg.book] || 1) - 1); }
}

function connect() {
  try { ws = new WebSocket(`ws://127.0.0.1:${PORT}`); } catch { return setTimeout(connect, 3000); }
  ws.onopen = () => { status = 'connected'; ws.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version })); sendTabs(); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'fetch') handle(m);
    else if (m.type === 'reload') chrome.runtime.reload(); // engine updated these files on disk
    else if (m.type === 'alert') showAlert(m);
    else if (m.type === 'clearAlert') clearAlert(m);
    else if (m.type === 'reloadTab') reloadTab(m.book, m.why || 'the app found it logged out');
    else if (m.type === 'login' && m.book === 'gambit') autoLoginGambit(m.why || 'the app found it logged out').catch(() => {});
    else if (m.type === 'settings') { settings = { ...settings, ...m.settings }; chrome.storage.local.set({ settings }).catch(() => {}); }
  };
  ws.onclose = () => { status = 'disconnected'; ws = null; setTimeout(connect, 3000); };
  ws.onerror = () => {};
}

chrome.tabs.onUpdated.addListener(sendTabs);
chrome.tabs.onCreated.addListener(() => keepTabsLoaded());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === 'complete') keepTabsLoaded(); });
chrome.tabs.onRemoved.addListener(sendTabs);
chrome.runtime.onMessage.addListener((m, _s, respond) => {
  if (m === 'status') { bookTabs().then((tabs) => respond({ status, tabs, gambitLogin: !!gambitAuth, betriversLogin: !!kambiAuth, hardrockLogin: !!hrAuth.session, hardrockGeo: hrAuth.geoAt || 0,
    fanduelExp: jwtExp(fdAuth.auth), fanduelGeoExp: fdGeoExp(fdAuth.geo),
    gambitExp: jwtExp(gambitAuth), hardrockAt: hrAuth.sessionAt || 0, alert: alertText, lastReload, lastLogin, autoLogin: settings.gambitAutoLogin })); return true; }
});
// Keep the service worker alive while the engine runs.
chrome.alarms?.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(() => { if (!ws) connect(); else sendTabs(); watchLogins().catch(() => {}); });
connect();
keepTabsLoaded();
