// Hard Rock Bet (app.hardrock.bet, Colorado). Requests below match what the site itself
// sends (captured 2026-11-11):
//  - stake check: POST getMaxAllowedBetStake (no bet is made; also proves the login works)
//  - place:       POST placeBets on the state host (api-co), with acceptPriceChange=false,
//                 so Hard Rock refuses the bet if the price is no longer the one we send
//  - both are form posts: bets=<JSON>&locale=...&sessionToken=<login>[&geolocationDetails=<location check>]
//  - auth: no headers. The login token and the location-check token go in the form body.
//    The extension copies the latest ones from your Hard Rock tab's own requests and fills
//    in the {{hrSessionToken}} / {{hrGeo}} / {{hrAccountId}} placeholders.
// The straight-bet body matches a captured $1 SINGLE (accepted). Hard Rock's max stake comes
// back in a field named "Double" (it's a number type, not a bet type).

import { decimalToAmerican } from '../ev.js';

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

  // placeBets can take 10-12s (live delay), so give it longer than other requests.
  async function post(kind, url, b) {
    return bridge.send(name, { kind, url, method: 'POST', headers: form, body: b, useHardRockAuth: true }, kind === 'place' ? 45000 : 20000);
  }

  // Our bet on this selection among Hard Rock's open bets (My Bets > Open), placed since `since`.
  // Used when placeBets gave no clear answer (timeout, lost connection): the bet may still have
  // gone through, and it has to be logged so it shows on the chart and is never placed twice.
  async function findOpenBet(selectionId, since) {
    const res = await bridge.send(name, {
      kind: 'history', url: `${apiHost}/mybets/open`, method: 'POST', useHardRockAuth: true,
      headers: { accept: 'application/json', 'content-type': 'application/json', sessiontoken: SESSION },
      body: JSON.stringify({ excludeChildBets: true, locale, sessionToken: SESSION }),
    }, 20000);
    const bets = Array.isArray(res.json?.bet) ? res.json.bet : [];
    return bets.find((b) => Number(b.betTime) >= since - 60e3 && b.parts?.betPart?.length === 1 &&
      String(b.parts.betPart[0].selectionId ?? b.parts.betPart[0].selection?.id) === String(selectionId)) || null;
  }
  const loginError = (j) => /session|token|login|auth/i.test(JSON.stringify(j?.error || j?.Error || j?.errors || '').slice(0, 300));

  return {
    name, label,

    // Hard Rock's prices stream over a websocket that wasn't captured, so the live price
    // check is the bet itself: placeBets carries Gambit's price with acceptPriceChange=false
    // and Hard Rock refuses it if the price moved. Here we only check the stake limit,
    // which also confirms the selection exists and the login works (safe while disarmed).
    async recheck(row) {
      if (!hardrockSelectionId(row)) throw new Error(`no Hard Rock selection id in Gambit's link (${String(row.link || 'no link').slice(0, 160)})`);
      const res = await post('recheck', `${apiHost}/sportsbook/v1/api/getMaxAllowedBetStake`, body(betsJson(row, 1, toDecimal(row.odds)), false));
      const j = res.json || {};
      if (res.status === 401 || res.status === 403 || loginError(j)) throw new Error('Hard Rock didn\'t accept the login: refresh the Hard Rock tab and stay logged in');
      if (res.status >= 400) throw new Error(`stake check HTTP ${res.status}: ${JSON.stringify(j || res.text).slice(0, 200)}`);
      const max = Number(j.Double ?? j.Single);
      return { odds: row.odds, line: row.line, maxStake: Number.isFinite(max) && max > 0 ? max : null, suspended: false };
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

    async place(row, stake, quote) {
      const sentAt = Date.now();
      let res;
      try {
        res = await post('place', `${stateHost}/sportsbook/v1/api/placeBets`,
          body(betsJson(row, stake, toDecimal(quote.odds), { acceptPriceChange: false }), true));
      } catch (e) {
        // Only when the request may have reached Hard Rock; setup errors (disarmed, no tab) rethrow.
        if (!/timeout|request failed|disconnect|not connected/i.test(e.message)) throw e;
        res = { status: 0, error: e.message };
      }
      // No answer from Hard Rock (timeout, tab reloaded...): look for the bet in My Bets > Open.
      if (!res.status || res.status >= 500) {
        let found = null;
        for (let i = 0; i < 3 && !found; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          try { found = await findOpenBet(hardrockSelectionId(row), sentAt); } catch {}
        }
        if (found) {
          const ml = Number(found.parts.betPart[0].odds?.moneyline);
          return { betId: `hardrock:${found.id}`, confirmedOdds: Number.isFinite(ml) && ml !== 0 ? ml : null,
            detail: `Hard Rock placeBets gave no answer (${res.error || `HTTP ${res.status}`}); found the bet in My Bets > Open: ${JSON.stringify(found).slice(0, 2000)}` };
        }
        const err = new Error(`no answer from Hard Rock (${res.error || `HTTP ${res.status}`}) and the bet isn't in My Bets > Open`);
        err.detail = `Hard Rock placeBets: ${res.error || JSON.stringify(res.json ?? res.text)}`;
        throw err;
      }
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
      throw err;
    },
  };
}
