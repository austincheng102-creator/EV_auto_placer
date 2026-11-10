// Fetches the +EV/odds table from Gambit and normalizes each row.
// The exact endpoint and field names come from the request Gambit's own site makes
// (DevTools > Network > Copy as cURL). Put the URL/headers in config.json -> gambit.
import { evPct } from '../ev.js';

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
export function makeGambitSource(cfg, bridge) {
  const g = cfg.gambit;
  const via = g.via || 'extension';
  const withCacheBuster = (u) => `${u}${u.includes('?') ? '&' : '?'}_t=${Date.now()}`;
  const urls = () => (Array.isArray(g.urls) ? g.urls : [g.url]).filter(Boolean); // live + pre-game

  async function fetchOne(url) {
    if (via === 'extension') {
      if (!bridge?.connected()) throw new Error('Chrome extension not connected (needed to read Gambit)');
      const res = await bridge.send('gambit', { kind: 'gambit', url: withCacheBuster(url), method: 'GET',
        headers: { accept: 'application/json, text/plain, */*', ...(g.headers || {}) }, useGambitAuth: true });
      if (res.status === 401 || res.status === 403) throw new Error(`Gambit HTTP ${res.status}: log in again in the Gambit tab`);
      if (res.status >= 400 || !res.json) throw new Error(`Gambit HTTP ${res.status}`);
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

  return {
    needsBridge: via === 'extension',
    async fetchRows() {
      const list = urls();
      if (!list.length || list.some((u) => u.startsWith('PASTE_'))) throw new Error('gambit.url not set in config.json');
      const out = [];
      for (const url of list) {
        const json = await fetchOne(url);
        const rows = g.rowsPath ? get(json, g.rowsPath) : json;
        if (!Array.isArray(rows)) throw new Error(`Gambit: rowsPath "${g.rowsPath}" is not an array`);
        out.push(...rows.map((r) => normalizeRow(r, g.fields)));
      }
      return out;
    },
  };
}
