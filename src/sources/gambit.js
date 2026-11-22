// Fetches the +EV/odds table from Gambit and normalizes each row.
// The exact endpoint and field names come from the request Gambit's own site makes
// (DevTools > Network > Copy as cURL). Put the URL/headers in config.json -> gambit.
import { evPct } from '../ev.js';
import fs from 'node:fs';
import path from 'node:path';
import { evsToRows, bookIdLists } from './gambit-evs.js';
import { arbDefaults, arbsToRows } from './gambit-arbs.js';

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

export function normalizeRow(raw, fields) {
  const r = {};
  for (const [key, path] of Object.entries(fields)) r[key] = get(raw, path);
  r.odds = Number(r.odds);
  r.fairOdds = Number(r.fairOdds);
  r.line = r.line == null ? null : Number(r.line);
  r.book = String(r.book || '').toLowerCase().replace(/[^a-z]/g, '');
  r.ev = r.ev != null ? Number(r.ev) : evPct(r.odds, r.fairOdds);
  r.id = r.id ?? `${r.book}|${r.event}|${r.market}|${r.selection}|${r.line}`;
  return r;
}

// Two ways to fetch:
//  - via "extension" (default): the Chrome extension makes the request from your open,
//    logged-in Gambit tab with that tab's current token, so it never expires on us.
//  - via "direct": this app fetches with headers from config (GAMBIT_AUTH env for a token).
export function makeGambitSource(cfg, bridge, { root = null, log = null } = {}) {
  const g = cfg.gambit;
  const via = g.via || 'extension';
  const withCacheBuster = (u) => `${u}${u.includes('?') ? '&' : '?'}_t=${Date.now()}`;
  const urls = () => (Array.isArray(g.urls) ? g.urls : [g.url]).filter(Boolean); // live + pre-game

  // Gambit only returns bets for the sportsbooks named in sportsbooks_id, so make sure the
  // books this run bets (e.g. Hard Rock, once its ids are seen in Gambit's links) are in it.
  function withBookIds(url, extra = []) {
    const m = /([?&]sportsbooks_id=)([^&]*)/.exec(url);
    if (!m) return url;
    const have = new Set(decodeURIComponent(m[2]).split(',').filter(Boolean));
    const lists = bookIdLists(g);
    for (const b of cfg.books || []) for (const id of lists[b] || []) have.add(String(id));
    for (const id of extra) have.add(String(id));
    return url.replace(m[0], m[1] + [...have].join(','));
  }

  // tryMs: how long the extension waits for Gambit on each of its two tries (from the extension,
  // then from the Gambit tab) before cancelling it. Cancelling matters: a request the app gave
  // up on used to keep downloading in Chrome, and with a poll every 2s they piled up and starved
  // every later Gambit request ("bridge timeout" over and over).
  async function fetchOne(url, { tryMs = Number(g.timeoutSec || 20) * 1000 } = {}) {
    if (via === 'extension') {
      if (!bridge?.connected()) throw new Error('Chrome extension not connected (needed to read Gambit)');
      const res = await bridge.send('gambit', { kind: 'gambit', url: withCacheBuster(url), method: 'GET', timeoutMs: tryMs,
        headers: { accept: 'application/json, text/plain, */*', ...(g.headers || {}) }, useGambitAuth: true }, 2 * tryMs + 4000);
      if (res.status === 401 || res.status === 403) throw new Error(`Gambit HTTP ${res.status}: log in again in the Gambit tab`);
      if (res.status >= 400 || !res.json) throw new Error(`Gambit HTTP ${res.status}${res.text ? `: ${String(res.text).slice(0, 120)}` : ''}`);
      return res.json;
    }
    const res = await fetch(withCacheBuster(url), {
      method: g.method || 'GET',
      headers: { ...(g.headers || {}), ...(process.env.GAMBIT_AUTH ? { authorization: process.env.GAMBIT_AUTH } : {}) },
      body: g.body ? JSON.stringify(g.body) : undefined,
    });
    if (!res.ok) throw new Error(`Gambit HTTP ${res.status}`);
    return res.json();
  }

  // Books whose real prices the app reads itself: Gambit's other rows for them become candidates too.
  const shadow = (cfg.books || []).filter((b) => ['betrivers', 'hardrock'].includes(b) && cfg[b]?.directPrices !== false);
  // Gambit's arbitrage table: player props priced off DraftKings/FanDuel/Caesars (gambit-arbs.js).
  const arb = arbDefaults(cfg);
  const arbBooks = arb ? arb.books.filter((b) => (cfg.books || []).includes(b)) : [];
  const arbIds = arb ? Object.values(arb.refBooks).flat() : [];
  let arbErrAt = 0;
  const sampled = new Set();   // arbs.json links already saved to a sample file
  let arbFair = new Map();   // DK/FD/Caesars fair price of every prop in the arbitrage table (closing line value)
  const arbState = { error: null, rows: 0 };
  // The arbitrage table is big (pre-game is tens of MB on a busy evening) and can take longer to
  // download than a 2s poll. So it loads in the background, one download at a time, and never
  // holds up the +EV table. Its rows are used while they're fresh (arbProps.maxAgeSec, default 30).
  // It only starts after the +EV table has come in (so the two never share a slow connection)
  // and at most once per arbProps.everySec (default 20), which also keeps the data use down.
  const arbMaxAge = (Number(arb?.maxAgeSec) || 30) * 1000;
  const arbEvery = (Number(arb?.everySec) || 20) * 1000;
  let arbStartedAt = 0;
  const arbTryMs = (Number(arb?.timeoutSec) || 25) * 1000;
  let arbRows = [], arbAt = 0, arbLoading = null;
  function loadArbs() {
    if (arbLoading || !arb || !arbBooks.length || !arb.urls.length) return arbLoading;
    if (Date.now() - arbStartedAt < arbEvery) return null;
    arbStartedAt = Date.now();
    arbLoading = (async () => {
      const out = [];
      const nextArbFair = new Map();   // kept from the last good fetch if this one fails
      try {
        for (const url of arb.urls) {
          const json = await fetchOne(withBookIds(url, arbIds), { tryMs: arbTryMs });
          // One real response per link that has player props in it (live and pre-game files), so the
          // reading of arbs.json can be checked: arbs-sample-live.json / arbs-sample-pregame.json.
          if (root && !sampled.has(url) && /PLAYER_PROP/.test(JSON.stringify(json))) {
            sampled.add(url);
            const kind = /[?&]isLive=true/.test(url) ? 'live' : /[?&]isLive=false/.test(url) ? 'pregame' : String(arb.urls.indexOf(url) + 1);
            try { fs.writeFileSync(path.join(root, `arbs-sample-${kind}.json`), JSON.stringify(json, null, 1)); } catch {}
          }
          out.push(...arbsToRows(json, g, { ...arb, books: arbBooks }, nextArbFair));
        }
        arbFair = nextArbFair;
        arbRows = out; arbAt = Date.now();
        arbState.error = null;
      } catch (e) {
        arbState.error = e.message;
        if (Date.now() - arbErrAt > 60e3) { arbErrAt = Date.now(); log?.warn(`Gambit arbitrage table fetch failed (${e.message}); +EV table still used`); }
      } finally { arbLoading = null; }
    })();
    return arbLoading;
  }
  function fetchArbs() {
    loadArbs();
    const rows = Date.now() - arbAt <= arbMaxAge ? arbRows : [];
    arbState.rows = rows.length;
    return rows;
  }
  let fair = new Map();   // every selection's fair price in the last poll (for closing line value)
  return {
    needsBridge: via === 'extension',
    fairIndex: () => fair,
    arbFairIndex: () => arbFair,
    arb: arb ? { cfg: arb, books: arbBooks, state: arbState } : null,
    async fetchRows() {
      const list = urls();
      if (!list.length || list.some((u) => u.startsWith('PASTE_'))) throw new Error('gambit.url not set in config.json');
      const out = [];
      const nextFair = new Map();
      for (const url of list) {
        const json = await fetchOne(withBookIds(url));
        if (Array.isArray(json?.evs)) { out.push(...evsToRows(json, g, nextFair, { shadow })); continue; }   // Gambit's evs.json
        const rows = g.rowsPath ? get(json, g.rowsPath) : json;
        if (!Array.isArray(rows)) throw new Error(`Gambit: rowsPath "${g.rowsPath}" is not an array`);
        out.push(...rows.map((r) => normalizeRow(r, g.fields)));
      }
      fair = nextFair;
      out.push(...fetchArbs());
      return out;
    },
  };
}
