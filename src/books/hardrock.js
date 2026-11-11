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

export const HARDROCK_HOSTS = /(^|\.)hardrock\.bet$|(^|\.)hardrocksportsbook\.com$/;

const SESSION = '{{hrSessionToken}}';
const GEO = '{{hrGeo}}';

const toDecimal = (am) => Math.round((am > 0 ? 1 + am / 100 : 1 + 100 / -am) * 1e8) / 1e8;

/** Hard Rock selection id from the bet link Gambit gives for the row. */
export function hardrockSelectionId(row) {
  if (row.bookRef) return String(row.bookRef);
  const m = /selection(?:s|Id|Ids)?[=/:]+(\d{12,})/i.exec(decodeURIComponent(row.link || ''));
  return m ? m[1] : null;
}

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
        return { betId: `hardrock:${betId}${/ACCEPTED/i.test(status) ? '' : ` (${status})`}` };
      }
      const leg = r?.betPartPlacementResult?.[0];
      const why = [status, leg?.status !== 'UNCHANGED' && leg?.status, r?.errorCode, r?.errorMessage, r?.reason].filter(Boolean).join(' ');
      throw new Error(`rejected: ${why || `HTTP ${res.status}`} ${JSON.stringify(r || j).slice(0, 240)}`);
    },
  };
}
