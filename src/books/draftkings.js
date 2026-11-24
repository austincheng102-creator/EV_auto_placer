// DraftKings Sportsbook (Colorado, sportsbook.draftkings.com). Requests below match what the site
// itself sent for a $0.10 live straight bet (Austin's capture, 2026-11-23), logged in by the
// tab's cookies:
//  - price check: POST gaming-us-<st>.draftkings.com/api/wager/v1/calculateBets {selections:[{id}]}
//                 -> current odds and a token for exactly that price (no bet is made), plus
//                 GET sportsbook-nash.../selectioninfo for the selection's line and suspension.
//  - place:       POST .../placeBets with that token and autoAcceptMode "None", so DraftKings
//                 refuses the bet if the price moved. Live bets come back "LiveDelay" (3s) with a
//                 waitingBetId; the outcome comes from .../waitingBets (an event stream that ends
//                 once DraftKings decides), read with a short-lived login token (generateEnterpriseJWT).
//  - results:     My Bets > Settled, which the site reads over a WebSocket (gateway .../shelby/api/v1/
//                 websocket?jwt=..., JSON-RPC "BetsRequest" filter Settled, 25 a page, newest first).
// Selection ids ("0ML87369883_1") are the same everywhere, so Gambit's link (?outcomes=<id>) is used.
// DraftKings runs bot detection in its page; bets placed by the app carry no clicks.

import { decimalToAmerican } from '../ev.js';
import { log } from '../log.js';

/** DraftKings selection id from Gambit's link: .../event/<slug>/<eventId>?outcomes=<id>[,<id>] */
export function draftkingsRef(link) {
  const s = decodeURIComponent(decodeURIComponent(String(link || '')));
  const m = /[?&]outcomes=([0-9A-Za-z_]+)/.exec(s);
  return m ? { bookRef: m[1], eventRef: /\/event\/[^/]+\/(\d+)/.exec(s)?.[1] } : {};
}

/** American odds from DraftKings ("−330" with a unicode minus, "+120") or its true decimal odds. */
export function dkAmerican(display, trueOdds) {
  const a = Number(String(display ?? '').replace(/[−–]/g, '-').replace(/[^\d+-]/g, ''));
  if (Number.isFinite(a) && Math.abs(a) >= 100) return a;
  const d = Number(trueOdds);
  return Number.isFinite(d) && d > 1 ? decimalToAmerican(d) : null;
}

/** What DraftKings' waitingBets event stream says: the last JSON event's status, bet id, odds. */
// Each event repeats the whole bet: first status "LiveDelay", then (about 3s later) "Open" with the betId
// when DraftKings takes it (Austin's capture, 2026-11-23). The stream can carry other waiting bets too,
// so only events for our waitingBetId count when one is given.
export function waitingOutcome(text, waitingBetId = null) {
  let last = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^data:\s*(.*)$/.exec(line);
    if (!m) continue;
    try {
      const j = JSON.parse(m[1]);
      if (j && typeof j === 'object' && (!waitingBetId || !j.waitingBetId || j.waitingBetId === waitingBetId)) last = j;
    } catch {}
  }
  if (!last) { try { last = JSON.parse(text); } catch {} }
  if (!last) return null;
  const bet = (last.bets || [])[0] || last.bet || last;
  return {
    status: String(bet.status || last.status || ''),
    betId: bet.betId || bet.id || last.betId || last.receiptId || bet.receiptId || null,
    odds: dkAmerican(bet.displayOdds, bet.trueOdds),
    raw: last,
  };
}

/** The first value of `key` anywhere in a DraftKings answer (depth-limited). */
export function findKey(o, key, d = 0) {
  if (!o || typeof o !== 'object' || d > 6) return null;
  if (!Array.isArray(o) && o[key] != null && typeof o[key] !== 'object') return String(o[key]);
  for (const v of Object.values(o)) { const r = findKey(v, key, d + 1); if (r) return r; }
  return null;
}

const uuid = () => (globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
}));
const OK = /^(placed|accepted|success|succeeded|open|confirmed)$/i;
/** One settled DraftKings bet (My Bets "BetsRequest" reply) as a result for results.json. */
export function dkSettled(b) {
  if (!b?.betId || (b.numberOfSelections ?? 1) !== 1 || !/^settled$/i.test(String(b.status || ''))) return null;
  const st = String(b.settlementStatus || '');
  const result = /cash/i.test(st) ? 'cashout' : /half/i.test(st) ? (/won|win/i.test(st) ? 'half-won' : 'half-lost')
    : /won|win/i.test(st) ? 'won' : /lost|lose/i.test(st) ? 'lost' : /push|tie|draw/i.test(st) ? 'push'
    : /void|cancel|refund/i.test(st) ? 'void' : null;
  if (!result) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
  // What was bet on, for matching bets logged without DraftKings' bet id (resultsync.js).
  const sel = (b.selections || [])[0] || {};
  const label = [sel.selectionDisplayName, sel.marketDisplayName, sel.points, ...(sel.players || []).map((x) => x?.name), ...(sel.participants || []).map((x) => x?.name)]
    .filter((x) => x != null && x !== '').join(' ');
  return { betId: String(b.betId), result, status: st, payout: result === 'lost' ? 0 : n(b.returns), stake: n(b.stake),
    odds: dkAmerican(b.displayOdds), settledAt: b.settlementDate || null, placedAt: b.placementDate || null,
    selectionId: sel.selectionId || null, label: label || null };
}

const BAD = /reject|declin|fail|cancel|error|expired/i;

export function makeDraftKings(name, label, cfg, bridge) {
  const k = cfg.draftkings || {};
  const st = String(cfg.region || 'CO').toLowerCase();
  const wager = `https://gaming-us-${st}.draftkings.com/api/wager/v1`;
  const site = `dkus${st}`;
  const info = `https://sportsbook-nash.draftkings.com/api/sdinfo/${site}/v1/selectioninfo`;
  const gateway = k.gateway || `https://gateway.northamerica-northeast2.prod.dkapis.com/${site}/betting/v2`;
  const slipHeaders = { accept: '*/*', 'content-type': 'application/json', clienttype: 'Website', 'x-client-name': 'web',
    'x-client-feature': 'betslip', 'x-client-page': 'home', 'x-client-widget-name': 'betslip' };
  const loginMsg = 'DraftKings didn\'t accept the login: refresh the DraftKings tab and stay logged in';
  const send = (kind, url, method, body, extra = {}, ms = 20000, more = {}) => bridge.send(name, {
    kind, url, method, headers: { ...extra }, body: body == null ? undefined : JSON.stringify(body), credentials: 'include', ...more }, ms);
  const authFail = (r) => r.status === 401 || r.status === 403;
  // DraftKings' bot filter answers price checks HTTP 403 when they come too often (Austin, 2026-11-23:
  // "Failed to fetch (Chrome: net::ERR_FAILED after an HTTP 403 answer)"). Price checks go out at most
  // one every minGapSec (default 2) across all bets, and after a 403 they stop for a while (1 min, then
  // 2 min while it keeps refusing (maxPauseMin, Austin chose 2); back to 1 min after a check goes through).
  // Bets are never sent without a price check, so nothing is placed while paused.
  const minGap = Number(k.minGapSec ?? 2) * 1000;
  let gate = Promise.resolve(), lastAt = 0, blockedUntil = 0, blockMs = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const takeTurn = () => {
    const turn = gate.then(async () => { const wait = lastAt + minGap - Date.now(); if (wait > 0) await sleep(wait); lastAt = Date.now(); });
    gate = turn.catch(() => {});
    return turn;
  };
  const paused = () => {
    const e = new Error(`DraftKings price checks paused until ${new Date(blockedUntil).toLocaleTimeString()} (its bot filter refused them with HTTP 403)`);
    e.paused = true; e.until = blockedUntil;
    return e;
  };
  const refused403 = (msg) => /HTTP 403/.test(String(msg || ''));
  const noteBlocked = () => {
    blockMs = Math.min(Math.max(blockMs * 2, 60e3), Number(k.maxPauseMin ?? 2) * 60e3);
    blockedUntil = Date.now() + blockMs;
    log.warn(`DraftKings refused a price check with HTTP 403 (its bot filter): no DraftKings price checks or bets for ${Math.round(blockMs / 60e3)} min, until ${new Date(blockedUntil).toLocaleTimeString()}`);
  };
  const why = (j) => [j?.errorCode, j?.errorMessage, j?.message, j?.status, ...(j?.errors || []).map((e) => e?.message || e?.code || e?.errorCode)]
    .filter((x) => x && !OK.test(String(x))).join(', ');
  const lineOf = (sel, row) => {
    if (row.line == null) return row.line;
    const p = Number(sel?.points ?? NaN);
    const inName = String(sel?.betSlipLine || sel?.label || '').match(/[+-]?\d+(?:\.\d+)?(?!.*\d)/);
    const n = Number.isFinite(p) ? p : Number(inName?.[0]);
    return Number.isFinite(n) ? (Math.abs(n) === Math.abs(row.line) ? row.line : n) : row.line;
  };

  async function loginJwt() {
    const r = await send('status', `${wager}/generateEnterpriseJWT`, 'GET', null, { accept: '*/*' }, 15000);
    if (authFail(r) || (r.status < 400 && !r.json?.token)) throw new Error(loginMsg);
    if (r.status >= 400) throw new Error(`DraftKings login token HTTP ${r.status}`);
    return r.json.token;
  }

  const book = {
    name, label,
    // Live bets wait out DraftKings' delay (3-6s) before a counter-offer comes: its re-check uses
    // Gambit's newest fair price, not the one from before the delay.
    freshFairOnRetry: true,
    // The price check (calculateBets + selection info) makes no bet, so a failed check is checked
    // again on later scans. DraftKings watches for bots, so a watched bet is re-checked at most
    // every 10s ("draftkings": {"recheckWatchSec": 10}; 5 drew HTTP 403s from its bot filter).
    freePriceCheck: true,
    recheckWatchSec: 10,

    async recheck(row) {
      const id = row.bookRef || draftkingsRef(row.link).bookRef;
      if (!id) throw new Error(`no DraftKings selection id in Gambit's link (${String(row.link || 'no link').slice(0, 160)})`);
      if (Date.now() < blockedUntil) throw paused();
      await takeTurn();
      if (Date.now() < blockedUntil) throw paused();
      try { const q = await check(row, id); blockMs = 0; return q; }
      catch (e) {
        if (refused403(e.message)) { if (Date.now() >= blockedUntil) noteBlocked(); const p = paused(); p.message = e.message; throw p; }
        throw e;
      }
    },
  };
  async function check(row, id) {
    {
      // The odds/token check and the selection's details go out together: both are reads.
      const [calc, si] = await Promise.all([
        send('recheck', `${wager}/calculateBets`, 'POST', { selections: [{ id }], selectionsForYourBet: [], oddsStyle: 'american' },
          { ...slipHeaders, 'x-request-client-timestamp': String(Date.now()) }),
        // The details (line, suspended) are a nice-to-have: the price token from calculateBets is for
        // this exact selection (DraftKings' selection id includes the line), and no token = suspended.
        // So if this read fails (Austin, 2026-11-23: "Failed to fetch" several times), the check goes on
        // without it instead of failing the bet.
        send('recheck', `${info}?siteName=${site}&selectionIds=${encodeURIComponent(id)}`, 'GET', null, { accept: '*/*', 'x-pe-cn': 'web', 'x-pe-ep': 'SB', 'x-pe-loc': `US-${st.toUpperCase()}` })
          .catch((e) => ({ status: 0, error: String(e?.message || e) })),
      ]);
      if (authFail(calc)) throw new Error(loginMsg);
      if (calc.status >= 400 || !calc.json) throw new Error(`price check HTTP ${calc.status}: ${why(calc.json) || String(calc.text || '').slice(0, 200)}`);
      const bet = (calc.json.bets || []).find((b) => b.type === 'Single');
      const sel = (si.json?.selections || []).find((s) => s.id === id);
      const mk = (si.json?.markets || []).find((m) => m.id === sel?.marketId);
      if (!bet?.token) return { odds: null, line: row.line, suspended: true, why: why(calc.json) };
      const max = Number(bet.maxStake);
      return { odds: dkAmerican(bet.displayOdds, bet.trueOdds), line: sel ? lineOf(sel, row) : row.line,
        suspended: !!mk?.isSuspended || sel?.isSuspended === true, maxStake: Number.isFinite(max) && max > 0 ? max : null,
        dk: { id, token: bet.token, trueOdds: bet.trueOdds, displayOdds: bet.displayOdds } };
    }
  }
  Object.assign(book, {

    async place(row, stake, quote) {
      let q = quote.dk;
      if (!q?.token) throw new Error('no DraftKings price token from the price check');
      // A DraftKings counter-offer ("NewOffer", open for its delayPeriod, 120s) that the app has just
      // checked against every rule at the offered price: take it the way the site's Accept button does,
      // POST acceptPurchase {waitingBetId, newOfferId} (Austin's capture 2026-11-23 22:24 UTC). Sending
      // the bet again instead was always refused "RepeatedBets" while the offer was open.
      const off = q.offer;
      if (off && off.odds === quote.odds && Date.now() < off.until) {
        const res = await send('place', `${wager}/acceptPurchase`, 'POST', { waitingBetId: off.waitingBetId, newOfferId: off.newOfferId },
          { ...slipHeaders, accept: 'application/json', 'x-request-client-timestamp': String(Date.now()) }, 30000);
        return answer(res, { ...q, offer: null }, 'acceptPurchase', `accepted DraftKings' counter-offer ${quote.odds > 0 ? '+' : ''}${quote.odds}; `);
      }
      // A retry after a price move comes with the new price but the old price's token: get a fresh
      // token, and bet only if it's still that price.
      if (dkAmerican(q.displayOdds, q.trueOdds) !== quote.odds) {
        const fresh = await this.recheck(row);
        if (!fresh.dk?.token || fresh.suspended) { const e = new Error('rejected: no longer offered'); e.gone = true; throw e; }
        if (fresh.odds !== quote.odds) { const e = new Error(`rejected: price is now ${fresh.odds}`); e.priceMoved = true; e.newOdds = fresh.odds; e.newQuote = { dk: fresh.dk }; throw e; }
        q = fresh.dk;
      }
      // Rounded down to the cent, as DraftKings does. The tiny extra keeps float error from taking a
      // cent off (1 x 2.3 = 2.2999999...: DraftKings refused 2.29 with PotentialReturnsCalculation).
      const ret = Math.floor(stake * Number(q.trueOdds) * 100 + 1e-6) / 100;
      const body = {
        bets: [{ type: 'Single', selectionsMapped: [{ id: q.id }], stake, trueOdds: q.trueOdds, displayOdds: q.displayOdds, numberOfBets: 1,
          isSP: false, potentialReturns: ret, token: q.token }],
        selections: [{ id: q.id, trueOdds: q.trueOdds, displayOdds: q.displayOdds }],
        selectionsForYourBet: [], selectionsForProgressiveParlay: [], selectionsForForecast: [], selectionsForTricast: [], selectionsForCombinator: [],
        locale: 'en', oddsStyle: 'american', autoAcceptMode: 'None',
      };
      const res = await send('place', `${wager}/placeBets`, 'POST', body, { ...slipHeaders, calculationid: uuid(), 'x-request-client-timestamp': String(Date.now()) }, 30000);
      return answer(res, q, 'placeBets', '');
    },
  });
  // DraftKings' answer to placeBets or acceptPurchase: placed, refused, or a counter-offer (in the
  // answer itself, or at the end of the live delay on the waitingBets stream).
  async function answer(res, q, op, note) {
    {
      if (authFail(res)) throw new Error(loginMsg);
      const j = res.json || {};
      const detail = `${note}DraftKings ${op} response: ${JSON.stringify(j || res.text).slice(0, 3000)}`;
      const b0 = (j.bets || [])[0] || {};
      let status = String(b0.status || j.status || '');
      let betId = b0.betId || b0.id || j.betId || j.receiptId || null;
      let odds = dkAmerican(b0.displayOdds, b0.trueOdds);
      let final = null;   // the stream's last event for our bet, if we waited for one
      // Live: wait out DraftKings' delay for its decision.
      let waitNote = '';
      if (/LiveDelay|Pending|Waiting/i.test(status) && j.waitingBetId) {
        try {
          const jwt = await loginJwt();
          // The stream stays open, so the extension reads it as it arrives and stops at our bet's
          // first status other than LiveDelay (extension 0.8.2), or at the time limit.
          const ms = ((Number(b0.delayPeriod) || 3) + 15) * 1000;
          const wid = String(j.waitingBetId).replace(/[^0-9A-Za-z-]/g, '');
          const w = await send('status', `${gateway}/waitingBets?jwt=${encodeURIComponent(jwt)}`, 'GET', null,
            { accept: 'text/event-stream', 'cache-control': 'no-cache' }, ms + 5000,
            { timeoutMs: ms, streamUntil: `"waitingBetId":"${wid}"[^\\n]*"status":"(?!LiveDelay|Active|Pending|Waiting)[A-Za-z]+"[^\\n]*\\n` });
          const o = waitingOutcome(w.text ?? JSON.stringify(w.json), j.waitingBetId);
          if (o?.status) { status = o.status; betId = o.betId || betId; odds = o.odds ?? odds; final = o.raw; }
          waitNote = `waitingBets: HTTP ${w.status}${w.error ? `, ${w.error}` : ''}${w.matched === false ? ', no decision in the stream' : ''}, ${String(w.text || '').length} chars: ${String(w.text || '').slice(-600)}`;
        } catch (e) { waitNote = `waitingBets failed: ${e?.message || e}`; }
        if (/LiveDelay|Pending|Waiting/i.test(status)) {
          // No decision seen: it may still go through, so record it (never bet twice) and say so.
          return { betId: `draftkings:waiting-${j.waitingBetId}`, confirmedOdds: null, detail: `${detail} (no decision seen after the live delay; ${waitNote})` };
        }
      }
      if (res.status < 400 && !/NewOffer/i.test(status) && (OK.test(status) || (betId && !BAD.test(status)))) {
        return { betId: `draftkings:${betId || j.waitingBetId || uuid()}`, confirmedOdds: odds, detail };
      }
      // DraftKings puts the reason in different places (top level, per bet, per error); if none of
      // the usual fields has it, show the start of its answer so the log always says why.
      const deep = (o) => [o?.errorCode, o?.errorMessage, o?.message, o?.description, o?.title, o?.detail, o?.reason, o?.code, o?.type]
        .filter((x) => typeof x === 'string' || typeof x === 'number').map(String).filter((x) => x && !OK.test(x));
      const parts = [...new Set([why(j), why(b0), ...deep(j), ...deep(b0), ...(j.errors || []).flatMap(deep), ...(b0.errors || []).flatMap(deep),
        ...(j.response?.bets || []).flatMap((x) => x?.declineReasons || []).map((d) => [d?.name, d?.reason].filter(Boolean).join(': '))].filter(Boolean))];
      const raw = String(res.text || JSON.stringify(res.json ?? '') || '').replace(/\s+/g, ' ').slice(0, 300);
      const reason = (parts.join(', ') || status || '') + (res.status >= 400 ? ` (HTTP ${res.status}${parts.length ? '' : raw ? `: ${raw}` : ''})` : '');
      const err = new Error(`rejected: ${reason}`);
      err.detail = detail;
      // NewOffer: DraftKings counter-offers another price (open for delayPeriod seconds). It's never
      // accepted here: treated as a price move, so every rule is checked again at the offered price.
      // The offer's price is the stream's (a counter-offer at the end of the live delay) or the answer's.
      // Before 2026-11-23 the log showed the price we sent for stream offers, not the offered one.
      if (/NewOffer/i.test(status)) {
        const src = final || j;
        const fb = (src.bets || [])[0] || {};
        const now = dkAmerican(fb.displayOdds ?? b0.displayOdds, fb.trueOdds ?? b0.trueOdds);
        const newOfferId = findKey(src, 'newOfferId') || findKey(j, 'newOfferId');
        const waitingBetId = findKey(src, 'waitingBetId') || j.waitingBetId;
        err.priceMoved = true;
        err.message = `rejected: DraftKings counter-offered ${now != null ? (now > 0 ? '+' : '') + now : 'another price'} (we sent ${dkAmerican(q.displayOdds, q.trueOdds)})${newOfferId ? '; checking every rule at that price before accepting it' : ', no offer id seen: not accepted'}`;
        if (now != null) {
          err.newOdds = now;
          const secs = Number(fb.delayPeriod ?? b0.delayPeriod) || 120;
          if (newOfferId && waitingBetId) err.newQuote = { dk: { ...q, offer: { newOfferId, waitingBetId, odds: now, until: Date.now() + (secs - 10) * 1000 } } };
        }
        if (final && final !== j) err.detail = `${detail}; waitingBets: ${JSON.stringify(final).slice(0, 1500)}`;
      } else if (/odds|price/i.test(reason)) err.priceMoved = true;
      else if (/suspend|closed|unavailable|not.?available|RepeatedBets|already placed/i.test(reason)) err.gone = true;
      // "Missing or false PlaySportsbook": DraftKings' location check (GeoComply) has lapsed, so the
      // login isn't allowed to bet (Austin, 2026-11-23, same morning BetMGM couldn't reach the
      // GeoComply app). The extension renews it (reloads the DraftKings tab, which runs a new check),
      // and the bet is checked again from the start next scan, like theScore's.
      if (/PlaySportsbook/i.test(reason)) {
        err.message = `rejected: DraftKings' location check has lapsed (${reason}); nothing was placed. Renewing it (reloading the DraftKings tab); the bet is checked again next scan. If this keeps happening, check the GeoComply location app is running on this PC`;
        bridge.tell?.({ type: 'geoRenew', book: name, why: 'DraftKings refused a bet: its location check had lapsed (PlaySportsbook)' });
        err.notSent = true; err.geoRenewing = true;
      }
      throw err;
    }
  }

  return {
    ...book,

    // Settled bets placed since `from` (ms), newest first, read 25 at a time like the My Bets page.
    async settled(from = 0) {
      const ws = `${(k.gateway || 'https://gateway.northamerica-northeast2.prod.dkapis.com').replace(/^https/, 'wss').replace(/\/[^/]*\/betting\/v2$/, '')}/${site}/shelby/api/v1/websocket?format=json`;
      const out = [];
      for (let page = 0; page < 20; page++) {
        const jwt = await loginJwt();
        const init = uuid(), id = uuid();
        const msgs = [
          JSON.stringify({ jsonrpc: '2.0', method: 'InitializeBetsPageRequest', id: init, params: { betsRequest: { filter: { status: 'All' }, pagination: { count: 25, skip: 0 }, ScoreboardType: 'EventScore' }, cashOut: { information: true, pullOperations: true }, locale: 'en' } }),
          JSON.stringify({ jsonrpc: '2.0', method: 'BetsRequest', id, params: { filter: { status: 'Settled' }, orderCriteria: { orderBy: 'placementDate', direction: 'DESC' }, pagination: { count: 25, skip: page * 25 }, locale: 'en', ScoreboardType: 'EventScore' } }),
        ];
        const r = await send('history', `${ws}&jwt=${encodeURIComponent(jwt)}`, 'GET', null, {}, 25000, { ws: { send: msgs, replyId: id }, timeoutMs: 20000 });
        if (r.error && !r.json) throw new Error(`DraftKings My Bets: ${r.error}`);
        if (r.json?.error) throw new Error(`DraftKings My Bets: ${JSON.stringify(r.json.error).slice(0, 200)}`);
        const bets = r.json?.result?.bets || [];
        for (const b of bets) { const x = dkSettled(b); if (x) out.push(x); }
        const oldest = Math.min(...bets.map((b) => Date.parse(b.placementDate)).filter(Number.isFinite));
        if (bets.length < 25 || !(oldest > from)) break;
      }
      return out;
    },

    // Once a minute (session.js): the short login token the site asks for before betting.
    async sessionCheck() {
      try { await loginJwt(); return { ok: true }; }
      catch (e) { if (/login/i.test(e.message)) return { ok: false, why: e.message }; throw e; }
    },
  };
}
