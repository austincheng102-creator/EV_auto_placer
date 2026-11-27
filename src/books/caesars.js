// Caesars Sportsbook (Colorado, sportsbook.caesars.com). Requests below match what the site itself
// sent for a $0.10 live spread and a $0.10 pre-game total (Austin's capture, 2026-11-26). Everything
// is JSON on api.americanwagering.com/regions/us/locations/<st>/brands/czr/sb, sent from inside your
// Caesars tab with the page's own login headers (sessionid, playerid, ...; the extension copies the
// newest ones the page sent):
//  - price check: POST v2/bets/details {legs:[...]} -> the selection's current price, line, whether
//                 it can be bet, and the live delay. It makes no bet and keeps nothing on your slip.
//  - place:       POST v2/bets with the price we checked (an idempotency-key, so a retry can never
//                 place it twice). Caesars refuses it if the price moved. Live bets: Caesars holds the
//                 request for its delay (4s on a college basketball spread) and then answers.
//  - results:     GET v2/global/bets/settled/history (My Bets > Settled).
// Money is in cents ("stakePerLine": 10 = $0.10). Gambit's Caesars prices are its Michigan feed
// (links .../us/mi/bet/betslip?selectionIds=<uuid>); the selection id is looked up in Colorado.
// Caesars' location check (GeoComply) runs in its page and is kept on Caesars' side, so a bet
// carries nothing for it. The extension watches the page's check (20 min, cz-geo.js) and reloads the
// Caesars tab if the page hasn't renewed it in time; a bet refused over location renews it at once.
// Logged out (the login lasts 24h): the extension logs back in with the Chrome-saved password.

import { americanToDecimal, decimalToAmerican } from '../ev.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Caesars selection id from a link: ...betslip?selectionIds=<uuid>[,<uuid>] (Gambit, PropProfessor). */
export function caesarsRef(link) {
  let s = String(link || '');
  for (let i = 0; i < 3 && /%[0-9A-Fa-f]{2}/.test(s); i++) { try { s = decodeURIComponent(s); } catch { break; } }
  const m = /selectionIds?=([0-9a-f-]{36})/i.exec(s);
  return m ? { bookRef: m[1].toLowerCase() } : {};
}

/** American odds from a Caesars price ({american: "-115", decimal: 1.86957} or {a, d}). */
export function czAmerican(p) {
  if (!p || typeof p !== 'object') return null;
  const a = Number(String(p.american ?? p.a ?? '').replace(/[^\d+-]/g, ''));
  if (Number.isFinite(a) && Math.abs(a) >= 100) return a;
  const d = Number(p.decimal ?? p.d);
  return Number.isFinite(d) && d > 1 ? decimalToAmerican(d) : null;
}

/** A Caesars price object for American odds, the way the site sends it. */
export function czPrice(am, from = null) {
  if (from && czAmerican(from) === am) {
    const a = Number(String(from.american ?? from.a).replace(/[^\d+-]/g, ''));
    const d = Number(from.decimal ?? from.d), f = from.fractional ?? from.f;
    return { american: String(from.american ?? (a > 0 ? `+${a}` : a)), decimal: d, fractional: f, a, d, f };
  }
  const d = Math.round(americanToDecimal(am) * 1e5) / 1e5;
  // Fraction of the winnings: +120 -> 6/5, -115 -> 20/23 (as the site writes them).
  const [n, m] = am > 0 ? [am, 100] : [100, -am], g = (x, y) => (y ? g(y, x % y) : x), k = g(n, m);
  const f = `${n / k}/${m / k}`;
  return { american: am > 0 ? `+${am}` : String(am), decimal: d, fractional: f, a: am, d, f };
}

// Every error message/code anywhere in a Caesars reply (under "errors"/"error"/"failures" keys).
export function czWhy(j) {
  const out = [];
  const walk = (v, d) => {
    if (!v || typeof v !== 'object' || d > 8) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, d + 1)); return; }
    for (const [k, x] of Object.entries(v)) {
      if (/^(errors?|failures?|rejections?|rejectReasons?)$/i.test(k)) collect(x, out);
      else if (x && typeof x === 'object') walk(x, d + 1);
    }
  };
  walk(j, 0);
  return [...new Set(out.filter(Boolean))];
}
function collect(x, out, d = 0) {
  if (x == null || d > 6) return;
  if (typeof x === 'string' || typeof x === 'number') { out.push(String(x)); return; }
  if (Array.isArray(x)) { x.forEach((y) => collect(y, out, d + 1)); return; }
  const msg = x.message || x.description || x.detail || x.title;
  const code = x.code || x.errorCode || x.type || x.reason;
  if (msg || code) out.push([code, msg].filter(Boolean).join(': '));
  else for (const y of Object.values(x)) if (y && typeof y === 'object') collect(y, out, d + 1);
}

// One settled bet from v2/global/bets/settled/history as a result for results.json. Money is in
// cents; settledBetData.payout is the total return (0 for a loss).
export function settledBet(b) {
  if (!b?.id || String(b.type || 'SGL').toUpperCase() !== 'SGL') return null;
  const s = b.settledBetData || {};
  const st = String(s.result || b.status || '').toLowerCase();
  const result = /cash/.test(st) ? 'cashout'
    : /half/.test(st) ? (/won|win/.test(st) ? 'half-won' : 'half-lost')
    : /won|win/.test(st) ? 'won' : /lost|lose|loss/.test(st) ? 'lost'
    : /push|tie|draw/.test(st) ? 'push' : /void|cancel|refund/.test(st) ? 'void' : null;
  if (!result) return null;
  const cents = (v) => (Number.isFinite(Number(v)) ? Number(v) / 100 : null);
  const payout = result === 'lost' ? 0 : cents(s.payout);
  return {
    betId: String(b.id), result, status: st, payout: payout == null ? null : Math.round(payout * 100) / 100,
    stake: cents(b.totalStake), odds: czAmerican(b.price),
    settledAt: s.settledAt || null, placedAt: b.placedAt || null,
  };
}

const uuid = () => (globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
}));

export function makeCaesars(name, label, cfg, bridge) {
  const c = cfg.caesars || {};
  const st = String(c.state || cfg.region || 'CO').toLowerCase();
  const api = c.host || `https://api.americanwagering.com/regions/us/locations/${st}/brands/czr/sb`;
  const loginMsg = 'Caesars didn\'t accept the login: refresh the Caesars tab and stay logged in';
  const send = (kind, path, method = 'GET', body = null, extra = {}, ms = 20000) => bridge.send(name, {
    kind, url: `${api}/${path}`, method,
    headers: { accept: '*/*', 'content-type': 'application/json', 'correlation-id': uuid(), ...extra },
    ...(body != null ? { body: JSON.stringify(body) } : {}), credentials: 'include', useCaesarsAuth: true,
  }, ms);
  const authFail = (res) => res.status === 401 || res.status === 403;
  const refOf = (row) => (row.bookRef && UUID.test(row.bookRef) ? { bookRef: row.bookRef } : caesarsRef(row.link));
  // What Caesars needs about a selection besides its id (market, event, competition, side, name).
  // Learned from the first price check of a selection and kept, so later checks send what the site sends.
  const known = new Map();   // selection id -> { marketId, eventId, competitionId, selectionType, name }

  function legOf(sel, row, price) {
    const k = known.get(sel) || {};
    const p = price || (Number.isFinite(row.odds) ? czPrice(row.odds) : undefined);
    // The line goes in only once Caesars told us it (PropProfessor's lines carry no sign); the first
    // check sends just the selection id and price, the way a betslip?selectionIds= link starts the slip.
    const line = k.line;
    return {
      selectionId: sel, ...(k.marketId ? { marketId: k.marketId } : {}), ...(k.eventId ? { eventId: k.eventId } : {}),
      ...(k.competitionId ? { competitionId: k.competitionId } : {}), ...(k.selectionType ? { selectionType: k.selectionType } : {}),
      ...(k.name ? { name: k.name } : {}),
      priceType: 'fp', related: false, stakePerLine: 0, ...(p ? { price: p, origPrice: p } : {}),
      source: 'default', section: 'home', isMovingLineSliderSelection: false, eachWay: false, included: true,
      ...(line != null ? { line } : {}),
    };
  }

  // The price check: POST v2/bets/details for the selection (no bet, nothing kept on the slip).
  async function details(sel, row, kind = 'recheck') {
    const res = await send(kind, 'v2/bets/details', 'POST', { legs: [legOf(sel, row)], combinationSelections: [], channel: 'mobile', channelDetail: 'sportsbook', includeMultiLine: false });
    if (authFail(res)) throw new Error(`${loginMsg} (price check HTTP ${res.status})`);
    const j = res.json;
    if (res.status >= 400 || !j) throw new Error(`Caesars price check HTTP ${res.status}: ${String(JSON.stringify(j) || res.text || res.error || '').slice(0, 240)}`);
    const one = (j.singles || []).find((s) => s.selectionId === sel || s.id === sel) || (j.singles || [])[0];
    if (one) {
      const leg = (one.legs || [])[0] || {};
      known.set(sel, { ...(known.get(sel) || {}), marketId: one.marketId || leg.marketId, eventId: one.eventId || leg.eventId,
        ...(Number.isFinite(Number(one.line ?? leg.requestedLine)) ? { line: Number(one.line ?? leg.requestedLine) } : {}) });
      if (known.size > 2000) known.delete(known.keys().next().value);
    }
    return { j, one, why: czWhy(j) };
  }

  const lineOf = (one, row) => {
    if (row.line == null) return row.line;
    const n = Number(one?.line ?? one?.legs?.[0]?.requestedLine);
    return Number.isFinite(n) ? (Math.abs(n) === Math.abs(row.line) ? row.line : n) : row.line;
  };

  return {
    name, label,
    freePriceCheck: true,   // the price check makes no bet: a failed check is checked again on later scans

    async recheck(row) {
      const sel = refOf(row).bookRef;
      if (!sel) throw new Error(`no Caesars selection id in the link (${String(row.link || 'no link').slice(0, 160)})`);
      const { one, why, j } = await details(sel, row);
      if (!one) return { odds: null, line: row.line, suspended: true, why: why.join(', ') || 'Caesars has no such selection in Colorado',
        debug: `Caesars price check for ${sel}: ${JSON.stringify(j).slice(0, 600)}` };
      const odds = czAmerican(one.price);
      return { odds, line: lineOf(one, row), suspended: one.bettable === false || j.bettable === false || odds == null,
        maxStake: null, cz: { sel, one, price: one.price, delay: one.delay },
        debug: `Caesars price check: sent ${row.odds} (feed), Caesars ${odds}, line ${one.line ?? '-'}, delay ${one.delay ?? '-'}s, selection ${sel}` };
    },

    async place(row, stake, quote) {
      const q = quote.cz;
      if (!q) throw new Error('no Caesars price check before the bet');
      const cents = Math.round(stake * 100);
      const one = q.one, leg = (one.legs || [])[0] || {};
      const price = czPrice(quote.odds, czAmerican(q.price) === quote.odds ? q.price : null);
      const line = one.line ?? leg.requestedLine;
      const body = { bets: [{
        type: 'SGL', stakePerLine: cents, eachWay: false,
        legs: [{ type: 'standard', selectionId: q.sel, marketId: one.marketId || leg.marketId, eventId: one.eventId || leg.eventId,
          ...(line != null ? { line: Number(line) } : {}), priceType: 'fp', price }],
        priceType: 'fp', channel: 'desktop', rewardCreditsPerLine: null, rewardCreditsStakePerLine: null, taxPassthroughs: null,
        freebetTokens: null, campaignId: null, tokenType: null,
      }] };
      const key = uuid();
      const res = await send('place', 'v2/bets', 'POST', body, { 'idempotency-key': key }, 60000);
      const j = res.json || {};
      const detail = `Caesars place response (HTTP ${res.status}): ${JSON.stringify(res.json ?? res.text ?? res.error ?? '').slice(0, 3000)}`;
      if (authFail(res) && !/locat|geo/i.test(JSON.stringify(j))) { const e = new Error(loginMsg); e.detail = detail; throw e; }
      const bet = (j.bets || []).find((b) => (b.selectionIds || []).includes(q.sel)) || (j.bets || [])[0];
      if (res.status < 400 && bet?.id) {
        return { betId: `caesars:${bet.id}`, confirmedOdds: czAmerican(bet.price), detail };
      }
      const why = czWhy(j).join(', ') || j.message || `HTTP ${res.status}${res.error ? `, ${res.error}` : ''}`;
      // Location check lapsed (Caesars' page runs GeoComply and keeps it on Caesars' side): nothing was
      // placed. A reload of the Caesars tab makes the page run it again; checked again next scan.
      if (/geo|locat|jurisdiction|outside|region/i.test(why)) {
        bridge.tell?.({ type: 'geoRenew', book: name, why: `a bet was refused over the location check (${why.slice(0, 80)})` });
        const e = new Error(`refused: Caesars' location check had lapsed ("${why.slice(0, 100)}"), nothing was placed; renewing it now (the extension reloads the Caesars tab), the bet is checked again next scan`);
        e.detail = detail; e.notSent = true; e.geoRenewing = true;
        throw e;
      }
      if (/session|log ?in|unauthori[sz]ed|authenticat/i.test(why)) { const e = new Error(`${loginMsg} (${why.slice(0, 120)})`); e.detail = detail; throw e; }
      const err = new Error(`rejected: ${why}`);
      err.detail = detail;
      if (/price|odds/i.test(why)) {
        err.priceMoved = true;
        // A refusal may carry the new price; read it fresh otherwise (the app checks every rule again).
        const now = czAmerican((j.bets || [])[0]?.price || j.price);
        if (now != null && now !== quote.odds) err.newOdds = now;
      } else if (/suspend|closed|not.?(available|active|found|open)|unavailable|inactive|line/i.test(why)) err.gone = true;
      throw err;
    },

    // Settled bets (My Bets > Settled), newest first, until bets older than `from` (ms).
    async settled(from = 0) {
      const out = [];
      let next = null;
      for (let page = 0; page < 30; page++) {
        const path = `v2/global/bets/settled/history?page_size=${c.settledPageSize || 50}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
        const res = await send('history', path, 'GET', null, {}, 30000);
        if (authFail(res)) throw new Error(loginMsg);
        if (res.status >= 400 || !Array.isArray(res.json?.bets)) throw new Error(`Caesars settled bets HTTP ${res.status}: ${String(JSON.stringify(res.json) || res.text || res.error || '').slice(0, 200)}`);
        for (const b of res.json.bets) { const r = settledBet(b); if (r) out.push(r); }
        const oldest = Math.min(...res.json.bets.map((b) => Date.parse(b.placedAt)).filter(Number.isFinite));
        next = res.json.next;
        if (!next || !res.json.bets.length || (Number.isFinite(oldest) && oldest < from)) break;
        if (typeof next === 'object') next = next.cursor ?? next.token ?? JSON.stringify(next);
      }
      return out;
    },

    // Once a minute (session.js): the open-bets list (the site reads it itself) fails when logged out.
    async sessionCheck() {
      const res = await send('session', 'v2/bets/history?status=open&page_size=1', 'GET', null, {}, 15000);
      if (res.status < 400 && Array.isArray(res.json?.bets)) return { ok: true };
      if (authFail(res)) return { ok: false, why: `Caesars answered HTTP ${res.status} to the open-bets list` };
      if (/not seen yet/.test(res.error || '')) return { ok: false, why: res.error };
      throw new Error(`Caesars open-bets check HTTP ${res.status}: ${String(JSON.stringify(res.json) || res.text || res.error || '').slice(0, 120)}`);
    },
  };
}
