// theScore Bet (Colorado, sportsbook.thescore.bet; formerly ESPN Bet). Requests below match what
// the site itself sent for a $0.10 live straight bet (Austin's capture, 2026-11-23). Everything
// is GraphQL "persisted queries" on sportsbook.us-co.thescore.bet, logged in by the tab's cookies:
//  - price check: BetslipAddMarketSelection (puts the selection on your theScore bet slip, as a
//    click on the odds does) -> the selection's current odds and status, and the draft bet/leg ids.
//  - place:       BetslipSetDraftBetAmount (the stake), then BetslipPlaceBets with the odds we
//                 checked. Price changes are never accepted for you (the site asks first).
//                 Live bets: theScore holds the request ~9s before it answers.
//  - results:     BetHistorySection "settled" (My Bets > Settled).
// Selection ids are the same everywhere, so Gambit's link (market_selection_id[0]=<id>) is used.
// The price check puts the pick on your theScore bet slip, so the app takes it off again when no bet
// follows, and takes off any other pick it finds there that isn't one of its own checks in progress
// (Austin, 2026-11-23: leftover picks piled up and the slip switched to its parlay tab). Each bet is
// always sent as its own straight bet, whatever else is on the slip.

import { decimalToAmerican, americanToDecimal } from '../ev.js';

// Persisted query hashes from the site's own requests (version 26.22.0). If theScore updates its
// site and these stop working, "thescore": {"queries": {...}} can replace them.
export const TS_QUERIES = {
  BetslipAddMarketSelection: '2498f2b6a9a13dece42e3fc9acf539cceb3609882b1f7486ef96eebdaee0ee52',
  BetslipSetDraftBetAmount: '87f9aa6d181e5803b9dc8cb1ed63c7a44865018094facc7bab1323ec3d360ada',
  BetslipPlaceBets: 'ed2205e45e0de7f40f6a0dd2971bca2f75020a7556d6abc1847a2ce4be054011',
  BetHistorySection: 'e78fa271d080f9d7d2cd5c8df3a002b1bd8af9870d956f9a8a1da9597176875f',
  SpentInSession: 'd4de4e54fa944b2363993c64d3a1c2eb248ffc66c6042a0724c06fae96ffdd2e',
  BetslipRemoveMarketSelection: '448fff337fa83adb0b3c279ec93b13fc1255efda2428749aa182ea24044c3832',
};

/** theScore selection id from Gambit's link: ...?market_selection_id[0]=<uuid>&odds_numerator[0]=.. */
export function thescoreRef(link) {
  const s = decodeURIComponent(String(link || ''));
  const id = /market_selection_id\[\d*\]=([0-9a-f-]{36})/i.exec(s)?.[1];
  if (!id) return {};
  const num = /odds_numerator\[\d*\]=(\d+)/i.exec(s)?.[1], den = /odds_denominator\[\d*\]=(\d+)/i.exec(s)?.[1];
  return { bookRef: id, ...(num && den ? { tsOdds: { numeratorLong: num, denominatorLong: den } } : {}) };
}

/** theScore fractional odds {numeratorLong, denominatorLong} (decimal = num / den) -> American. */
export function tsAmerican(o) {
  const n = Number(o?.numeratorLong), d = Number(o?.denominatorLong);
  if (Number.isFinite(n) && Number.isFinite(d) && d > 0 && n > d) return decimalToAmerican(n / d);
  const f = Number(String(o?.formattedOdds || '').replace(/[^\d+-]/g, ''));
  return Number.isFinite(f) && f !== 0 ? f : null;
}
/** American odds -> theScore fraction (decimal = num / den), in lowest terms over 100ths. */
export function tsFraction(am) {
  const dec = americanToDecimal(am);
  let n = Math.round(dec * 100), d = 100;
  const g = (a, b) => (b ? g(b, a % b) : a);
  const k = g(n, d); n /= k; d /= k;
  return { denominatorLong: String(d), numeratorLong: String(n) };
}

/** Our selection's draft leg (and its draft bet) anywhere in a betslip reply. */
export function findDraft(betslip, selId) {
  let out = null;
  const walk = (v, bet, d) => {
    if (out || !v || typeof v !== 'object' || d > 12) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, bet, d + 1)); return; }
    const isBet = v.__typename === 'DraftBet' || (Array.isArray(v.draftLegs) && /^DraftBet:/.test(String(v.id)));
    if (isBet && (v.draftLegs || []).length === 1 && v.draftLegs[0]?.marketSelection?.rawId === selId) { out = { bet: v, leg: v.draftLegs[0] }; return; }
    for (const x of Object.values(v)) walk(x, isBet ? v : bet, d + 1);
  };
  walk(betslip?.straight || betslip, null, 0);
  return out;
}

const errorsOf = (j) => {
  const out = [];
  const walk = (v, d) => {
    if (!v || typeof v !== 'object' || d > 10) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, d + 1)); return; }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'errors' && Array.isArray(x)) for (const e of x) out.push(typeof e === 'string' ? e : e?.message || e?.code || e?.type || e?.__typename || JSON.stringify(e).slice(0, 120));
      else if (x && typeof x === 'object') walk(x, d + 1);
    }
  };
  walk(j, 0);
  return [...new Set(out.filter(Boolean))];
};

// One settled bet from BetHistorySection settled as a result for results.json. Money is in
// cents (amountLong). payoutAmount is the total return (0 for a loss).
export function settledNode(n) {
  if (!n?.rawId || (n.numLegs ?? 1) !== 1) return null;
  const st = String(n.overrideOutcome || n.outcome || n.status || '').toUpperCase();
  const result = /CASH/.test(st) || n.cashoutAmount ? 'cashout'
    : /HALF/.test(st) ? (/WON|WIN/.test(st) ? 'half-won' : 'half-lost')
    : /WON|WIN/.test(st) ? 'won' : /LOST|LOSE|LOSS/.test(st) ? 'lost'
    : /PUSH|TIE|DRAW/.test(st) ? 'push' : /VOID|CANCEL|REFUND/.test(st) ? 'void' : null;
  if (!result) return null;
  const cents = (m) => (m && Number.isFinite(Number(m.amountLong)) ? Number(m.amountLong) / 100 : null);
  const payout = result === 'cashout' ? cents(n.cashoutAmount) : result === 'lost' ? 0 : cents(n.payoutAmount);
  return {
    betId: String(n.rawId), result, status: st, payout: payout == null ? null : Math.round(payout * 100) / 100,
    stake: cents(n.betAmount), odds: tsAmerican(n.totalOdds),
    settledAt: n.closedAt || null, placedAt: n.placedAt || null,
  };
}

export function makeTheScore(name, label, cfg, bridge) {
  const t = cfg.thescore || {};
  const st = String(cfg.region || 'CO').toLowerCase();
  const api = t.host || `https://sportsbook.us-${st}.thescore.bet/graphql/persisted_queries`;
  const Q = { ...TS_QUERIES, ...(t.queries || {}) };
  const version = t.appVersion || '26.22.0';
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'apollographql-client-name': 'espnbet-espnbet-web',
    'apollographql-client-version': version, 'x-app': 'espnbet', 'x-app-version': version, 'x-client': 'espnbet', 'x-device': 'DESKTOP',
    'x-platform': 'web', 'x-time-format': 'TWELVE_HOUR', 'x-timezone': t.timezone || 'America/Denver' };
  const loginMsg = 'theScore didn\'t accept the login: refresh the theScore tab and stay logged in';
  const ext = (op) => ({ persistedQuery: { version: 1, sha256Hash: Q[op] } });
  async function gql(kind, op, variables, { get = false, ms = 25000 } = {}) {
    const url = get
      ? `${api}/${Q[op]}?operationName=${op}&variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(ext(op)))}`
      : `${api}/${Q[op]}`;
    const res = await bridge.send(name, { kind, url, method: get ? 'GET' : 'POST', headers: { ...headers }, credentials: 'include', useTheScoreAuth: true,
      ...(get ? {} : { body: JSON.stringify({ operationName: op, variables, extensions: ext(op) }) }) }, ms);
    const j = res.json || {};
    const gerr = (j.errors || []).map((e) => e?.message || e?.extensions?.code).filter(Boolean).join(', ');
    if (res.status === 401 || res.status === 403 || /unauth|not.?logged|login|authenticat/i.test(gerr)) {
      throw new Error(`${loginMsg} (${op}: HTTP ${res.status}${gerr ? `, ${gerr.slice(0, 160)}` : ''}${res.error ? `, ${res.error}` : ''})`);
    }
    if (/PersistedQueryNotFound/i.test(gerr)) throw new Error(`theScore changed its site (query ${op} not found): needs an app update`);
    if (res.status >= 400 || !j.data) throw new Error(`theScore ${op} HTTP ${res.status}: ${gerr || String(JSON.stringify(j) || res.text || '').slice(0, 200)}`);
    return j.data;
  }
  const lineOf = (leg, row) => {
    if (row.line == null) return row.line;
    const p = Number(leg.marketSelection?.points?.decimalPoints ?? leg.marketSelection?.points ?? NaN);
    const inName = String(leg.marketSelection?.name?.fullName || '').match(/[+-]?\d+(?:\.\d+)?(?!.*\d)/);
    const n = Number.isFinite(p) ? p : Number(inName?.[0]);
    return Number.isFinite(n) ? (Math.abs(n) === Math.abs(row.line) ? row.line : n) : row.line;
  };

  // Picks the app has on the slip for a check or bet still in progress (selection id -> when added).
  const active = new Map();
  const kept = new Set();   // placed with keepBetslipSelections (other checks were on the slip)
  let tidying = Promise.resolve();
  const opts = { oddsFormat: 'AMERICAN', includeOddsTrend: false, includeSurcharge: false, isSubscription: false };
  // Takes picks off the slip one at a time, after the bet work (never holds up a check or a bet).
  const removeSel = (slipId) => {
    tidying = tidying.then(() => gql('tidy', 'BetslipRemoveMarketSelection', { ...opts, selectionId: slipId }, { ms: 15000 })).catch(() => {});
    return tidying;
  };
  const slipIdOf = (m) => m?.id || (m?.rawId ? `BetslipMarketSelection:${m.rawId}` : null);
  // Everything on the slip that isn't one of our checks in progress (picks left from earlier checks,
  // or from before an app restart). Also forgets picks stuck in `active` for over 3 minutes.
  const tidy = (slip) => {
    for (const [id, at] of active) if (Date.now() - at > 180e3) active.delete(id);
    for (const m of slip?.marketSelections || []) if (m?.rawId && !active.has(m.rawId)) { const id = slipIdOf(m); if (id) removeSel(id); }
  };

  return {
    name, label,
    freePriceCheck: true,   // the bet-slip price check makes no bet: a failed check is checked again on later scans
    oneAtATime: true,   // one shared bet slip: the app sends theScore one bet at a time

    // The price check: theScore's current odds for the selection (via its bet slip).
    async recheck(row) {
      const sel = row.bookRef || thescoreRef(row.link).bookRef;
      if (!sel) throw new Error(`no theScore selection id in Gambit's link (${String(row.link || 'no link').slice(0, 160)})`);
      active.set(sel, Date.now());
      let d;
      try {
        d = await gql('recheck', 'BetslipAddMarketSelection', { isSubscription: false,
          input: { selectionId: `MarketSelection:${sel}`, odds: row.tsOdds || tsFraction(row.odds), selectionOrigin: null },
          oddsFormat: 'AMERICAN', includeOddsTrend: true, includeSurcharge: false });
      } catch (e) { active.delete(sel); throw e; }
      const slip = d.betslipAddMarketSelection;
      tidy(slip);
      const hit = findDraft(slip, sel);
      if (!hit) return { odds: null, line: row.line, suspended: true, why: errorsOf(slip).join(', ') };
      const ms = hit.leg.marketSelection || {};
      return { odds: tsAmerican(ms.odds), line: lineOf(hit.leg, row), suspended: !/^OPEN$/i.test(String(ms.status || 'OPEN')) || hit.leg.errors?.length > 0,
        maxStake: null, draft: { betId: hit.bet.id, legId: hit.leg.id, selId: sel, odds: ms.odds, delayMs: hit.bet.placeBetDelayMilliseconds } };
    },

    async place(row, stake, quote) {
      const dr = quote.draft;
      if (!dr) throw new Error('no theScore bet slip entry from the price check');
      const cents = Math.round(stake * 100);
      const set = await gql('place', 'BetslipSetDraftBetAmount', { isSubscription: false, amount: cents, oddsFormat: 'AMERICAN', draftBetId: dr.betId,
        amountField: 'BET', includeOddsTrend: true, includeSurcharge: false });
      // The slip answers with the selection's current price. Live prices can move between the price
      // check and this call (Austin's capture: -310 at the check, -420 here), so a different price is
      // treated as a price move: nothing is placed, and the app checks every rule again at the new price.
      const now = findDraft(set?.betslipSetDraftBetAmount, dr.selId);
      const nowOdds = now ? tsAmerican(now.leg.marketSelection?.odds) : null;
      if (nowOdds != null && nowOdds !== quote.odds) {
        const e = new Error(`rejected: price is now ${nowOdds}`);
        e.priceMoved = true; e.newOdds = nowOdds;
        e.newQuote = { draft: { ...dr, betId: now.bet.id, legId: now.leg.id, odds: now.leg.marketSelection.odds } };
        throw e;
      }
      const odds = tsAmerican(dr.odds) === quote.odds ? dr.odds : tsFraction(quote.odds);
      const keep = active.size > 1;
      if (keep) kept.add(dr.selId);
      const win = Math.round(cents * (Number(odds.numeratorLong) / Number(odds.denominatorLong) - 1));
      const d = await gql('place', 'BetslipPlaceBets', { isSubscription: false, bets: [{
        amountSourceType: 'CASH', betAmount: cents, betAmountLong: String(cents), boostedWinAmountLong: '0', draftBetId: dr.betId,
        draftLegs: [{ draftLegId: dr.legId, marketSelectionId: `BetslipMarketSelection:${dr.selId}`, odds: { denominatorLong: odds.denominatorLong, numeratorLong: odds.numeratorLong }, probabilityEncrypted: null }],
        freeBetId: null, profitBoostId: null, sameGameParlayLegs: [], teaserPoints: null, type: 'STRAIGHT', winAmount: win, winAmountLong: String(win),
      }], oddsFormat: 'AMERICAN', keepBetslipSelections: keep, includeOddsTrend: true, includeSurcharge: false }, { ms: 45000 });
      const r = d.betslipPlaceBets || {};
      const placed = (r.placedBets || []).find((p) => (p.legs || []).some((l) => l.marketSelectionId === dr.selId)) || (r.placedBets || [])[0];
      if (placed?.id) return { betId: `thescore:${String(placed.id).replace(/^PlacedBet:/, '')}`, confirmedOdds: null, detail: `theScore place response: ${JSON.stringify(r).slice(0, 3000)}` };
      const why = errorsOf(r).join(', ') || 'no bet in the reply';
      // "We need to verify your location before you proceed" (Austin, 2026-11-23): theScore's location
      // check (GeoComply, run by its page) had lapsed and nothing was placed. A reload of the theScore
      // tab makes the page run it again; the bet is checked again from the start next scan.
      if (/verify your location|location/i.test(why)) {
        bridge.tell?.({ type: 'geoRenew', book: name, why: 'a bet was refused: theScore asked to verify the location' });
        const e = new Error(`refused: theScore's location check had lapsed ("${why.slice(0, 80)}"), nothing was placed; renewing it now (the extension reloads the theScore tab), the bet is checked again next scan`);
        e.detail = `theScore place response: ${JSON.stringify(r).slice(0, 3000)}`; e.notSent = true; e.geoRenewing = true;
        throw e;
      }
      const err = new Error(`rejected: ${why}`);
      err.detail = `theScore place response: ${JSON.stringify(r).slice(0, 3000)}`;
      if (/odds|price/i.test(why)) err.priceMoved = true;
      else if (/suspend|closed|unavailable|not.?(available|open)/i.test(why)) err.gone = true;
      throw err;
    },

    // The app is done with this check (placed or not): take the pick off the slip. After a bet the
    // site already cleared it unless other checks were on the slip (then it was kept for them).
    async done(row, quote, placed) {
      const sel = quote?.draft?.selId || row.bookRef || thescoreRef(row.link).bookRef;
      if (!sel || !active.has(sel)) return;
      active.delete(sel);
      if (!placed || kept.delete(sel)) await removeSel(`BetslipMarketSelection:${sel}`);
    },

    // Settled bets (My Bets > Settled, theScore's default last 7 days), newest first, 25 a page.
    async settled() {
      const out = [];
      let after = null;
      for (let page = 0; page < 20; page++) {
        const d = await gql('history', 'BetHistorySection', { isCfpRankingEnabled: false, includeStandardizedBoxscore: false, isSubscription: false,
          isCombatSportsRedesignEnabled: false, first: 25, ...(after ? { after } : {}), oddsFormat: 'AMERICAN', sectionId: 'BetHistorySection:settled',
          includeSurcharge: true }, { get: true, ms: 30000 });
        const items = d.node?.items;
        for (const e of items?.edges || []) { const r = settledNode(e.node); if (r) out.push(r); }
        if (!items?.pageInfo?.hasNextPage || !items.pageInfo.endCursor) break;
        after = items.pageInfo.endCursor;
      }
      return out;
    },

    // Once a minute (session.js): a small read the site makes itself, which fails when logged out.
    async sessionCheck() {
      try {
        const d = await gql('session', 'SpentInSession', {}, { get: true, ms: 15000 });
        return d.account ? { ok: true } : { ok: false, why: 'theScore answered with no account (logged out)' };
      }
      catch (e) { if (/login/i.test(e.message)) return { ok: false, why: e.message }; throw e; }
    },
  };
}
