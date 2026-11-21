// Fetches the +EV/odds table from Gambit and normalizes each row.
// The exact endpoint and field names come from the request Gambit's own site makes
// (DevTools > Network > Copy as cURL). Put the URL/headers in config.json -> gambit.
import { evPct } from '../ev.js';
import { evsToRows, bookIdLists } from './gambit-evs.js';
import { createHash } from 'node:crypto';
import { log } from '../log.js';

// Seconds since 1970 when a JWT runs out, or 0.
const jwtExp = (t) => { try { return Number(JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()).exp) || 0; } catch { return 0; } };

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

  // Gambit only returns bets for the sportsbooks named in sportsbooks_id, so make sure the
  // books this run bets (e.g. Hard Rock, once its ids are seen in Gambit's links) are in it.
  function withBookIds(url) {
    const m = /([?&]sportsbooks_id=)([^&]*)/.exec(url);
    if (!m) return url;
    const have = new Set(decodeURIComponent(m[2]).split(',').filter(Boolean));
    const lists = bookIdLists(g);
    for (const b of cfg.books || []) for (const id of lists[b] || []) have.add(String(id));
    return url.replace(m[0], m[1] + [...have].join(','));
  }

  // Optional: "gambit": {"login": {"email": "...", "password": "..."}} in config.json. Gambit's login
  // lasts exactly 1 hour (seen in Austin's recording, 2026-11-21) and the site's tab doesn't reliably
  // renew it, so the app logs in by itself (the same request the login form sends, made by the
  // extension) and logs in again 5 minutes before it runs out. Gambit allows more than one login,
  // so the Gambit tab in Chrome isn't affected. Without these settings, the tab's login is used.
  const creds = g.login?.email && g.login?.password ? g.login : null;
  const fingerprintId = creds ? createHash('md5').update(`ev-placer|${String(creds.email).toLowerCase()}`).digest('hex') : null;
  let own = null;   // { auth, exp }
  async function ownLogin(force = false) {
    if (!force && own && own.exp - Date.now() / 1000 > 300) return own.auth;
    const res = await bridge.send('gambit', { kind: 'gambitLogin', url: g.loginUrl || 'https://api.gambitodds.com/session/login', method: 'POST', noTab: true,
      headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json' },
      body: JSON.stringify({ email: creds.email, password: creds.password, fingerprintId }) });
    const token = res.json?.token;
    if (res.status >= 400 || !token) {
      own = null;
      throw new Error(`Gambit login failed (HTTP ${res.status}${res.json?.message ? `: ${res.json.message}` : ''}): check gambit.login email and password in config.json`);
    }
    own = { auth: `Bearer ${token}`, exp: jwtExp(token) || Date.now() / 1000 + 3600 };
    log.info(`Logged into Gambit, good until ${new Date(own.exp * 1000).toTimeString().slice(0, 5)} (logs in again on its own before then)`);
    return own.auth;
  }

  async function fetchOne(url, retried = false) {
    if (via === 'extension') {
      if (!bridge?.connected()) throw new Error('Chrome extension not connected (needed to read Gambit)');
      const headers = { accept: 'application/json, text/plain, */*', ...(g.headers || {}) };
      if (creds) headers.authorization = await ownLogin();
      const res = await bridge.send('gambit', { kind: 'gambit', url: withCacheBuster(url), method: 'GET', headers, useGambitAuth: !creds, noTab: !!creds });
      if (creds && res.status === 401 && !retried) { await ownLogin(true); return fetchOne(url, true); }
      if (res.status === 401 || res.status === 403) throw new Error(`Gambit HTTP ${res.status}: ${creds ? 'Gambit refused the app\'s own login' : 'log in again in the Gambit tab'}`);
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
  let fair = new Map();   // every selection's fair price in the last poll (for closing line value)
  return {
    needsBridge: via === 'extension',
    fairIndex: () => fair,
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
      return out;
    },
  };
}
