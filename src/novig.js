// Novig confirmation: a bet is only placed when Novig's price also says it is +EV
// (default >= 2%). Novig's odds come either from extra columns in the Gambit row
// (novig.mode = "gambit") or from a separate Novig request (novig.mode = "feed").
// If Novig has no price for the selection, the bet is skipped (fails closed).
import { americanToDecimal, impliedProb } from './ev.js';

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9.+-]/g, '');
export const novigKey = (r) => `${norm(r.event)}|${norm(r.market)}|${norm(r.selection)}|${r.line ?? ''}`;

/** Fair win probability from Novig: de-vig both sides if we have them, else Novig's own price. */
export function novigFairProb(odds, oppOdds) {
  if (odds == null) return null;
  if (oppOdds == null) return impliedProb(odds);
  const p = impliedProb(odds), q = impliedProb(oppOdds);
  return p / (p + q);
}

/** EV % of betting `bookOdds` using Novig as the fair price. */
export function novigEv(bookOdds, nv) {
  if (!nv || nv.prob == null) return null;
  return (nv.prob * americanToDecimal(bookOdds) - 1) * 100;
}

export function makeNovig(cfg) {
  const n = cfg.novig;
  if (!n || n.required === false) return null;
  const minEvPct = n.minEvPct ?? 2;
  const mode = n.mode || 'gambit';

  // mode "feed": one request per poll, indexed by event|market|selection|line.
  let index = new Map();
  async function refresh() {
    if (mode !== 'feed') return;
    if (!n.url || n.url.startsWith('PASTE_')) throw new Error('novig.url not set in config.json');
    const res = await fetch(n.url, {
      method: n.method || 'GET',
      headers: { ...(n.headers || {}), ...(process.env.NOVIG_COOKIE ? { cookie: process.env.NOVIG_COOKIE } : {}),
        ...(process.env.NOVIG_AUTH ? { authorization: process.env.NOVIG_AUTH } : {}) },
      body: n.body ? JSON.stringify(n.body) : undefined,
    });
    if (!res.ok) throw new Error(`Novig HTTP ${res.status}`);
    const json = await res.json();
    const rows = n.rowsPath ? get(json, n.rowsPath) : json;
    if (!Array.isArray(rows)) throw new Error(`Novig: rowsPath "${n.rowsPath}" is not an array`);
    const f = n.fields || {};
    index = new Map();
    for (const raw of rows) {
      const r = Object.fromEntries(Object.entries(f).map(([k, p]) => [k, get(raw, p)]));
      r.line = num(r.line);
      index.set(novigKey(r), { odds: num(r.odds), oppOdds: num(r.oppOdds) });
    }
  }

  /** Novig price for a Gambit row: {odds, oppOdds, prob} or null. */
  function lookup(row) {
    const p = mode === 'feed' ? index.get(novigKey(row)) : { odds: num(row.novigOdds), oppOdds: num(row.novigOppOdds) };
    if (!p || p.odds == null) return null;
    return { ...p, prob: novigFairProb(p.odds, p.oppOdds) };
  }

  /** Does Novig agree that `bookOdds` is at least minEvPct? */
  function check(row, bookOdds) {
    const nv = lookup(row);
    if (!nv) return { ok: false, ev: null, nv, reason: 'no Novig price' };
    const ev = novigEv(bookOdds, nv);
    return { ok: ev >= minEvPct, ev, nv, reason: ev >= minEvPct ? '' : `Novig EV below ${minEvPct}%` };
  }

  return { minEvPct, mode, refresh, lookup, check };
}
