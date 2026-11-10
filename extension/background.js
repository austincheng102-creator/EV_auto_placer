// Connects to the local engine (ws://127.0.0.1:8765) and executes requests inside the
// matching sportsbook tab, in the page's own context, so the site's cookies and
// session headers apply exactly as when you click "Place bet" yourself.
const PORT = 8765;
const BOOK_HOSTS = {
  betrivers: [/\.betrivers\.(ca|com)$/],
  fanduel: [/sportsbook\.fanduel\.(com|ca)$/],
  gambit: [/(^|\.)gambitodds\.com$/],
};

// Gambit's login token expires about hourly and the site refreshes it on its own. We
// watch the requests your open Gambit tab makes and reuse its current token, so the
// engine never needs a copied one.
let gambitAuth = null;
chrome.storage.session?.get('gambitAuth').then((v) => { if (v?.gambitAuth && !gambitAuth) gambitAuth = v.gambitAuth; });
chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  const h = (d.requestHeaders || []).find((x) => x.name.toLowerCase() === 'authorization');
  if (h?.value && h.value !== gambitAuth) { gambitAuth = h.value; chrome.storage.session?.set({ gambitAuth }); }
}, { urls: ['https://api-sports.gambitodds.com/*'] }, ['requestHeaders', 'extraHeaders']);

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
  return tabs.map((t) => ({ id: t.id, book: bookFor(t.url || ''), url: t.url })).filter((t) => t.book);
}

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
    const matches = (await bookTabs()).filter((t) => t.book === msg.book);
    const tab = matches.find((t) => /^https:\/\/(www\.)?[^/]+\/?/.test(t.url || '') && !/api/.test(new URL(t.url).hostname)) || matches[0];
    if (!tab) return reply({ error: msg.book === 'gambit' ? 'no open Gambit tab (open gambitodds.com and log in)' : `no open ${msg.book} tab` });
    if (msg.request.useGambitAuth) {
      if (!gambitAuth) return reply({ error: 'no Gambit login seen yet: refresh your Gambit tab' });
      msg.request.headers = { ...(msg.request.headers || {}), authorization: gambitAuth };
    }
    // Gambit: fetch from the extension first (no page involved), then from inside the tab.
    if (msg.book === 'gambit') {
      const a = await extFetch(msg.request);
      if (!a.error && a.status && a.status < 400) return reply(a);
      const b = await runInTab(tab.id, msg.request);
      if (!b.error && b.status) return reply(b);
      return reply({ error: `Gambit: ${a.error || `HTTP ${a.status}`}; ${b.error || `HTTP ${b.status}`}` });
    }
    const r = await runInTab(tab.id, msg.request);
    if (r.error) return reply({ error: r.error });
    reply(r);
  } catch (e) { reply({ error: String(e?.message || e) }); }
}

function connect() {
  try { ws = new WebSocket(`ws://127.0.0.1:${PORT}`); } catch { return setTimeout(connect, 3000); }
  ws.onopen = () => { status = 'connected'; sendTabs(); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'fetch') handle(m);
    else if (m.type === 'reload') chrome.runtime.reload(); // engine updated these files on disk
  };
  ws.onclose = () => { status = 'disconnected'; ws = null; setTimeout(connect, 3000); };
  ws.onerror = () => {};
}

chrome.tabs.onUpdated.addListener(sendTabs);
chrome.tabs.onRemoved.addListener(sendTabs);
chrome.runtime.onMessage.addListener((m, _s, respond) => {
  if (m === 'status') { bookTabs().then((tabs) => respond({ status, tabs, gambitLogin: !!gambitAuth })); return true; }
});
// Keep the service worker alive while the engine runs.
chrome.alarms?.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(() => { if (!ws) connect(); else sendTabs(); });
connect();
