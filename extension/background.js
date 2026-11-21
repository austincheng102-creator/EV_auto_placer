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
  const gExp = jwtExp(gambitAuth);
  if (gExp && now - gExp > 60 && now - gExp < 600) reloadTab('gambit', 'its login token ran out and the page hasn\'t renewed it');
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
    // The app's own Gambit login (gambit.login in config.json) doesn't need a Gambit tab.
    const ownGambit = msg.book === 'gambit' && msg.request.noTab;
    if (!tab && !ownGambit) return reply({ error: msg.book === 'gambit' ? 'no open Gambit tab (open gambitodds.com and log in)' : `no open ${msg.book} tab` });
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
      if (ownGambit) return reply(a.error ? { error: `Gambit: ${a.error}` } : a);   // the app handles its own login
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
  ws.onopen = () => { status = 'connected'; sendTabs(); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'fetch') handle(m);
    else if (m.type === 'reload') chrome.runtime.reload(); // engine updated these files on disk
    else if (m.type === 'alert') showAlert(m);
    else if (m.type === 'clearAlert') clearAlert(m);
    else if (m.type === 'reloadTab') reloadTab(m.book, m.why || 'the app found it logged out');
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
    gambitExp: jwtExp(gambitAuth), hardrockAt: hrAuth.sessionAt || 0, alert: alertText, lastReload })); return true; }
});
// Keep the service worker alive while the engine runs.
chrome.alarms?.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(() => { if (!ws) connect(); else sendTabs(); watchLogins().catch(() => {}); });
connect();
keepTabsLoaded();
