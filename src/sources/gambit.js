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

export function makeGambitSource(cfg) {
  const g = cfg.gambit;
  return {
    async fetchRows() {
      if (!g.url || g.url.startsWith('PASTE_')) throw new Error('gambit.url not set in config.json');
      const res = await fetch(g.url, {
        method: g.method || 'GET',
        headers: { ...(g.headers || {}), ...(process.env.GAMBIT_COOKIE ? { cookie: process.env.GAMBIT_COOKIE } : {}),
          ...(process.env.GAMBIT_AUTH ? { authorization: process.env.GAMBIT_AUTH } : {}) },
        body: g.body ? JSON.stringify(g.body) : undefined,
      });
      if (!res.ok) throw new Error(`Gambit HTTP ${res.status}`);
      const json = await res.json();
      const rows = g.rowsPath ? get(json, g.rowsPath) : json;
      if (!Array.isArray(rows)) throw new Error(`Gambit: rowsPath "${g.rowsPath}" is not an array`);
      return rows.map((r) => normalizeRow(r, g.fields));
    },
  };
}
