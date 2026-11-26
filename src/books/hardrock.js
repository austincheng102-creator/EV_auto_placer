// Hard Rock Bet (app.hardrock.bet, Colorado). Requests below match what the site itself
// sends (captured 2026-11-11):
//  - stake check: POST getMaxAllowedBetStake (no bet is made; also proves the login works)
//  - place:       POST placeBets on the state host (api-co), with acceptPriceChange=false,
//                 so Hard Rock refuses the bet if the price is no longer the one we send
//  - both are form posts: bets=<JSON>&locale=...&sessionToken=<login>[&geolocationDetails=<location check>]
//  - auth: no headers. The login token and the location-check token go in the form body.
//    The extension copies the latest ones from your Hard Rock tab's own requests and fills
//    in the {{hrSessionToken}} / {{hrGeo}} / {{hrAccountId}} placeholders. The location token
//    comes from the page's own location check (geocomply/check, run on load and every ~20 min);
//    with none yet, or after a GEO_TOKEN_EXPIRED refusal, the extension reloads the tab to get one.
// The straight-bet body matches a captured $1 SINGLE (accepted). Hard Rock's max stake comes
// back in a field named "Double" (it's a number type, not a bet type).

import { decimalToAmerican, americanToDecimal } from '../ev.js';
import { makeHardRockFeed } from './hardrock-feed.js';
import { log } from '../log.js';

export const HARDROCK_HOSTS = /(^|\.)hardrock\.bet$|(^|\.)hardrocksportsbook\.com$/;

const SESSION = '{{hrSessionToken}}';
const GEO = '{{hrGeo}}';

const toDecimal = (am) => Math.round((am > 0 ? 1 + am / 100 : 1 + 100 / -am) * 1e8) / 1e8;

/**
 * The price Hard Rock says it accepted the bet at, from its placeBets response (American odds),
 * or null if the response doesn't say. Looks at the bet's leg first, then the bet itself.
 */
export function confirmedOdds(r) {
  const leg = r?.bet?.parts?.betPart?.[0] || r?.bet?.betParts?.[0] || r?.bet?.part?.[0];
  const res = r?.betPartPlacementResult?.[0];
  for (const o of [leg?.odds, leg?.price, res?.odds, res?.acceptedOdds, r?.bet?.odds, r?.odds]) {
    const d = Number(o?.decimal ?? o?.decimalOdds ?? (typeof o === 'number' ? o : NaN));
    if (Number.isFinite(d) && d > 1) return decimalToAmerican(d);
  }
  return null;
}

/** Hard Rock selection id from the bet link Gambit gives for the row. */
export function hardrockSelectionId(row) {
  if (row.bookRef) return String(row.bookRef);
  // Gambit links look like https://app.hardrock.bet/?deep_link_value=betslip/6119998714307281291
  const m = /(?:betslip|selection(?:s|Id|Ids)?)[=/:]+(\d{12,})/i.exec(decodeURIComponent(row.link || ''));
  return m ? m[1] : null;
}

// One settled bet from Hard Rock's My Bets > Settled list (POST api.../mybets/closed) as a result
// for results.json. Bet ids are the same as placeBets' betId. Total return = payout + refund
// (a loss has neither), so profit = total return - stake whatever the result type.
export function settledResult(b) {
  const st = String(b?.displayStatus || b?.parts?.betPart?.[0]?.resultType || '').toUpperCase();
  const result = /CASH/.test(st) ? 'cashout'
    : /HALF/.test(st) ? (/WIN|WON/.test(st) ? 'half-won' : 'half-lost')
    : /WIN|WON/.test(st) ? 'won' : /LOS/.test(st) ? 'lost'
    : /PUSH/.test(st) ? 'push' : /VOID|CANCEL|REFUND/.test(st) ? 'void' : null;
  if (!b?.id || !result || String(b.betStatus || 'SETTLED').toUpperCase() !== 'SETTLED') return null;
  const ml = Number(b.parts?.betPart?.length === 1 ? b.parts.betPart[0].odds?.moneyline : NaN);
  return {
    betId: String(b.id), result, status: st,
    payout: Math.round(((Number(b.payout) || 0) + (Number(b.refund) || 0)) * 100) / 100,
    stake: Number(b.stake?.amount) || null,
    odds: Number.isFinite(ml) && ml !== 0 ? ml : null,
    settledAt: Number.isFinite(Number(b.settlementTime)) ? new Date(Number(b.settlementTime)).toISOString() : null,
  };
}

// Hard Rock wants local time without a zone, like the site sends: 2026-10-16T21:00:42
const localStamp = (t) => { const d = new Date(t), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };

export function makeHardRock(name, label, cfg, bridge) {
  const h = cfg.hardrock || {};
  const st = String(cfg.region || 'CO').toUpperCase();
  const apiHost = h.apiHost || 'https://api.hardrocksportsbook.com';
  const stateHost = h.stateHost || `https://api-${st.toLowerCase()}.hardrocksportsbook.com`;
  const locale = h.locale || `enus-us-x-${st.toLowerCase()}`;
  const channelId = h.channelId || '21';
  const form = { accept: 'application/json, text/plain, */*', 'content-type': 'application/x-www-form-urlencoded' };

  const betsJson = (row, stake, decimal, extra = {}) => ({
    PlaceBetsRequest: {
      accountId: '{{hrAccountId}}',   // the extension fills this in from the login token
      bets: { bet: [{
        type: 'SINGLE', winType: 'WIN',
        stake: { amount: stake, currency: 'USD' },
        parts: { betPart: [{ partNo: 1, selectionId: hardrockSelectionId(row), oddsType: 'MONEYLINE', odds: { decimal } }] },
      }] },
      channelId, reqId: Date.now(), ...extra, unityAccountId: '',
    },
  });
  const body = (bets, withGeo) => `bets=${encodeURIComponent(JSON.stringify(bets))}` +
    (withGeo ? `&geolocationDetails=${GEO}` : '') + `&locale=${locale}&sessionToken=${SESSION}`;

  async function post(kind, url, b) {
    return bridge.send(name, { kind, url, method: 'POST', headers: form, body: b, useHardRockAuth: true }, 20000);
  }
  const loginError = (j) => /session|token|login|auth/i.test(JSON.stringify(j?.error || j?.Error || j?.errors || '').slice(0, 300));

  // Hard Rock's live prices, streamed from Hard Rock itself (hardrock-feed.js).
  // "hardrock": {"directPrices": false} turns it off and uses Gambit's copy of the price.
  const feed = h.directPrices === false ? null : makeHardRockFeed(cfg, log);
  const stakeSeen = new Map();   // selection id -> { at, max }: last stake check

  return {
    name, label,
    // The price check makes no bet (live feed price + a cached stake check), so a bet whose check
    // failed (fresh jump, EV too low, price moved) is checked again on the next scans for
    // recheckWatchMinutes, like BetRivers and FanDuel, instead of being ignored for 5 minutes.
    freePriceCheck: true,

    // Puts Hard Rock's real price (from the live feed) in place of Gambit's copy, for rows
    // within directMarginPts of minEvPct on Gambit's numbers. Selections the feed doesn't have
    // keep Gambit's price (rows Gambit lists under other books are then left out).
    async livePrices(rows, minEvPct) {
      const st = { read: 0, moved: 0, gone: 0, shadowNew: 0 };
      if (!feed) return st;
      await feed.start();
      if (!feed.live()) return st;
      const margin = h.directMarginPts ?? 5;
      for (const r of rows) {
        if (r.book !== name || !Number.isFinite(r.ev) || r.ev < minEvPct - margin) continue;
        const id = hardrockSelectionId(r);
        const p = id && feed.price(id);
        if (!p) continue;
        r.gambitOdds = r.odds; r.gambitEv = r.ev;
        if (p.suspended) { r.direct = 'gone'; r.ev = -Infinity; st.gone++; continue; }
        st.read++;
        if (p.odds !== r.odds) st.moved++;
        r.direct = true; r.odds = p.odds;
        r.directQuote = { odds: p.odds, line: r.line, at: Date.now(), changedAt: p.changedAt ? new Date(p.changedAt).toISOString() : null };
        r.ev = (r.fairProb * americanToDecimal(p.odds) - 1) * 100;
        if (r.shadow && r.ev >= minEvPct) st.shadowNew++;
      }
      return st;
    },
    feed,

    // Hard Rock's prices stream over a websocket that wasn't captured, so the live price
    // check is the bet itself: placeBets carries Gambit's price with acceptPriceChange=false
    // and Hard Rock refuses it if the price moved. Here we only check the stake limit,
    // which also confirms the selection exists and the login works (safe while disarmed).
    async recheck(row) {
      const selId = hardrockSelectionId(row);
      if (!selId) throw new Error(`no Hard Rock selection id in Gambit's link (${String(row.link || 'no link').slice(0, 160)})`);
      // With the live feed on, row.odds is Hard Rock's real price as of this scan; read it again now.
      let p = feed?.live() && row.direct === true ? feed.price(selId) : null;
      // The stake check is a round trip through the Hard Rock tab. The same selection's max stake
      // from the last few minutes (hardrock.stakeCheckCacheSec, default 300; 0 = check every
      // time) is used instead when the live feed has its price; placeBets still refuses any change.
      const cached = stakeSeen.get(String(selId));
      if (p && cached && Date.now() - cached.at < (h.stakeCheckCacheSec ?? 300) * 1000) {
        return { odds: p.odds, line: row.line, maxStake: cached.max, suspended: !!p.suspended,
          changedAt: p.changedAt ? new Date(p.changedAt).toISOString() : null };
      }
      const res = await post('recheck', `${apiHost}/sportsbook/v1/api/getMaxAllowedBetStake`, body(betsJson(row, 1, toDecimal(row.odds)), false));
      const j = res.json || {};
      if (res.status === 401 || res.status === 403 || loginError(j)) throw new Error('Hard Rock didn\'t accept the login: refresh the Hard Rock tab and stay logged in');
      if (res.status >= 400) throw new Error(`stake check HTTP ${res.status}: ${JSON.stringify(j || res.text).slice(0, 200)}`);
      const max = Number(j.Double ?? j.Single);
      stakeSeen.set(String(selId), { at: Date.now(), max: Number.isFinite(max) && max > 0 ? max : null });
      if (stakeSeen.size > 2000) stakeSeen.delete(stakeSeen.keys().next().value);
      const now = feed?.live() && row.direct === true ? feed.price(selId) : null;   // the price after the stake check
      if (now) p = now;
      return { odds: p ? p.odds : row.odds, line: row.line, maxStake: Number.isFinite(max) && max > 0 ? max : null, suspended: !!p?.suspended,
        changedAt: p?.changedAt ? new Date(p.changedAt).toISOString() : null };
    },

    // Settled bets between two times (ms), from the same list as My Bets > Settled.
    // Read-only, so it works while the extension is disarmed.
    async settled(from, to = Date.now()) {
      const res = await bridge.send(name, {
        kind: 'history', url: `${apiHost}/mybets/closed`, method: 'POST', useHardRockAuth: true,
        headers: { accept: 'application/json', 'content-type': 'application/json', sessiontoken: SESSION },
        body: JSON.stringify({ from: localStamp(from), locale, sessionToken: SESSION, to: localStamp(to + 864e5) }),
      }, 30000);
      const j = res.json || {};
      if (res.status === 401 || res.status === 403 || loginError(j)) throw new Error('Hard Rock didn\'t accept the login: refresh the Hard Rock tab and stay logged in');
      if (res.status >= 400 || !Array.isArray(j.bet)) throw new Error(`settled bets HTTP ${res.status}: ${JSON.stringify(j || res.text).slice(0, 200)}`);
      return j.bet.map(settledResult).filter(Boolean);
    },

    // Once a minute (session.js): read the balance (read-only, the site does the same), which
    // tells us whether Hard Rock still has you logged in. The page itself keeps the login alive.
    async sessionCheck() {
      const res = await bridge.send(name, {
        kind: 'session', url: `${apiHost}/sportsbook/v1/api/getBalance`, method: 'POST', useHardRockAuth: true,
        headers: { ...form, csrf_token: '{{hrCsrf}}' }, body: `sessionToken=${SESSION}`,
      }, 15000);
      const j = res.json || {};
      const bal = j.AccountBalance;
      if (res.status < 400 && bal) return { ok: true, balance: Number.isFinite(Number(bal.amount)) ? Number(bal.amount).toFixed(2) : null };
      if (res.status === 401 || res.status === 403 || loginError(j)) return { ok: false, why: `Hard Rock balance check answered ${res.status === 200 ? JSON.stringify(j).slice(0, 100) : `HTTP ${res.status}`}` };
      throw new Error(`Hard Rock balance check HTTP ${res.status}: ${JSON.stringify(j || res.text).slice(0, 120)}`);
    },

    async place(row, stake, quote) {
      const res = await post('place', `${stateHost}/sportsbook/v1/api/placeBets`,
        body(betsJson(row, stake, toDecimal(quote.odds), { acceptPriceChange: false }), true));
      const j = res.json || {};
      if (res.status === 401 || res.status === 403 || loginError(j)) throw new Error('Hard Rock didn\'t accept the login: refresh the Hard Rock tab and stay logged in');
      const r = j.PlaceBetsResponse?.betPlacementResult?.[0];
      const status = r?.status || r?.bet?.betStatus;
      const betId = r?.betId || r?.bet?.id;
      // Accepted, or still being reviewed by Hard Rock (record it so we never bet it twice).
      if (betId && /ACCEPTED|PENDING|REFERRED|DELAY/i.test(String(status))) {
        return { betId: `hardrock:${betId}${/ACCEPTED/i.test(status) ? '' : ` (${status})`}`,
          confirmedOdds: confirmedOdds(r), detail: `Hard Rock placeBets response: ${JSON.stringify(j)}` };
      }
      const leg = r?.betPartPlacementResult?.[0];
      const why = [status, leg?.status !== 'UNCHANGED' && leg?.status, r?.errorCode, r?.errorMessage, r?.reason].filter(Boolean).join(' ');
      const err = new Error(`rejected: ${why || `HTTP ${res.status}`}`);
      err.detail = `Hard Rock placeBets response: ${JSON.stringify(j)}`;
      // NEW_ODDS: the price moved. If Hard Rock says what it is now, pass it back so the
      // engine can re-check EV and Novig at that price and try once more.
      if (/NEW_ODDS|PRICE_CHANGE/i.test(why)) {
        err.priceMoved = true;
        const d = Number(leg?.newOdds?.decimal ?? leg?.currentOdds?.decimal ?? leg?.odds?.decimal);
        if (Number.isFinite(d) && d > 1 && Math.abs(d - toDecimal(quote.odds)) > 1e-6) err.newOdds = decimalToAmerican(d);
      } else if (/UNAVAILABLE|SUSPENDED|CLOSED/i.test(why)) err.gone = true;
      // Stake over Hard Rock's limit for this selection (the $10 pre-game stake): ask for the max now, so the
      // engine can bet that instead (Austin 2026-11-26). The exact refusal code isn't captured yet, so any
      // refusal that names a stake/limit counts.
      else if (/STAKE|LIMIT|MAX|EXCEED/i.test(why)) {
        err.stakeTooHigh = true;
        const selId = hardrockSelectionId(row);
        stakeSeen.delete(String(selId));
        const fromAnswer = Number(r?.maxStake ?? r?.maxAllowedStake ?? leg?.maxStake);
        if (Number.isFinite(fromAnswer) && fromAnswer > 0) err.maxStake = fromAnswer;
        else {
          try {
            const m = await post('recheck', `${apiHost}/sportsbook/v1/api/getMaxAllowedBetStake`, body(betsJson(row, 1, toDecimal(quote.odds)), false));
            const max = Number(m.json?.Double ?? m.json?.Single);
            if (Number.isFinite(max) && max > 0) err.maxStake = max;
          } catch { /* the engine falls back to stake.byBook.hardrock.fallback */ }
        }
      }
      throw err;
    },
  };
}
