// Connects to the local engine (ws://127.0.0.1:8765) and executes requests inside the
// matching sportsbook tab, in the page's own context, so the site's cookies and
// session headers apply exactly as when you click "Place bet" yourself.
const PORT = 8765;
const BOOK_HOSTS = {
  betrivers: [/\.betrivers\.(ca|com)$/],
  fanduel: [/sportsbook\.fanduel\.(com|ca)$/],
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
  return tabs.map((t) => ({ id: t.id, book: bookFor(t.url || ''), url: t.url })).filter((t) => t.book);
}

async function sendTabs() {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'tabs', tabs: (await bookTabs()).map(({ id, book }) => ({ id, book })) }));
}

// Runs in the page (MAIN world). Must be self-contained.
async function pageFetch(req) {
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
}

async function handle(msg) {
  const reply = (o) => ws?.readyState === 1 && ws.send(JSON.stringify({ id: msg.id, ...o }));
  try {
    const { armed = false } = await chrome.storage.local.get('armed');
    if (msg.request.kind === 'place' && !armed) return reply({ error: 'extension is DISARMED (open the popup to arm)' });
    const tab = (await bookTabs()).find((t) => t.book === msg.book);
    if (!tab) return reply({ error: `no open ${msg.book} tab` });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: pageFetch, args: [msg.request] });
    if (r?.error) return reply({ error: String(r.error.message || r.error) });
    reply(r.result);
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
  if (m === 'status') { bookTabs().then((tabs) => respond({ status, tabs })); return true; }
});
// Keep the service worker alive while the engine runs.
chrome.alarms?.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(() => { if (!ws) connect(); else sendTabs(); });
connect();
