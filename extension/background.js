// Connects to the local engine (ws://127.0.0.1:8765) and executes requests inside the
// matching sportsbook tab, in the page's own context, so the site's cookies and
// session headers apply exactly as when you click "Place bet" yourself.
const PORT = 8765;
const BOOK_HOSTS = {
  betrivers: [/\.betrivers\.(ca|com)$/],
  fanduel: [/sportsbook\.fanduel\.(com|ca)$/],
  hardrock: [/(^|\.)hardrock\.bet$/, /(^|\.)hardrocksportsbook\.com$/],
  betmgm: [/(^|\.)betmgm\.com$/],
  draftkings: [/^sportsbook\.draftkings\.com$/],
  thescore: [/^sportsbook\.thescore\.bet$/],
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

// The page gets that token by logging in to Kambi itself: it asks co.betrivers.com for a one-time
// ticket (gamelaunch), then sends it to Kambi's punter/login, which answers with the token.
// The token it hands us can stop working (Kambi ends it, the page logs in again, or the one we
// kept on disk is from an older session), and the page only sends a new one when you touch the
// bet slip. So we keep what the page sends to punter/login (account id, market, device hash)
// and, when Kambi turns our token down, log in the same way ourselves to get a fresh one.
let kambiLogin = null;   // { url, body } of the page's last punter/login (ticket left out)
let kambiPunter = null;  // "<cageCode>-<playerId>", from the site's own requests, as a fallback
store.get(['kambiLogin', 'kambiPunter']).then((v) => {
  if (v?.kambiLogin && !kambiLogin) kambiLogin = v.kambiLogin;
  if (v?.kambiPunter && !kambiPunter) kambiPunter = v.kambiPunter;
});
chrome.webRequest.onBeforeRequest.addListener((d) => {
  const raw = d.requestBody?.raw?.[0]?.bytes;
  if (!raw) return;
  try {
    const { ticket, ...body } = JSON.parse(new TextDecoder().decode(raw));
    if (body?.punterId) { kambiLogin = { url: d.url, body }; kambiPunter = body.punterId; store.set({ kambiLogin, kambiPunter }); }
  } catch {}
}, { urls: ['https://*.kambicdn.org/*punter/login*'] }, ['requestBody']);
chrome.webRequest.onBeforeRequest.addListener((d) => {
  const q = new URL(d.url).searchParams, cage = q.get('cageCode'), id = q.get('cagePlayerId');
  if (cage && id && `${cage}-${id}` !== kambiPunter) { kambiPunter = `${cage}-${id}`; store.set({ kambiPunter }); }
}, { urls: ['https://*.betrivers.com/api/*cagePlayerId*'] });

let kambiRenewing = null, kambiRenewedAt = 0;
// Gets a fresh Kambi token the way the page does, from inside your logged-in BetRivers tab.
// reqUrl is the Kambi request that was turned down (tells us the host, brand and market).
function renewKambi(tab, reqUrl) {
  if (!kambiRenewing) kambiRenewing = (async () => {
    const punterId = kambiLogin?.body?.punterId || kambiPunter;
    if (!punterId) return { error: 'BetRivers account id not seen yet: reload the BetRivers tab once (stay logged in)' };
    const origin = new URL(tab.url).origin;
    const u = new URL(reqUrl);
    const market = u.searchParams.get('market') || kambiLogin?.body?.market || `US-${new URL(origin).hostname.split('.')[0].toUpperCase()}`;
    const g = await runInTab(tab.id, {
      method: 'GET', url: `${origin}/api/service/gamelaunch/providers/KAMBI/games/sportsbook/launch?gameMode=REAL&channel=DESKTOP&clientType=HTML&cageCode=${String(punterId).split('-')[0]}&t=${Date.now()}`,
      headers: { accept: 'application/json, text/plain, */*', ...(rsiAuth ? { 'x-auth-token': rsiAuth } : {}) },
    });
    const ticket = g.json?.token;
    if (!ticket) return { error: `BetRivers wouldn't give a sportsbook ticket (${g.error || `HTTP ${g.status}`}): check you're logged in in the BetRivers tab` };
    const loginUrl = kambiLogin?.url || `${u.origin}${u.pathname.replace(/(\/player\/api\/v\d+\/[^/]+\/).*$/, '$1')}punter/login.json?market=${encodeURIComponent(market)}&lang=en_US&channel_id=1&client_id=200&settings=true`;
    const l = await runInTab(tab.id, {
      method: 'POST', url: loginUrl, headers: { accept: '*/*', 'content-type': 'application/json' },
      body: { requestStreaming: true, channel: 'WEB', market, ...(kambiLogin?.body || {}), punterId, ticket },
    });
    const token = l.json?.token;
    if (!token) return { error: `BetRivers sportsbook login failed (${l.error || `HTTP ${l.status}`} ${JSON.stringify(l.json ?? l.text ?? '').slice(0, 120)})` };
    // Same form as the header the page sends ("Bearer <token>").
    const prefix = kambiAuth && /\s/.test(kambiAuth.trim()) ? kambiAuth.trim().replace(/\S+$/, '') : 'Bearer ';
    kambiAuth = prefix + token;
    kambiRenewedAt = Date.now();
    store.set({ kambiAuth });
    return { ok: true };
  })().catch((e) => ({ error: `BetRivers sportsbook login failed: ${e?.message || e}` })).finally(() => { kambiRenewing = null; });
  return kambiRenewing;
}
const kambiRefused = (r) => r && !r.error && (r.status === 401 || r.json?.validSession === false);

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

// BetMGM: its bet requests carry an x-xsrf-token header (the page's anti-forgery token, tied to
// your login cookies). We keep the newest one your BetMGM tab sent; the login itself is the
// tab's cookies, which the in-tab request uses on its own.
// The page's sports requests (bets included) also carry headers that HAR exports may leave out or
// that the app didn't send (authorization, x-device-type, x-bwin-browser-url, ...). BetMGM refused
// every app bet with SessionTokenInvalid while bets placed by hand went through (Austin, 2026-11-23),
// so the newest values of these are kept too and added to the app's BetMGM requests, as for theScore.
let bmAuth = { xsrf: null, at: 0, headers: {} };
store.get('bmAuth').then((v) => { if (v?.bmAuth && !bmAuth.xsrf) bmAuth = { headers: {}, ...v.bmAuth }; });
const BM_SKIP = /^(x-xsrf-token|x-datadog-)/;
const bmKeep = (n) => n === 'authorization' || n === 'x-device-type' || (/^x-/.test(n) && !BM_SKIP.test(n));
chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  const hs = d.requestHeaders || [];
  const x = hs.find((h) => h.name.toLowerCase() === 'x-xsrf-token')?.value;
  let changed = false;
  if (x && x !== bmAuth.xsrf) { bmAuth = { ...bmAuth, xsrf: x }; changed = true; }
  if (x) bmAuth.at = Date.now();
  // The page's sports requests (the app's own carry the same copied values, so they change nothing).
  if (d.tabId >= 0 && /\/sports\/api\//.test(d.url)) {
    for (const h of hs) {
      const n = h.name.toLowerCase();
      if (bmKeep(n) && h.value && bmAuth.headers?.[n] !== h.value) { bmAuth.headers = { ...(bmAuth.headers || {}), [n]: h.value }; changed = true; }
    }
  }
  if (changed) store.set({ bmAuth });
}, { urls: ['https://*.betmgm.com/*'] }, ['requestHeaders', 'extraHeaders']);

// theScore: its own requests may carry an authorization header and a device id (x-install-id)
// next to the login cookies (HAR exports leave these out, so they can't be seen there). We keep the
// newest ones your theScore tab sent and add them to the app's requests, so they match the site's.
let tsAuth = { headers: {}, at: 0 };
store.get('tsAuth').then((v) => { if (v?.tsAuth && !tsAuth.at) tsAuth = v.tsAuth; });
const TS_KEEP = ['authorization', 'x-install-id', 'x-dma', 'x-anonymous-authorization', 'x-auth-token'];
chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  if (d.tabId < 0) return;   // only the page's own requests
  const got = {};
  for (const h of d.requestHeaders || []) if (TS_KEEP.includes(h.name.toLowerCase()) && h.value) got[h.name.toLowerCase()] = h.value;
  if (!Object.keys(got).length) return;
  const next = { ...tsAuth.headers, ...got };
  if (JSON.stringify(next) !== JSON.stringify(tsAuth.headers)) { tsAuth = { headers: next, at: Date.now() }; store.set({ tsAuth }); }
  else tsAuth.at = Date.now();
}, { urls: ['https://*.thescore.bet/graphql/*'] }, ['requestHeaders', 'extraHeaders']);

// fd-geo.js / br-geo.js have to be in the FanDuel / BetRivers page from the start to see their
// location checks.
async function registerGeoScripts() {
  const want = [
    { id: 'fd-geo', js: ['fd-geo.js'], matches: ['https://*.sportsbook.fanduel.com/*'] },
    { id: 'br-geo', js: ['br-geo.js'], matches: ['https://*.betrivers.com/*'] },
    { id: 'mgm-geo', js: ['mgm-geo.js'], matches: ['https://*.betmgm.com/*'] },
    { id: 'ts-geo', js: ['ts-geo.js'], matches: ['https://sportsbook.thescore.bet/*'] },
  ];
  for (const s of want) {
    try {
      const have = await chrome.scripting.getRegisteredContentScripts({ ids: [s.id] });
      if (have.length) continue;
      await chrome.scripting.registerContentScripts([{ ...s, runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true }]);
    } catch {}
  }
}
registerGeoScripts();
const readFdGeo = () => { try { return sessionStorage.getItem('evPlacerFdGeo'); } catch { return null; } };

// ---- FanDuel location check: renew it before it runs out ----
// FanDuel's location check (GeoComply) lasts 20 minutes. The page runs one when you log in, and
// doesn't reliably run a new one by itself after that: a bet was refused because it had run out,
// and (v0.7.6, 2026-11-22) a plain reload of the tab didn't make it run one either. So when the
// newest one has under 5 minutes left, we try these in order until the page gets a fresh one,
// and remember which one worked to start with it next time:
//   1. reload the FanDuel tab;
//   2. clear the page's saved (old) location check, tell the page its tab is in view (fd-geo.js;
//      Chrome tells background tabs they're hidden and some sites hold off until you look), reload;
//   3. bring the FanDuel tab to the front of its window, reload, then go back to the tab you had.
// Never while a FanDuel bet is being sent. Off with config.json "session": {"fanduelGeoRenew": false}.
const FD_GEO_RENEW_MS = 5 * 60e3;   // renew when less than this is left
const FD_GEO_WAIT_MS = 40e3;        // how long each way waits for the page's new location check
const FD_STEPS = [
  { name: 'reloading the FanDuel tab' },
  { name: 'clearing its old location check, telling it the tab is in view and reloading', prep: 1 },
  { name: 'bringing the FanDuel tab to the front and reloading', prep: 1, front: true },
];
let fdGeoJob = null;                // the renewal running now (callers share it)
let fdGeoTriedAt = 0, fdGeoFails = 0;
let fdGeoLast = null;               // { at, ok, why } for the popup
let fdStep = 0;                     // the way that worked last time
chrome.storage.local.get('fdStep').then((v) => { if (Number.isInteger(v?.fdStep)) fdStep = v.fdStep; }).catch(() => {});
// What the page did, to say why a try didn't work: started a check (asked FanDuel for its
// settings), sent GeoComply's answer to FanDuel, and how FanDuel answered.
const fdSeen = { startAt: 0, sentAt: 0, sentStatus: 0 };
chrome.webRequest.onCompleted.addListener((d) => {
  if (d.method === 'OPTIONS') return;
  if (/initialization_parameters/.test(d.url)) fdSeen.startAt = Date.now();
  if (/jwt\/create/.test(d.url)) { fdSeen.sentAt = Date.now(); fdSeen.sentStatus = d.statusCode; }
}, { urls: ['https://api.fanduel.com/geolocation/*'] });
const fdNote = (text, level = 'warn') => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'note', book: 'fanduel', level, text })); };
const fdTab = async () => (await bookTabs()).find((t) => t.book === 'fanduel' && /(^|\.)sportsbook\.fanduel\.com$/.test(new URL(t.url).hostname) && !/^api\./.test(new URL(t.url).hostname));
// Newest location check we have: the one the page last received (fd-geo.js) or its last bet sent.
async function fdGeoNow(tabId) {
  const [r] = tabId ? await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readFdGeo }).catch(() => []) : [];
  const geo = [r?.result, fdAuth.geo].filter(Boolean).sort((a, b) => fdGeoExp(b) - fdGeoExp(a))[0] || null;
  if (geo && geo !== fdAuth.geo && fdGeoExp(geo) > fdGeoExp(fdAuth.geo)) { fdAuth = { ...fdAuth, geo }; store.set({ fdAuth }); }
  return geo;
}
const mins = (ms) => (ms >= 60e3 ? `${Math.round(ms / 60e3)} min` : `${Math.max(0, Math.round(ms / 1000))}s`);

// Runs in the FanDuel page before a reload: from now on tell the page its tab is in view
// (fd-geo.js reads this flag), and remove the location checks the page saved, so it has none
// and runs a new one, as when you log in. Only location-check tokens are removed; your login stays.
function fdPrepPage() {
  try { sessionStorage.setItem('evPlacerFdVisible', '1'); } catch {}
  const isGeo = (v) => {
    if (typeof v !== 'string' || !/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(v)) return false;
    try { const p = JSON.parse(atob(v.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return 'geolocate_in' in p || 'gc_transaction_id' in p; } catch { return false; }
  };
  // Takes out location-check tokens anywhere in a saved value (which may be JSON inside JSON).
  const scrub = (v, depth = 0) => {
    if (depth > 6) return [v, false];
    if (typeof v === 'string') {
      if (isGeo(v)) return [undefined, true];
      if (v.includes('eyJ') && /^[[{]/.test(v.trim())) { try { const [x, c] = scrub(JSON.parse(v), depth + 1); return c ? [JSON.stringify(x), true] : [v, false]; } catch {} }
      return [v, false];
    }
    if (v && typeof v === 'object') {
      let changed = false;
      for (const k of Object.keys(v)) {
        const [x, c] = scrub(v[k], depth + 1);
        if (c) { changed = true; if (x === undefined) { if (Array.isArray(v)) v[k] = null; else delete v[k]; } else v[k] = x; }
      }
      return [v, changed];
    }
    return [v, false];
  };
  const cleared = [];
  for (const [name, st] of [['local', localStorage], ['session', sessionStorage]]) {
    let keys = []; try { keys = Object.keys(st); } catch { continue; }
    for (const k of keys) {
      if (/^evPlacer/.test(k)) continue;
      try {
        const v = st.getItem(k);
        if (!v || !v.includes('eyJ')) continue;
        const [x, c] = scrub(v);
        if (!c) continue;
        if (x === undefined) st.removeItem(k); else st.setItem(k, x);
        cleared.push(`${name}:${k}`);
      } catch {}
    }
  }
  return cleared;
}

// One way of getting the page to run its location check. Answers { ok, geo, why }.
async function fdTryStep(t, step, before) {
  const seen0 = { ...fdSeen };
  let cleared = [], back = null;
  if (step.prep) cleared = (await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: fdPrepPage }).catch(() => []))[0]?.result || [];
  if (step.front) {
    const tab = await chrome.tabs.get(t.id).catch(() => null);
    const win = tab && await chrome.windows.get(tab.windowId).catch(() => null);
    const [cur] = tab ? await chrome.tabs.query({ active: true, windowId: tab.windowId }) : [];
    back = { tabId: cur && cur.id !== t.id ? cur.id : null, windowId: tab?.windowId, minimized: win?.state === 'minimized' };
    await chrome.tabs.update(t.id, { active: true }).catch(() => {});
    if (tab) await chrome.windows.update(tab.windowId, { focused: true, ...(back.minimized ? { state: 'normal' } : {}) }).catch(() => {});
  }
  reloadedAt.fanduel = Date.now();
  lastReload = { book: 'fanduel', why: `renew the location check: ${step.name}`, at: Date.now() };
  await chrome.tabs.reload(t.id).catch(() => {});
  const start = Date.now();
  let res = null;
  try {
    while (Date.now() - start < FD_GEO_WAIT_MS) {
      await sleep(2000);
      const geo = await fdGeoNow(t.id);
      const exp = fdGeoExp(geo);
      if (geo && exp > before && exp > Date.now() + FD_GEO_RENEW_MS) { res = { ok: true, geo, why: `${step.name}, after ${Math.round((Date.now() - start) / 1000)}s, good for ${mins(exp - Date.now())}` }; break; }
    }
  } finally {
    if (back?.tabId) await chrome.tabs.update(back.tabId, { active: true }).catch(() => {});
    if (back?.minimized) await chrome.windows.update(back.windowId, { state: 'minimized' }).catch(() => {});
  }
  if (res) return res;
  const why = fdSeen.sentAt > seen0.sentAt
    ? (fdSeen.sentStatus >= 400 ? `FanDuel turned down the page's location check (HTTP ${fdSeen.sentStatus})` : 'the page got a location check but the extension couldn\'t read it')
    : fdSeen.startAt > seen0.startAt ? 'the page started a location check but GeoComply never answered (is the FanDuel location app running on this PC?)'
    : 'the page didn\'t start a location check';
  return { ok: false, why: `${step.name}: ${why}${step.prep ? ` (cleared ${cleared.length ? cleared.join(', ') : 'nothing saved'})` : ''}` };
}

// Tries each way in turn, starting with the one that worked last time. Answers { ok, geo, why }.
function renewFdGeo(why, urgent = false) {
  if (fdGeoJob) return fdGeoJob;
  fdGeoJob = (async () => {
    // Every 2 minutes at most, every 10 after 3 failed rounds in a row (it keeps trying). A bet
    // that finds the check run out may start one 1 minute after the last.
    const gap = urgent ? 60e3 : fdGeoFails >= 3 ? 10 * 60e3 : 2 * 60e3;
    if (Date.now() - fdGeoTriedAt < gap) return { ok: false, why: fdGeoLast && !fdGeoLast.ok ? fdGeoLast.why : `last renewal try was ${mins(Date.now() - fdGeoTriedAt)} ago` };
    const t = await fdTab();
    if (!t) return { ok: false, why: 'no FanDuel tab open (open co.sportsbook.fanduel.com and log in)' };
    // Wait for any FanDuel bet being sent right now (a reload would lose its answer).
    for (let i = 0; i < 60 && placing.fanduel > 0; i++) await sleep(1000);
    if (placing.fanduel > 0) return { ok: false, why: 'a FanDuel bet was still being sent' };
    fdGeoTriedAt = Date.now();
    const before = fdGeoExp(await fdGeoNow(t.id));
    const first = Math.min(Math.max(0, fdStep), FD_STEPS.length - 1);
    const order = [first, ...FD_STEPS.keys()].filter((v, i, a) => a.indexOf(v) === i);
    const fails = [];
    for (const i of order) {
      fdNote(`renewing FanDuel's location check (${why}): ${FD_STEPS[i].name}`, 'info');
      const r = await fdTryStep(t, FD_STEPS[i], before);
      fdGeoTriedAt = Date.now();
      if (r.ok) {
        fdGeoFails = 0;
        if (fdStep !== i) { fdStep = i; chrome.storage.local.set({ fdStep }).catch(() => {}); }
        fdGeoLast = { at: Date.now(), ok: true, why: r.why };
        fdNote(`FanDuel location check renewed by ${r.why}`, 'good');
        return r;
      }
      fails.push(r.why);
      fdNote(`FanDuel location check not renewed by ${r.why}`);
    }
    fdGeoFails++;
    const msg = `none of the ${FD_STEPS.length} ways worked (${fails.join('; ')}). Are you logged in to FanDuel, and is the FanDuel location app (GeoComply) running on this PC?`;
    fdGeoLast = { at: Date.now(), ok: false, why: msg };
    fdNote(`FanDuel location check NOT renewed: ${msg} Trying again in ${fdGeoFails >= 3 ? 10 : 2} min`);
    return { ok: false, why: msg };
  })().finally(() => { fdGeoJob = null; });
  return fdGeoJob;
}

// Every 30 seconds (watchLogins): renew when under 5 minutes are left, while you're logged in.
async function keepFdGeo() {
  if (settings.fanduelGeoRenew === false || fdGeoJob) return;
  const exp = jwtExp(fdAuth.auth);
  if (!exp || exp < Date.now() / 1000 - 600) return;   // not logged in to FanDuel (or long since)
  const t = await fdTab();
  if (!t || t.discarded) return;
  const left = fdGeoExp(await fdGeoNow(t.id)) - Date.now();
  if (left > FD_GEO_RENEW_MS) return;
  renewFdGeo(left > 0 ? `it runs out in ${mins(left)}` : 'it had run out').catch(() => {});
}

// ---- BetRivers location check: renew it when it runs out ----
// BetRivers (Rush Street) only lets Kambi take your bets while your location check (Xpoint) is
// current. Each one lasts about 14.5 minutes; the Xpoint app on this PC makes a new one on that
// same schedule and the BetRivers page picks it up (it asks the app every 10s) and sends it to
// co.betrivers.com. Until it does, the site clears its SUCCESSFUL_GEOLOCATION flag and Kambi
// answers every bet with ACCOUNT_BLOCKED: that's the "account blocked" seen since 2026-11-11 (your
// account isn't blocked). A slow connection or Chrome slowing down the background tab makes that
// gap longer, or the page never sends a new one. br-geo.js keeps a copy of what the page receives.
// The real cause (2026-11-22, live): the Xpoint code in the page only asks the Xpoint app for a
// new check while the tab is in view, so a background BetRivers tab never picks one up, and a
// plain reload doesn't help either. Switching to the tab fixed it by hand. So the page is now
// always told its tab is in view (br-geo.js, and brShowVisible for a page already open). When a
// check lapses anyway: tell the page it's in view and wait; reload the tab; bring the tab to the
// front and reload (then back to the tab you had). A bet that finds it lapsed doesn't wait: it's
// checked again every scan until the new check is in. Every 30s, a check that ran out 90s+ ago
// with no new one gets the same treatment. Never reloads while a BetRivers bet is being sent.
// Off with config.json "session": {"betriversGeoRenew": false}.
const BR_GEO_STALE_MS = 90e3;     // ran out this long ago with no new one: renew (watchLogins)
let brGeo = {};                   // { status, expires, at, flag, flagAt } from br-geo.js
let brGeoJob = null, brGeoTriedAt = 0, brGeoFails = 0;
let brGeoLast = null;             // { at, ok, why } for the popup
let brBusyAt = 0;                 // last BetRivers bet / live-delay status request
store.get('brGeo').then((v) => { if (v?.brGeo && !brGeo.at) brGeo = v.brGeo; });
const brNote = (text, level = 'warn') => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'note', book: 'betrivers', level, text })); };
const brTab = async () => (await bookTabs()).find((t) => t.book === 'betrivers' && /(^|\.)betrivers\.com$/.test(new URL(t.url).hostname) && !/kambi|api/.test(new URL(t.url).hostname));
const readBrGeo = () => { try { return sessionStorage.getItem('evPlacerBrGeo'); } catch { return null; } };
async function brGeoNow(tabId) {
  const [r] = tabId ? await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readBrGeo }).catch(() => []) : [];
  let g = null; try { g = JSON.parse(r?.result || 'null'); } catch {}
  if (g && JSON.stringify(g) !== JSON.stringify(brGeo)) { brGeo = g; store.set({ brGeo }); }
  return brGeo;
}
// Good now: a check that hasn't run out, and the site hasn't cleared the flag or blocked a bet since.
const brGeoGood = (g, since = 0) => g.status === 'ALLOWED' && g.expires > Date.now() + 30e3 && (g.at || 0) > since
  && !((g.flag === 'cleared' || g.flag === 'blocked') && g.flagAt > g.at);
// A new check arrived after `since` (sent by the page, or the site set the flag again).
const brGeoNew = (g, since) => brGeoGood(g, since) || (g.flag === 'set' && g.flagAt > since && !(g.at > g.flagAt && g.status !== 'ALLOWED'));

// Runs in the BetRivers page: from now on tell the page its tab is in view. The Xpoint code in the
// page only asks the Xpoint app for a new check while the tab is in view (it skips its 10s check
// while document.hidden), so a background BetRivers tab never picks up the new check. br-geo.js
// does the same from page start; this covers a page loaded before the extension was updated.
function brShowVisible() {
  if (window.__evPlacerVisible) return false;
  window.__evPlacerVisible = true;
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
    Document.prototype.hasFocus = function () { return true; };
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  } catch {}
  return true;
}
const brVisible = (tabId) => chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: brShowVisible }).catch(() => []);

// Ways of getting a fresh check, in order (the one that worked last time goes first):
const BR_STEPS = [
  { name: 'telling the page its tab is in view and waiting for it', wait: 30e3 },
  { name: 'reloading the BetRivers tab', reload: true, wait: 45e3 },
  { name: 'bringing the BetRivers tab to the front and reloading', reload: true, front: true, wait: 45e3 },
];
let brStep = 0;
chrome.storage.local.get('brStep').then((v) => { if (Number.isInteger(v?.brStep)) brStep = v.brStep; }).catch(() => {});

// Why a try didn't work, from what br-geo.js saw the page do.
function brWhyNot(g, since) {
  if ((g.pkgAt || 0) > since) return g.pkgStatus && g.pkgStatus !== 'ALLOWED' ? `BetRivers answered the page's location check with ${g.pkgStatus}` : 'the page sent a location check but the extension couldn\'t read the answer';
  if ((g.xpAt || 0) > since) return `the Xpoint app answered ${g.xpStatus || 'nothing'}${g.xpStatus === 'ALLOWED' ? ' with the old check (it hasn\'t made a new one yet)' : ''} (is the Xpoint app running and signed in on this PC?)`;
  if ((g.xpErrAt || 0) > since) return `the page couldn't reach the Xpoint app on this PC (${g.xpErr || 'no answer'}): is it running?`;
  return 'the page didn\'t ask the Xpoint app for a check';
}

async function brTryStep(t, step) {
  const since = Date.now();
  let back = null;
  if (step.front) {
    const tab = await chrome.tabs.get(t.id).catch(() => null);
    const win = tab && await chrome.windows.get(tab.windowId).catch(() => null);
    const [cur] = tab ? await chrome.tabs.query({ active: true, windowId: tab.windowId }) : [];
    back = { tabId: cur && cur.id !== t.id ? cur.id : null, windowId: tab?.windowId, minimized: win?.state === 'minimized' };
    await chrome.tabs.update(t.id, { active: true }).catch(() => {});
    if (tab) await chrome.windows.update(tab.windowId, { focused: true, ...(back.minimized ? { state: 'normal' } : {}) }).catch(() => {});
  }
  if (step.reload) {
    reloadedAt.betrivers = Date.now();
    lastReload = { book: 'betrivers', why: `renew the location check: ${step.name}`, at: Date.now() };
    await chrome.tabs.reload(t.id).catch(() => {});
  } else await brVisible(t.id);
  let res = null;
  try {
    while (Date.now() - since < step.wait) {
      await sleep(2000);
      if (step.reload) await brVisible(t.id);   // in case br-geo.js didn't load with the page
      const g = await brGeoNow(t.id);
      if (brGeoNew(g, since)) {
        const left = g.expires > Date.now() ? `, good for ${mins(g.expires - Date.now())}` : '';
        res = { ok: true, why: `${step.name}, after ${Math.round((Date.now() - since) / 1000)}s${left}` };
        break;
      }
    }
  } finally {
    if (back?.tabId) await chrome.tabs.update(back.tabId, { active: true }).catch(() => {});
    if (back?.minimized) await chrome.windows.update(back.windowId, { state: 'minimized' }).catch(() => {});
  }
  return res || { ok: false, why: `${step.name}: ${brWhyNot(brGeo, since)}` };
}

// Tries each way in turn. Answers { ok, why }. urgent: a bet found it lapsed (shorter wait between tries).
function renewBrGeo(why, urgent = false) {
  if (brGeoJob) return brGeoJob;
  brGeoJob = (async () => {
    // Every 2 minutes at most (1 when a bet is waiting), every 10 after 3 failed rounds in a row
    // (it keeps trying).
    const gap = urgent ? 60e3 : brGeoFails >= 3 ? 10 * 60e3 : 2 * 60e3;
    if (Date.now() - brGeoTriedAt < gap) return { ok: false, why: brGeoLast && !brGeoLast.ok ? brGeoLast.why : `last renewal try was ${mins(Date.now() - brGeoTriedAt)} ago` };
    const t = await brTab();
    if (!t) return { ok: false, why: 'no BetRivers tab open (open co.betrivers.com and log in)' };
    brGeoTriedAt = Date.now();
    const first = Math.min(Math.max(0, brStep), BR_STEPS.length - 1);
    const order = [first, ...BR_STEPS.keys()].filter((v, i, a) => a.indexOf(v) === i);
    const fails = [];
    for (const i of order) {
      const step = BR_STEPS[i];
      if (step.reload) {
        // Wait for any BetRivers bet being sent or waiting on its live delay (a reload would lose its answer).
        for (let k = 0; k < 60 && (placing.betrivers > 0 || Date.now() - brBusyAt < 25e3); k++) await sleep(1000);
        if (placing.betrivers > 0 || Date.now() - brBusyAt < 25e3) { fails.push(`${step.name}: a BetRivers bet was still being sent`); continue; }
      }
      brNote(`renewing BetRivers' location check (${why}): ${step.name}`, 'info');
      const r = await brTryStep(t, step);
      brGeoTriedAt = Date.now();
      if (r.ok) {
        brGeoFails = 0;
        if (brStep !== i) { brStep = i; chrome.storage.local.set({ brStep }).catch(() => {}); }
        brGeoLast = { at: Date.now(), ok: true, why: r.why };
        brNote(`BetRivers location check renewed by ${r.why}`, 'good');
        return r;
      }
      fails.push(r.why);
      brNote(`BetRivers location check not renewed by ${r.why}`);
    }
    brGeoFails++;
    const msg = `none of the ${BR_STEPS.length} ways worked (${fails.join('; ')}). Are you logged in to BetRivers, and is the Xpoint location app running on this PC?`;
    brGeoLast = { at: Date.now(), ok: false, why: msg };
    brNote(`BetRivers location check NOT renewed: ${msg} Trying again in ${brGeoFails >= 3 ? 10 : 2} min`);
    return { ok: false, why: msg };
  })().catch((e) => ({ ok: false, why: String(e?.message || e) })).finally(() => { brGeoJob = null; });
  return brGeoJob;
}

// Every 30 seconds (watchLogins): keep the page told its tab is in view (so it picks up each new
// check by itself), and if the check ran out over 90s ago (or the site cleared the flag over 90s
// ago) with no new one, renew it before a bet runs into it.
async function keepBrGeo() {
  if (settings.betriversGeoRenew === false || !rsiAuth) return;
  const t = await brTab();
  if (!t || t.discarded) return;
  await brVisible(t.id);
  if (brGeoJob) return;
  const g = await brGeoNow(t.id);
  if (!g.at && !g.flagAt) return;   // nothing seen yet (br-geo.js starts with the next page load)
  if (brGeoGood(g)) return;
  const lapsedAt = Math.max(g.status === 'ALLOWED' ? g.expires || 0 : g.at || 0, (g.flag === 'cleared' || g.flag === 'blocked') ? g.flagAt : 0);
  if (g.flag === 'set' && g.flagAt > lapsedAt) return;
  if (!lapsedAt || Date.now() - lapsedAt < BR_GEO_STALE_MS) return;
  renewBrGeo(`it ran out ${mins(Date.now() - lapsedAt)} ago and the page hasn't sent a new one`).catch(() => {});
}
// ---- BetMGM and theScore location checks: keep them current ----
// Both pages run their own location check (GeoComply) and learn when it runs out:
//  - BetMGM: its location server answers "update" with timeForNextCall (about 19.5 min).
//  - theScore: GeoComplyAuthorizeGeoPacket answers expiresAt (20 min) and refreshAt.
// mgm-geo.js / ts-geo.js keep a copy ({ updateAt: last good check, nextAt: when it runs out or the
// next one is due, status }). In a background tab the pages didn't always run the next one, and bets
// were refused (BetMGM SessionTokenInvalid, theScore "We need to verify your location", Austin,
// 2026-11-23). So: each page is always told its tab is in view, and when the check runs out within
// 90s (or has, or the last answer was bad, or a bet was refused for it) the tab is reloaded, which
// makes the page run a fresh check at once. If a reload doesn't bring one within 45s, the next try
// brings the tab to the front first (then goes back to your tab). Never while one of that book's bets
// is being sent or waiting on its live delay; its bets are held (not sent) while it renews.
// Off with config.json "session": {"betmgmGeoRenew": false} / {"thescoreGeoRenew": false}.
const GEO_RENEW_BEFORE_MS = 90e3;
// A new check since `since`: a new answer with an expiry, or the location server saying the location
// is valid (BetMGM's locationInfostatus VALID_LOCATION).
const fresh = (g, since) => (g.updateAt || 0) > since || ((g.statusAt || 0) > since && /^(VALID|OK)/i.test(String(g.status || '')));
const readPageGeo = (key) => { try { return sessionStorage.getItem(key); } catch { return null; } };
// Removes the page's own saved location check (storage keys matching `pattern`, never the extension's
// own evPlacer* copy), so the reload runs a new one instead of reusing the saved one. Returns the keys removed.
const clearPageGeo = (pattern) => {
  const out = [], re = new RegExp(pattern, 'i');
  for (const st of [localStorage, sessionStorage]) {
    try { for (const k of Object.keys(st)) if (re.test(k) && !/^evPlacer/.test(k)) { st.removeItem(k); out.push(k); } } catch {}
  }
  return out;
};
const dbgBusy = new Set();   // tab ids the extension is clicking in (one job per tab at a time)
// Runs in the BetMGM page. mode 'find': picks one odds button (not on the bet slip, not already
// picked), marks it, scrolls it into view and says where it is. mode 'state': where the marked one is
// now and whether it's picked.
function mgmOddsPick(mode) {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const picked = (el) => /(^|[\s-])(selected|active|picked)(\s|$)/i.test(String(el.className || '')) || el.getAttribute('aria-pressed') === 'true' || !!el.querySelector('.selected, .active');
  const at = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; };
  if (mode === 'state') {
    const el = document.querySelector('[data-ev-placer-pick]');
    if (!el || !vis(el)) return { found: false };
    if (!inView(el)) el.scrollIntoView({ block: 'center' });
    return { found: true, picked: picked(el), ...at(el) };
  }
  document.querySelectorAll('[data-ev-placer-pick]').forEach((e) => e.removeAttribute('data-ev-placer-pick'));
  const odds = /^[+\-\u2212]\d{3,5}$/;
  const cands = [...document.querySelectorAll('ms-event-pick, ms-option, .option-indicator, [class*="option-pick"], button')]
    .map((el) => el.closest('ms-event-pick') || el.closest('ms-option') || el)
    .filter((el, i, a) => a.indexOf(el) === i && vis(el) && odds.test((el.textContent || '').trim().split(/\s+/).pop() || ''))
    .filter((el) => !el.closest('ms-bet-slip, bs-betslip, [class*="betslip"], [class*="bet-slip"], [class*="my-bets"]') && !el.closest('[disabled], [class*="locked"], [class*="suspended"]') && !picked(el));
  const el = cands.find(inView) || cands[0];
  if (!el) return { found: false, seen: cands.length };
  el.setAttribute('data-ev-placer-pick', '1');
  if (!inView(el)) el.scrollIntoView({ block: 'center' });
  return { found: true, picked: false, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), ...at(el) };
}
const mgmPickIn = async (tabId, mode) => (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: mgmOddsPick, args: [mode] }).catch(() => []))[0]?.result || { found: false };

// BetMGM runs its location check when a pick is added to the bet slip (Austin's HAR, 2026-11-23:
// add to slip, then the check 0.1s later), not on a page load. So to renew it: a real click (through
// Chrome's debugger, like the Gambit login) on one odds button in the BetMGM tab, wait for the new
// check, then a second click on the same button to take the pick off the slip again. Bets are placed
// by the app, never from this slip. Returns { ok, why, fresh }.
async function mgmClickRenew(tabId, label, since, waitFresh) {
  if (!chrome.debugger) return { ok: false, why: 'the extension is missing the "debugger" permission: reload it in chrome://extensions' };
  if (dbgBusy.has(tabId)) return { ok: false, why: `the ${label} tab is busy logging in` };
  const lg = await inPage(tabId, false).catch(() => ({}));
  if (lg.state === 'logged-out' || lg.state === 'form') return { ok: false, why: `${label} is logged out (the extension logs back in first)` };
  const target = { tabId };
  let attached = false, added = false, removed = false, text = '';
  dbgBusy.add(tabId);
  try {
    let p = await mgmPickIn(tabId, 'find');
    if (!p.found) return { ok: false, why: `no odds buttons visible in the ${label} tab (open the ${label} home page or any game there)` };
    text = p.text || '';
    await new Promise((res, rej) => chrome.debugger.attach(target, '1.3', () => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res())));
    attached = true;
    await dbgCmd(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await sleep(300);
    p = await mgmPickIn(tabId, 'state');
    if (!p.found) return { ok: false, why: `the odds button in the ${label} tab went away before the click` };
    await realClick(target, p);
    for (let i = 0; i < 10 && !added; i++) { await sleep(300); added = !!(await mgmPickIn(tabId, 'state')).picked; }
    const fr = await waitFresh();
    // Take the pick off the slip again (up to 3 tries).
    for (let i = 0; i < 3; i++) {
      const q = await mgmPickIn(tabId, 'state');
      if (!q.found || !q.picked) { removed = q.found || !added; break; }
      await realClick(target, q);
      await sleep(800);
    }
    const left = added && !removed ? ` The pick "${text}" may still be on the ${label} bet slip: remove it there.` : '';
    return { ok: fr, why: `clicked "${text}" in the ${label} tab${added ? '' : ' (the button didn\'t show as picked)'}${left}` };
  } catch (e) {
    const m = String(e?.message || e);
    return { ok: false, why: m.includes('Another debugger') ? `Chrome DevTools is open on the ${label} tab: close it` : `clicking odds failed: ${m}` };
  } finally {
    if (attached) chrome.debugger.detach(target, () => void chrome.runtime.lastError);
    dbgBusy.delete(tabId);
  }
}

function makeGeoKeeper({ book, label, key, host, setting, help, clearMatch, passive = false, passiveHelp = '', clickRenew = null }) {
  const k = { book, label, setting, passive, g: {}, job: null, triedAt: 0, fails: 0, busyAt: 0, refusedAt: 0, last: null, toldAt: 0 };
  store.get(`geo_${book}`).then((v) => { if (v?.[`geo_${book}`] && !k.g.updateAt) k.g = v[`geo_${book}`]; });
  const note = (text, level = 'warn') => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'note', book, level, text })); };
  const tab = async () => (await bookTabs()).find((t) => t.book === book && host.test(new URL(t.url).hostname));
  k.now = async (tabId) => {
    const [r] = tabId ? await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readPageGeo, args: [key] }).catch(() => []) : [];
    let g = null; try { g = JSON.parse(r?.result || 'null'); } catch {}
    if (g && JSON.stringify(g) !== JSON.stringify(k.g)) { k.g = g; store.set({ [`geo_${book}`]: g }); }
    return g || {};
  };
  // Why the check needs renewing now ('' = it doesn't).
  k.due = (g) => {
    const now = Date.now();
    if (k.refusedAt > Math.max(g.updateAt || 0, /^(VALID|OK)/i.test(String(g.status || '')) ? g.statusAt || 0 : 0)) return 'a bet was refused because it had lapsed';
    if (!g.updateAt && !g.statusAt) return 'no location check seen in this page yet';
    if (g.statusAt > (g.updateAt || 0) + 5e3 && g.status && !/^(VALID|OK)/i.test(g.status) && now - g.statusAt > 30e3) return `${label} answered ${g.status}`;
    // Clicking odds: give the page's own next check (due at nextAt) 20s first.
    if (clickRenew && settings.betmgmGeoClick !== false) { if (g.nextAt && now > g.nextAt + 20e3) return `it was due ${mins(now - g.nextAt)} ago`; return ''; }
    if (g.nextAt && now > g.nextAt - GEO_RENEW_BEFORE_MS) return now > g.nextAt ? `it ran out ${mins(now - g.nextAt)} ago` : `it runs out in ${mins(g.nextAt - now)}`;
    return '';
  };
  k.renew = (why, urgent = false) => {
    if (k.job) return k.job;
    k.job = (async () => {
      const gap = urgent ? 60e3 : k.fails >= 3 ? 10 * 60e3 : 2 * 60e3;
      if (Date.now() - k.triedAt < gap) return { ok: false, why: `last try was ${mins(Date.now() - k.triedAt)} ago` };
      const t = await tab();
      if (!t) return { ok: false, why: `no ${label} tab open (open it and log in)` };
      // Wait for a bet being sent or waiting on its live delay (a reload would lose its answer).
      for (let i = 0; i < 60 && (placing[book] > 0 || Date.now() - k.busyAt < 20e3); i++) await sleep(1000);
      if (placing[book] > 0 || Date.now() - k.busyAt < 20e3) return { ok: false, why: `a ${label} bet was still being sent` };
      k.triedAt = Date.now();
      if (clickRenew) {
        const since = Date.now();
        note(`renewing ${label}'s location check (${why}): clicking odds in the ${label} tab`, 'info');
        let g = {};
        const r = await clickRenew(t.id, label, since, async () => {
          while (Date.now() - since < 45e3) { await sleep(1500); g = await k.now(t.id); if (fresh(g, since)) return true; }
          return false;
        });
        if (r.ok) {
          k.fails = 0;
          const left = g.nextAt > Date.now() ? `, good for ${mins(g.nextAt - Date.now())}` : '';
          k.last = { at: Date.now(), ok: true, why: `${r.why}, after ${Math.round((Date.now() - since) / 1000)}s${left}` };
          note(`${label} location check renewed: ${k.last.why}`, 'good');
          return { ok: true, why: k.last.why };
        }
        k.fails++;
        const msg = `${r.why}; no new location check in 45s. ${help}`;
        k.last = { at: Date.now(), ok: false, why: msg };
        note(`${label} location check NOT renewed: ${msg} Trying again in ${k.fails >= 3 ? 10 : 2} min`);
        return { ok: false, why: msg };
      }
      const front = k.fails % 2 === 1;   // every other failed round, bring the tab to the front too
      const name = front ? `bringing the ${label} tab to the front and reloading` : `reloading the ${label} tab`;
      note(`renewing ${label}'s location check (${why}): ${name}`, 'info');
      const since = Date.now();
      let back = null;
      if (front) {
        const tb = await chrome.tabs.get(t.id).catch(() => null);
        const win = tb && await chrome.windows.get(tb.windowId).catch(() => null);
        const [cur] = tb ? await chrome.tabs.query({ active: true, windowId: tb.windowId }) : [];
        back = { tabId: cur && cur.id !== t.id ? cur.id : null, windowId: tb?.windowId, minimized: win?.state === 'minimized' };
        await chrome.tabs.update(t.id, { active: true }).catch(() => {});
        if (tb) await chrome.windows.update(tb.windowId, { focused: true, ...(back.minimized ? { state: 'normal' } : {}) }).catch(() => {});
      }
      reloadedAt[book] = Date.now();
      lastReload = { book, why: `renew the location check: ${name}`, at: Date.now() };
      // theScore saves its location check in the browser and, on a reload, reuses it while it's still
      // valid instead of running a new one (so a reload alone didn't renew it). Remove the saved copy first.
      let cleared = null;
      if (clearMatch) cleared = (await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: clearPageGeo, args: [clearMatch] }).catch(() => []))[0]?.result || [];
      await chrome.tabs.reload(t.id).catch(() => {});
      let g = {};
      try {
        while (Date.now() - since < 45e3) {
          await sleep(2000);
          await brVisible(t.id);   // in case the page script didn't load with the page
          g = await k.now(t.id);
          if (fresh(g, since)) break;
        }
      } finally {
        if (back?.tabId) await chrome.tabs.update(back.tabId, { active: true }).catch(() => {});
        if (back?.minimized) await chrome.windows.update(back.windowId, { state: 'minimized' }).catch(() => {});
      }
      if (fresh(g, since)) {
        k.fails = 0;
        const left = g.nextAt > Date.now() ? `, good for ${mins(g.nextAt - Date.now())}` : '';
        k.last = { at: Date.now(), ok: true, why: `${name}, after ${Math.round((Date.now() - since) / 1000)}s${left}${cleared?.length ? ` (saved check removed first: ${cleared.join(', ').slice(0, 120)})` : ''}` };
        note(`${label} location check renewed by ${k.last.why}`, 'good');
        return { ok: true, why: k.last.why };
      }
      k.fails++;
      const seen = Math.max(g.startAt || 0, g.initAt || 0) > since ? 'the page started a check but it wasn\'t confirmed' : 'the page didn\'t start a location check';
      const msg = `${name} didn't bring a new location check in 45s (${seen}${cleared ? `; saved check removed first: ${cleared.length ? cleared.join(', ').slice(0, 200) : 'none found'}` : ''}). ${help}`;
      k.last = { at: Date.now(), ok: false, why: msg };
      note(`${label} location check NOT renewed: ${msg} Trying again in ${k.fails >= 3 ? 10 : 2} min`);
      return { ok: false, why: msg };
    })().catch((e) => ({ ok: false, why: String(e?.message || e) })).finally(() => { k.job = null; });
    return k.job;
  };
  // Every 30 seconds (watchLogins).
  k.keep = async () => {
    if (settings[setting] === false || k.job) return;
    const t = await tab();
    if (!t || t.discarded) return;
    await brVisible(t.id);
    const g = await k.now(t.id);
    if (passive && !(clickRenew && settings.betmgmGeoClick !== false)) {
      // The page runs its own next check when the location server said to (timeForNextCall); a
      // reload cancels that and doesn't start a new one, so the extension only watches and says so
      // (once every 10 minutes) when the check is more than 3 minutes overdue.
      if (g.nextAt && Date.now() > g.nextAt + 180e3 && (g.updateAt || 0) < g.nextAt && Date.now() - k.toldAt > 10 * 60e3) {
        k.toldAt = Date.now();
        note(`${label}'s location check is ${mins(Date.now() - g.nextAt)} overdue and the page hasn't run it. ${passiveHelp}`);
      }
      return;
    }
    const why = k.due(g);
    if (why) k.renew(why, k.refusedAt > Date.now() - 120e3).catch(() => {});
  };
  k.refused = (why) => {
    k.refusedAt = Date.now();
    if (passive && !(clickRenew && settings.betmgmGeoClick !== false)) { if (Date.now() - k.toldAt > 2 * 60e3) { k.toldAt = Date.now(); note(`${label} refused a bet because its location check had lapsed. ${passiveHelp}`); } return; }
    if (settings[setting] !== false) k.renew(why || 'a bet was refused because it had lapsed', true).catch(() => {});
  };
  return k;
}
const geoKeepers = {
  betmgm: makeGeoKeeper({ book: 'betmgm', label: 'BetMGM', key: 'evPlacerMgmGeo', host: /(^|\.)betmgm\.com$/, setting: 'betmgmGeoRenew', clearMatch: '^(lastFetchLocationCommand|lastLocationInfoStatus)$',
    // BetMGM doesn't start a location check on a page load (Austin, 2026-11-23: every reload "didn't
    // start a location check"); it runs the next one itself ~19.5 min after the last (timeForNextCall),
    // and when you use the site. Reloading cancelled that, so the BetMGM tab is never reloaded for it.
    // It does start one when a pick is added to the slip, so the extension renews it that way (Austin
    // asked for it fully automatic, 2026-11-23): see mgmClickRenew. Off with config.json "session":
    // {"betmgmGeoClick": false} (then it only watches and tells you, as passiveHelp says).
    clickRenew: mgmClickRenew,
    passive: true, passiveHelp: 'BetMGM runs it when you use the site: click any odds in the BetMGM tab (then remove it from the slip) to run it now. Keep the GeoComply app running.',
    help: 'Is the GeoComply location app running on this PC, and are you logged in to BetMGM?' }),
  thescore: makeGeoKeeper({ book: 'thescore', label: 'theScore', key: 'evPlacerTsGeo', host: /^sportsbook\.thescore\.bet$/, setting: 'thescoreGeoRenew', clearMatch: '__GEOCOMPLY__$',
    help: 'Is the GeoComply location app running on this PC, does Chrome allow theScore to use your location, and are you logged in to theScore?' }),
};

// Kambi refused a bet because the location check had lapsed.
const kambiBlocked = (r) => {
  const j = r?.json;
  const errs = [...(j?.generalErrors || []), ...(j?.couponRowErrors || []).flatMap((x) => x.errors || []), ...(j?.betErrors || []).flatMap((x) => x.errors || [])];
  return errs.some((e) => e?.type === 'ACCOUNT_BLOCKED');
};

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
let settings = { gambitAutoLogin: true, fanduelGeoRenew: true, betriversGeoRenew: true, betmgmGeoRenew: true, betmgmGeoClick: true, betmgmAutoLogin: true, thescoreGeoRenew: true, draftkingsPlaySpan: true };
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
  const submit = btns.find((b) => b.type === 'submit' && /log\s?in|sign\s?in/i.test(b.textContent || '')) || btns.find((b) => b.type === 'submit')
    || btns.find((b) => /^\s*(log\s?in|sign\s?in)\s*$/i.test(b.textContent || ''));
  p.scrollIntoView({ block: 'center' });
  const at = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  // Only a robot check you'd have to answer counts: a visible challenge or checkbox. Invisible
  // reCAPTCHA (its badge only, size=invisible; BetMGM has it on every page) doesn't.
  const big = (el) => { const r = el.getBoundingClientRect(); return vis(el) && r.width > 60 && r.height > 40; };
  const captcha = [...document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .cf-turnstile')]
    .some((el) => big(el) && !/size=invisible/.test(el.getAttribute('src') || ''));
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
// ---- DraftKings: keep its play session alive ----
// DraftKings' login comes with a "play span" (api.draftkings.com/sites/US-CO-SB/playspans/v1/
// playspans/<key>) that lasts 30 minutes and is renewed by a PUT. The page reads it every minute but
// renews it only now and then (in Austin's 45-minute capture, 2026-11-23, once it was down to 7
// minutes left), and when it runs out DraftKings logs you out to its home page. So when it has under
// 10 minutes left, the extension sends the same renewal the page sends, from the DraftKings tab.
// Off with config.json "session": {"draftkingsPlaySpan": false}.
let dkSpan = { url: null, left: null, at: 0, renewedAt: 0, last: null };
store.get('dkSpan').then((v) => { if (v?.dkSpan?.url && !dkSpan.url) dkSpan = { ...dkSpan, url: v.dkSpan.url }; });
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0 || d.method !== 'GET') return;
  const url = d.url.replace(/\?.*$/, '');
  if (url !== dkSpan.url) { dkSpan.url = url; store.set({ dkSpan: { url } }); }
}, { urls: ['https://api.draftkings.com/sites/*/playspans/v1/playspans/*'] });
const dkSpanCall = async (url, put) => {
  try {
    const key = url.split('/').pop();
    const r = await fetch(`${url}?format=json`, put
      ? { method: 'PUT', credentials: 'include', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ playSpanClientKey: key }) }
      : { method: 'GET', credentials: 'include', headers: { 'content-type': 'application/json' } });
    const j = await r.json().catch(() => null);
    return { status: r.status, left: j?.playSpan?.timeUntilExpirationSeconds ?? null };
  } catch (e) { return { status: 0, error: String(e?.message || e) }; }
};
async function keepDkSpan() {
  if (settings.draftkingsPlaySpan === false || !dkSpan.url || Date.now() - dkSpan.at < 120e3) return;
  const t = (await bookTabs()).find((x) => x.book === 'draftkings' && !x.discarded);
  if (!t) return;
  dkSpan.at = Date.now();
  const run = async (put) => (await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: dkSpanCall, args: [dkSpan.url, put] }).catch(() => []))[0]?.result || {};
  const g = await run(false);
  if (g.status !== 200 || g.left == null) return;   // logged out, or a different answer: leave it to the login alert
  dkSpan.left = g.left;
  if (g.left > 600) return;
  const p = await run(true);
  dkSpan.last = { at: Date.now(), ok: p.status === 200, left: p.left, before: g.left };
  if (p.status === 200) dkSpan.renewedAt = Date.now(), dkSpan.left = p.left;
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'note', book: 'draftkings', level: p.status === 200 ? 'info' : 'warn',
    text: p.status === 200 ? `DraftKings play session renewed (had ${Math.round(g.left / 60)} min left)` : `DraftKings play session NOT renewed (HTTP ${p.status}${p.error ? `, ${p.error}` : ''}); it had ${Math.round(g.left / 60)} min left` }));
}

// BetMGM logs you out after a while (Austin, 2026-11-23: logged out while away; the page shows its
// login box with the email remembered). Logs back in like the Gambit auto login: real clicks through
// Chrome's debugger so Chrome fills its saved password, then "Log in". The extension never reads,
// keeps or sends your password. Off with config.json "session": {"betmgmAutoLogin": false}.
// Retries every 5 seconds (Austin, 2026-11-23: 2 minutes was too long), slowing to once a minute
// after 20 tries in a row. But after it actually pressed Log in and BetMGM still refused, it waits
// 2 minutes (10 after 3 in a row): fast wrong-password tries can lock the account.
const mgmLogin = { busy: false, triedAt: 0, fails: 0, subFails: 0, submitted: false, last: null, timer: null, saidAt: 0, said: '' };
const mgmLoginGap = () => (mgmLogin.subFails ? (mgmLogin.subFails >= 3 ? 10 * 60e3 : 2 * 60e3) : mgmLogin.fails >= 20 ? 60e3 : 5e3);
async function autoLoginBetMGM() {
  if (settings.betmgmAutoLogin === false || mgmLogin.busy) return;
  const t = (await bookTabs()).find((x) => x.book === 'betmgm' && /(^|\.)betmgm\.com$/.test(new URL(x.url).hostname));
  if (!t || t.discarded || dbgBusy.has(t.id) || geoKeepers.betmgm.job || placing.betmgm > 0) return;
  let f = await inPage(t.id, false).catch(() => ({ state: 'no-page' }));
  if (f.state === 'logged-in' || f.state === 'no-page') return;
  if (Date.now() - mgmLogin.triedAt < mgmLoginGap() - 500) return;
  if (!chrome.debugger) return;
  mgmLogin.busy = true; mgmLogin.triedAt = Date.now();
  const note = (text, level = 'warn') => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'note', book: 'betmgm', level, text })); };
  const done = (ok, why) => {
    mgmLogin.last = { at: Date.now(), ok, why };
    mgmLogin.fails = ok ? 0 : mgmLogin.fails + 1;
    mgmLogin.subFails = ok ? 0 : mgmLogin.submitted ? mgmLogin.subFails + 1 : mgmLogin.subFails;
    if (ok) { mgmLogin.said = ''; return note(`BetMGM: ${why}`, 'good'); }
    // The same failure every 5 seconds: say it once a minute.
    if (why === mgmLogin.said && Date.now() - mgmLogin.saidAt < 60e3) return;
    mgmLogin.said = why; mgmLogin.saidAt = Date.now();
    const gap = mgmLoginGap();
    note(`BetMGM auto login failed: ${why}. Trying again every ${gap >= 60e3 ? `${gap / 60e3} min` : `${gap / 1000}s`}`);
  };
  mgmLogin.submitted = false;
  const target = { tabId: t.id };
  let attached = false, back = null;
  dbgBusy.add(t.id);
  try {
    // Chrome only opens its saved-password list in a tab that's in front, in a focused window
    // (Austin, 2026-11-23: the login box opened but nothing got filled). Bring it to the front for
    // the login, then go back to the tab you had open.
    const tb = await chrome.tabs.get(t.id).catch(() => null);
    const win = tb && await chrome.windows.get(tb.windowId).catch(() => null);
    const [cur] = tb ? await chrome.tabs.query({ active: true, windowId: tb.windowId }) : [];
    back = { tabId: cur && cur.id !== t.id ? cur.id : null, windowId: tb?.windowId, minimized: win?.state === 'minimized' };
    await chrome.tabs.update(t.id, { active: true }).catch(() => {});
    if (tb) await chrome.windows.update(tb.windowId, { focused: true, ...(back.minimized ? { state: 'normal' } : {}) }).catch(() => {});
    await sleep(800);
    if (!mgmLogin.fails) note('BetMGM is logged out: logging back in with Chrome\'s saved password', 'info');
    f = await inPage(t.id, true);
    if (f.state !== 'form' || !f.pass) return done(false, f.state === 'no-form' ? 'clicked Log In but no login box showed up' : `couldn't find the login box (${f.state})`);
    if (f.captcha) return done(false, 'BetMGM is showing an "are you a robot" check: log in by hand');
    await new Promise((res, rej) => chrome.debugger.attach(target, '1.3', () => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res())));
    attached = true;
    await dbgCmd(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await realClick(target, f.pass);
    await sleep(1200);
    let g = await inPage(t.id, true);
    const pick = async (downs) => {
      for (let i = 0; i < downs; i++) { await realKey(target, 'ArrowDown', 'ArrowDown', 40); await sleep(500); }
      await realKey(target, 'Enter', 'Enter', 13, '\r');
      await sleep(1000);
      return inPage(t.id, true);
    };
    if (g.state === 'form' && !g.passLen) {
      // Chrome didn't fill it on its own: pick the saved login from Chrome's list under the password
      // box (Down, Enter). If the list wasn't open yet, the first Down only opens it: Down twice.
      g = await pick(1);
      if (g.state === 'form' && !g.passLen && g.pass) { await realClick(target, g.pass); await sleep(1200); g = await pick(2); }
      if (g.state === 'form' && !g.passLen && g.user) {
        await realClick(target, g.user);
        await sleep(800);
        await realKey(target, 'ArrowDown', 'ArrowDown', 40);
        await sleep(300);
        await realKey(target, 'Enter', 'Enter', 13, '\r');
        await sleep(800);
        g = await inPage(t.id, true);
      }
    }
    if (g.state === 'logged-in') return done(true, 'logged back in with Chrome\'s saved password');
    if (g.state !== 'form') return done(false, `the login box closed unexpectedly (${g.state})`);
    if (!g.passLen) return done(false, 'Chrome didn\'t fill in the saved password. Save your BetMGM password in Chrome (chrome://password-manager) by logging in once and choosing Save');
    if (!g.submit) return done(false, 'couldn\'t find the Log in button');
    mgmLogin.submitted = true;
    await realClick(target, g.submit);
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const h = await inPage(t.id, false).catch(() => ({}));
      if (h.state === 'logged-in') return done(true, 'logged back in with Chrome\'s saved password');
    }
    done(false, 'pressed Log in but BetMGM still shows the login box (wrong saved password, or BetMGM wants a code)');
  } catch (e) {
    done(false, String(e?.message || e).includes('Another debugger') ? 'Chrome DevTools is open on the BetMGM tab: close it' : String(e?.message || e));
  } finally {
    if (attached) chrome.debugger.detach(target, () => void chrome.runtime.lastError);
    if (back?.tabId) await chrome.tabs.update(back.tabId, { active: true }).catch(() => {});
    if (back?.minimized) await chrome.windows.update(back.windowId, { state: 'minimized' }).catch(() => {});
    dbgBusy.delete(t.id);
    mgmLogin.busy = false;
    // Still logged out: try again after the gap (the 30-second check would be too slow).
    if (mgmLogin.last && !mgmLogin.last.ok && Date.now() - mgmLogin.last.at < 5e3) {
      clearTimeout(mgmLogin.timer);
      mgmLogin.timer = setTimeout(() => autoLoginBetMGM().catch(() => {}), mgmLoginGap());
    }
  }
}

async function watchLogins() {
  await keepTabsLoaded();
  await keepDkSpan().catch(() => {});
  await nudgeTabs();
  await keepFdGeo().catch(() => {});
  await keepBrGeo().catch(() => {});
  await autoLoginBetMGM().catch(() => {});
  for (const k of Object.values(geoKeepers)) await k.keep().catch(() => {});
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
  // A WebSocket request (DraftKings' My Bets): open it from the page, send each message, and answer
  // with the first message whose JSON "id" is req.ws.replyId (or an error / timeout), then close.
  if (req.ws) {
    return await new Promise((resolve) => {
      let done = false, sock;
      const end = (o) => { if (done) return; done = true; try { sock?.close(); } catch {} resolve(o); };
      const timer = setTimeout(() => end({ status: 0, error: 'websocket: no answer in time' }), req.timeoutMs || 20000);
      try { sock = new WebSocket(req.url); } catch (e) { clearTimeout(timer); return end({ status: 0, error: `websocket: ${e?.message || e}` }); }
      sock.onopen = () => { for (const m of req.ws.send || []) sock.send(m); };
      sock.onmessage = (ev) => {
        const text = String(ev.data || '');
        let j = null; try { j = JSON.parse(text); } catch {}
        if (j && j.id === req.ws.replyId) { clearTimeout(timer); end({ status: j.error ? 400 : 200, text, json: j }); }
      };
      sock.onerror = () => { clearTimeout(timer); end({ status: 0, error: 'websocket: connection failed (logged out?)' }); };
      sock.onclose = (ev) => { clearTimeout(timer); end({ status: 0, error: `websocket closed (${ev.code}${ev.reason ? `, ${ev.reason}` : ''})` }); };
    });
  }
  try {
  const headers = { ...(req.headers || {}) };
  // Optional: copy auth headers the site keeps in localStorage/sessionStorage.
  for (const [h, spec] of Object.entries(req.storageHeaders || {})) {
    const store = spec.session ? sessionStorage : localStorage;
    let v = store.getItem(spec.key);
    if (v && spec.jsonPath) { try { v = spec.jsonPath.split('.').reduce((o, k) => o?.[k], JSON.parse(v)); } catch {} }
    if (v) headers[h] = (spec.prefix || '') + v;
  }
  const ms = req.timeoutMs || 0;
  const res = await fetch(req.url, {
    method: req.method || 'GET',
    headers,
    ...(ms ? { signal: AbortSignal.timeout(ms) } : {}),
    body: req.body == null ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    // Some APIs (FanDuel's api.sportsbook.fanduel.com) refuse cross-site requests that carry
    // cookies; the site itself calls them without, so the app asks for 'omit' there.
    credentials: req.credentials || 'include',
  });
  // Event streams (DraftKings' waitingBets) stay open: read them as they come and stop once a
  // line matches req.streamUntil, or at the time limit, returning what arrived either way.
  if (req.streamUntil && res.body?.getReader) {
    const until = new RegExp(req.streamUntil);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '', done = false;
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) { done = true; break; }
        text += dec.decode(r.value, { stream: true });
        if (until.test(text)) break;
      }
    } catch {}
    try { reader.cancel(); } catch {}
    return { status: res.status, json: null, text: text.slice(-20000), streamEnded: done, matched: until.test(text) };
  }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: json ? undefined : text.slice(0, 2000) };
  } catch (e) { return { status: 0, timedOut: e?.name === 'TimeoutError', error: e?.name === 'TimeoutError' ? `no answer in ${Math.round(req.timeoutMs / 1000)}s` : `in-tab request failed: ${e?.message || e}` }; }
}

// Same request made by the extension itself (it has permission for these sites, so the
// browser's cross-site rules don't block it). Used for Gambit, and as a fallback.
async function extFetch(req) {
  try {
    const res = await fetch(req.url, {
      method: req.method || 'GET', headers: req.headers || {}, credentials: 'include',
      ...(req.timeoutMs ? { signal: AbortSignal.timeout(req.timeoutMs) } : {}),
      body: req.body == null ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text: json ? undefined : text.slice(0, 2000) };
  } catch (e) { return { status: 0, timedOut: e?.name === 'TimeoutError', error: e?.name === 'TimeoutError' ? `no answer in ${Math.round(req.timeoutMs / 1000)}s` : `extension request failed: ${e?.message || e}` }; }
}

async function runInTab(tabId, request) {
  // A frozen or still-loading tab can leave executeScript hanging: give up a little after the
  // request's own time limit so the app gets a real reason instead of its generic timeout.
  const run = chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageFetch, args: [request] });
  const [r] = request.timeoutMs
    ? await Promise.race([run, sleep(request.timeoutMs + 1500).then(() => { throw new Error(`the tab didn't respond in ${Math.round(request.timeoutMs / 1000) + 1}s (frozen or still loading)`); })])
    : await run;
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
      if (!kambiAuth) {
        const n = await renewKambi(tab, msg.request.url);
        if (n.error) return reply({ error: `BetRivers login token not seen yet and getting one failed: ${n.error}` });
      }
      msg.request.headers = { ...(msg.request.headers || {}), authorization: kambiAuth };
      // Kambi turned the token down: get a fresh one and send the request once more. A refused
      // request did nothing (no bet placed), so sending it again is safe.
      if (msg.request.kind === 'status') brBusyAt = Date.now();   // a live bet waiting on its delay
      // ACCOUNT_BLOCKED: the location check had lapsed and nothing was placed. Start renewing it
      // without making this bet wait; the app checks the bet again from the start every scan.
      const geoBet = ['validate', 'place'].includes(msg.request.kind);
      const off = settings.betriversGeoRenew === false;
      // A renewal is running: don't send the bet to Kambi at all until it's done.
      if (geoBet && brGeoJob && !off) return reply({ error: 'BetRivers location check is being renewed, nothing was sent; the bet is checked again next scan', notSent: true, geoRenewing: true });
      const blocked = async (r) => {
        if (!kambiBlocked(r) || !geoBet) return r;
        if (off) return { ...r, geoBlocked: true, geoWhy: 'renewal is off (config "session": {"betriversGeoRenew": false})' };
        const n = await Promise.race([renewBrGeo('a bet was refused with ACCOUNT_BLOCKED', true), sleep(300).then(() => null)]);
        return { ...r, geoBlocked: true, geoRenewing: !n || !!n.ok, geoWhy: n && !n.ok ? n.why : '' };
      };
      const first = await runInTab(tab.id, msg.request);
      if (!kambiRefused(first)) return reply(first.error ? { error: first.error } : await blocked(first));
      const n = await renewKambi(tab, msg.request.url);
      if (n.error) return reply({ ...first, renewError: n.error });
      msg.request.headers.authorization = kambiAuth;
      const again = await runInTab(tab.id, msg.request);
      return reply(again.error ? { error: again.error } : { ...(await blocked(again)), renewed: true, ...(kambiRefused(again) ? { renewError: 'Kambi turned down the fresh token too' } : {}) });
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
        const geo = await fdGeoNow(tab.id);
        if (!geo || fdGeoExp(geo) < Date.now() + 15e3) {
          // Ran out (or never seen): nothing is sent to FanDuel. Start renewing it (without making
          // this bet wait); the app checks the bet again from the start (price and every rule) on
          // its next scans, and places it once the new location check is in.
          const had = !!geo;
          if (settings.fanduelGeoRenew === false) return reply({ error: `FanDuel location check ${had ? 'ran out (it lasts 20 minutes)' : 'not seen yet'}, nothing was sent, and renewing it is off (config "session": {"fanduelGeoRenew": false})`, notSent: true });
          const running = !!fdGeoJob;
          const n = running ? null : await Promise.race([renewFdGeo(had ? 'a bet found it had run out' : 'a bet found none yet', true), sleep(300).then(() => null)]);
          if (n && !n.ok) return reply({ error: `FanDuel location check ${had ? 'ran out (it lasts 20 minutes)' : 'not seen yet'}, nothing was sent, and renewing it didn't work: ${n.why}`, notSent: true });
          return reply({ error: `FanDuel location check ${had ? 'had run out' : 'not seen yet'}, nothing was sent; renewing it now, the bet is checked again next scan`, notSent: true, geoRenewing: true });
        }
        msg.request.headers['x-geo-packet'] = geo;
      }
    }
    // BetMGM's location check is being renewed (the tab is reloading): send nothing; the app checks
    // the bet again next scan.
    if (geoKeepers[msg.book]?.job && msg.request.kind === 'place') return reply({ error: `${geoKeepers[msg.book].label} location check is being renewed, nothing was sent; the bet is checked again next scan`, notSent: true, geoRenewing: true });
    if (msg.request.useBetMGMAuth) {
      for (const [h, v] of Object.entries(msg.request.headers || {})) {
        if (v !== '{{bmXsrf}}') continue;
        if (!bmAuth.xsrf) return reply({ error: 'BetMGM login not seen yet: refresh the BetMGM tab (stay logged in)', notSent: true });
        msg.request.headers[h] = bmAuth.xsrf;
      }
      msg.request.headers = { ...(bmAuth.headers || {}), ...(msg.request.headers || {}) };
    }
    if (msg.request.useTheScoreAuth) msg.request.headers = { ...(msg.request.headers || {}), ...tsAuth.headers };
    if (msg.request.useGambitAuth) {
      if (!gambitAuth) return reply({ error: 'no Gambit login seen yet: refresh your Gambit tab' });
      msg.request.headers = { ...(msg.request.headers || {}), authorization: gambitAuth };
    }
    // Gambit: fetch from the extension first (no page involved), then from inside the tab.
    // If Gambit refuses the token, try the other recent ones before giving up on this poll.
    if (msg.book === 'gambit') {
      const refused = (r) => r.status === 401 || r.status === 403;
      msg.request.timeoutMs = msg.request.timeoutMs || 20000;
      let a = await extFetch(msg.request);
      while (a.status === 401 && msg.request.headers.authorization === gambitAuth && dropGambitToken(gambitAuth)) {
        msg.request.headers.authorization = gambitAuth;
        a = await extFetch(msg.request);
      }
      if (!a.error && a.status && a.status < 400) { gambitRefused = 0; return reply(a); }
      // A timeout means the connection is slow: trying again from the tab only adds to the wait
      // (and from the tab Gambit's API refuses the request anyway: "Failed to fetch").
      if (a.timedOut) return reply({ error: `Gambit didn't answer in ${Math.round(msg.request.timeoutMs / 1000)}s: the internet on this PC is slow or down, or Gambit's site is` });
      const b = await runInTab(tab.id, msg.request);
      if (!b.error && b.status && b.status < 400) { gambitRefused = 0; return reply(b); }
      // Refused over and over (about 20s of polls): the page's login has stalled, a reload renews it.
      if (refused(a) && ++gambitRefused >= 10) reloadTab('gambit', `Gambit answered HTTP ${a.status} ${gambitRefused} times in a row (login not accepted)`);
      if (!b.error && b.status) return reply(b);
      if (a.timedOut && b.timedOut) return reply({ error: `Gambit didn't answer in ${Math.round(msg.request.timeoutMs / 1000)}s, twice (from the extension and from the Gambit tab): Chrome's internet is down or very slow, or Gambit's site is` });
      return reply({ error: `Gambit: ${a.error || `HTTP ${a.status}`}; ${b.error || `HTTP ${b.status}`}` });
    }
    const r = await runInTab(tab.id, msg.request);
    if (r.error) return reply({ error: r.error });
    reply(r);
  } catch (e) { reply({ error: String(e?.message || e) }); }
  finally {
    if (msg.request?.kind === 'place') placing[msg.book] = Math.max(0, (placing[msg.book] || 1) - 1);
    if (msg.book === 'betrivers' && ['place', 'status'].includes(msg.request?.kind)) brBusyAt = Date.now();
    if (geoKeepers[msg.book] && ['place', 'status'].includes(msg.request?.kind)) geoKeepers[msg.book].busyAt = Date.now();
  }
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
    else if (m.type === 'mgmGeoRenew') geoKeepers.betmgm.refused(m.why);
    else if (m.type === 'geoRenew' && geoKeepers[m.book]) geoKeepers[m.book].refused(m.why);
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
  if (m === 'status') { bookTabs().then((tabs) => respond({ status, tabs, gambitLogin: !!gambitAuth, betriversLogin: !!kambiAuth, betriversRenewedAt: kambiRenewedAt, hardrockLogin: !!hrAuth.session, hardrockGeo: hrAuth.geoAt || 0,
    fanduelExp: jwtExp(fdAuth.auth), fanduelGeoExp: fdGeoExp(fdAuth.geo), fanduelGeoLast: fdGeoLast, betriversGeoExp: brGeo.status === 'ALLOWED' ? brGeo.expires || 0 : 0, betriversGeoSeen: !!(brGeo.at || brGeo.flagAt), betriversGeoLast: brGeoLast, betmgmGeoNext: geoKeepers.betmgm.g.nextAt || 0, betmgmGeoLast: geoKeepers.betmgm.last, thescoreGeoNext: geoKeepers.thescore.g.nextAt || 0, thescoreGeoLast: geoKeepers.thescore.last,
    gambitExp: jwtExp(gambitAuth), hardrockAt: hrAuth.sessionAt || 0, dkSpanLeft: dkSpan.left, dkSpanAt: dkSpan.at, dkSpanRenewedAt: dkSpan.renewedAt, betmgmLogin: !!bmAuth.xsrf, betmgmHeaders: Object.keys(bmAuth.headers || {}), thescoreHeaders: Object.keys(tsAuth.headers), alert: alertText, lastReload, lastLogin, autoLogin: settings.gambitAutoLogin })); return true; }
});
// Keep the service worker alive while the engine runs.
chrome.alarms?.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(() => { if (!ws) connect(); else sendTabs(); watchLogins().catch(() => {}); });
connect();
keepTabsLoaded();
