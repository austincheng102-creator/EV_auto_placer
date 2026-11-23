// BetMGM (Colorado, www.co.betmgm.com). Requests below match what the site itself sent for a
// $0.10 pre-game straight bet (Austin's capture, 2026-11-22):
//  - price:  POST /cds-api/bettingoffer/picks  {tv2Picks:[{fixtureId, optionMarketId, optionId}]}
//            -> the option's current price (price.id is the "pick" id the bet is placed on) and
//            the names of the sport, league, game, market and option, each with a "sign" that
//            BetMGM issues with its prices. No login needed, no bet is made.
//  - place:  POST /en/sports/api/placebet/place with the price we checked and
//            oddsAcceptanceMode "No", so BetMGM refuses the bet if the price changed.
//  - auth:   the site's cookies (the request runs inside your BetMGM tab) plus an x-xsrf-token
//            header the page sends with every request; the extension copies it from the tab.
//  - location: BetMGM's own location check (GeoComply) runs in the page and is kept on BetMGM's
//            side, so the bet request carries nothing for it.

import { decimalToAmerican } from '../ev.js';

const XSRF = '{{bmXsrf}}';

/** BetMGM ids from Gambit's link for the row: fixture ("6:44014"), market and option ids.
 *  Accepts "options=<fixture>-<market>-<option>" and fixtureId=/marketId=/optionId= forms. */
export function betmgmRef(link) {
  const s = decodeURIComponent(String(link || ''));
  let m = /options=(\d+:\d+|\d+)-(\d+)-(\d+)/i.exec(s);
  if (m) return { fixtureId: m[1], marketId: m[2], optionId: m[3] };
  const q = (k) => new RegExp(`[?&#]${k}=([\\d:]+)`, 'i').exec(s)?.[1];
  const fx = q('fixtureId') || /events\/[^?#]*?-(\d+:\d+|\d+)(?=[?#/]|$)/i.exec(s)?.[1];
  const mk = q('optionMarketId') || q('marketId');
  const op = q('optionId');
  return fx && mk && op ? { fixtureId: fx, marketId: mk, optionId: op } : {};
}

/** American odds from a BetMGM price object ({americanOdds} or decimal {odds}), or null. */
export function bmAmerican(p) {
  const a = Number(p?.americanOdds ?? p?.american);
  if (Number.isFinite(a) && a !== 0) return Math.round(a);
  const d = Number(p?.odds);
  return Number.isFinite(d) && d > 1 ? decimalToAmerican(d) : null;
}

/** Our option in a picks reply: {fixture, market, option} or null. */
export function findOption(j, ref) {
  for (const fx of j?.fixturePage?.fixtures || []) {
    for (const m of [...(fx.optionMarkets || []), ...(fx.markets || [])]) {
      if (String(m.id) !== String(ref.marketId)) continue;
      const o = (m.options || []).find((x) => String(x.id) === String(ref.optionId));
      if (o) return { fixture: fx, market: m, option: o };
    }
  }
  return null;
}

// The bet's details, the way the site sends them: sport, region, league, game, market, option,
// each {id, value, sign} as BetMGM gave them with the price.
export function betDetails(hit) {
  const fx = hit.fixture;
  const t = (id, type, name) => ({ id: String(id), betDetailType: type, additionalInformation: { informationItems: [] },
    textValue: { value: name?.value ?? '', sign: name?.sign ?? '' } });
  return [
    t(fx.sport?.id, 'Sport', fx.sport?.name),
    t(fx.region?.id, 'Region', fx.region?.name),
    t(fx.competition?.id, 'Competition', fx.competition?.name),
    t(fx.id, 'Fixture', fx.name),
    t(hit.market.id, 'Market', hit.market.name),
    t(hit.option.id, 'Option', hit.option.name),
  ];
}

const uuid = () => (globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
}));

// Why BetMGM refused a bet: every error code/message anywhere in its reply.
const WHY_KEY = /^(status|errorCode|code|reason|message|errorMessage|errorType|failureReason)$/i;
export function bmWhy(j) {
  const out = [];
  const walk = (v, d) => {
    if (!v || typeof v !== 'object' || d > 6) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, d + 1)); return; }
    for (const [k, x] of Object.entries(v)) {
      if ((typeof x === 'string' || typeof x === 'number') && WHY_KEY.test(k) && x !== '' && !/^(Success|Succeeded|OK|Visible)$/i.test(String(x))) out.push(String(x));
      else if (x && typeof x === 'object') walk(x, d + 1);
    }
  };
  walk(j, 0);
  return [...new Set(out)].join(', ');
}

export function makeBetMGM(name, label, cfg, bridge) {
  const b = cfg.betmgm || {};
  const st = String(cfg.region || 'CO').toLowerCase();
  const origin = b.host || `https://www.${st}.betmgm.com`;
  const stateName = { co: 'Colorado', nj: 'New Jersey', mi: 'Michigan', pa: 'Pennsylvania', az: 'Arizona', va: 'Virginia', in: 'Indiana', il: 'Illinois', ny: 'New York', tn: 'Tennessee' }[st] || st.toUpperCase();
  // BetMGM's site key for its price API (the same for everyone; it's in the page's own requests).
  const accessId = b.accessId || 'OTU4NDk3MzEtOTAyNS00MjQzLWIxNWEtNTI2MjdhNWM3Zjk3';
  const picksUrl = `${origin}/cds-api/bettingoffer/picks?x-bwin-accessid=${accessId}&lang=en-us&country=US&userCountry=US&subdivision=US-${encodeURIComponent(stateName)}`;
  const site = { accept: 'application/json, text/plain, */*', 'x-bwin-sports-api': 'prod', 'sports-api-version': 'SportsAPIv2' };
  const loginMsg = 'BetMGM didn\'t accept the login: refresh the BetMGM tab and stay logged in';
  const send = (kind, url, method, body, extra = {}, ms = 20000) => bridge.send(name, {
    kind, url, method, headers: { ...site, ...(body != null ? { 'content-type': 'application/json' } : {}), ...extra },
    body, credentials: 'include', useBetMGMAuth: true,
  }, ms);
  const authFail = (res) => res.status === 401 || res.status === 403;
  const refOf = (row) => (row.fixtureId && row.marketId && row.optionId ? row : betmgmRef(row.link));

  async function readPick(row) {
    const ref = refOf(row);
    if (!ref.fixtureId) throw new Error(`no BetMGM ids in Gambit's link (${String(row.link || 'no link').slice(0, 160)})`);
    const res = await send('recheck', picksUrl, 'POST', JSON.stringify({ tv1Picks: [], tv2Picks: [{ fixtureId: ref.fixtureId, optionMarketId: Number(ref.marketId), isClassicBetBuilder: false, optionId: Number(ref.optionId) }] }));
    if (authFail(res)) throw new Error(loginMsg);
    if (res.status >= 400 || !res.json) throw new Error(`price check HTTP ${res.status}: ${String(JSON.stringify(res.json) || res.text || '').slice(0, 200)}`);
    return { ref, hit: findOption(res.json, ref) };
  }

  return {
    name, label,

    // The price check: BetMGM's current price for this option (no bet is made).
    async recheck(row) {
      const { hit } = await readPick(row);
      if (!hit) return { odds: null, line: row.line, suspended: true };
      const odds = bmAmerican(hit.option.price);
      const visible = (s) => !s || /^visible$/i.test(String(s));
      const line = (() => { const n = Number(hit.market.attr ?? (hit.market.parameters || []).find((p) => p.key === 'DecimalValue')?.value);
        return Number.isFinite(n) && row.line != null ? (Math.abs(n) === Math.abs(row.line) ? row.line : n) : row.line; })();
      return { odds, line, suspended: !visible(hit.option.status) || !visible(hit.market.status) || !hit.option.price,
        pick: hit, maxStake: null };
    },

    async place(row, stake, quote) {
      // Use the price check's own data (fresh: it ran just before) for the pick id and details.
      let hit = quote.pick;
      if (!hit || bmAmerican(hit.option.price) !== quote.odds) hit = (await readPick(row)).hit;
      if (!hit) { const e = new Error('rejected: option no longer offered'); e.gone = true; throw e; }
      const now = bmAmerican(hit.option.price);
      if (now !== quote.odds) { const e = new Error(`rejected: price is now ${now}`); e.priceMoved = true; if (now != null) e.newOdds = now; throw e; }
      const requestId = uuid();
      const fx = hit.fixture;
      const body = {
        placeBetRequest: {
          requestId,
          betSlips: [{
            betSlipType: 'Single', index: 1, stake: { amount: stake, currency: 'USD' }, stakeTaxation: null,
            bets: [{
              index: 1, isBanker: false, betModel: 'Option',
              odds: { oddsFormat: 'American', american: quote.odds }, oddsFormat: 'American',
              additionalInformation: { informationItems: [
                ...(fx.startDate ? [{ key: 'fixtureStartTime', value: fx.startDate, valueType: 'DateTime' }] : []),
                ...(fx.fixtureType ? [{ key: 'fixtureType', value: fx.fixtureType, valueType: 'Enum' }] : []),
              ] },
              picks: [{ id: String(hit.option.price.id) }],
              betDetails: betDetails(hit),
            }],
            betGroups: [], additionalInformation: { informationItems: [] }, edsPromoTokens: [],
            oddsAcceptanceMode: 'No', promoTokens: [], overAskOfferDetails: null, checkOrder: 2, systemSlipDetails: null,
          }],
          doubleBetPreventionMode: 'Disabled', language: '', additionalInformation: { informationItems: [] },
        },
        betContextualDetails: [], betContextualDetailsV2: { requestId, slips: [] },
      };
      const res = await send('place', `${origin}/en/sports/api/placebet/place`, 'POST', JSON.stringify(body), { 'x-xsrf-token': XSRF }, 45000);
      const j = res.json || {};
      if (authFail(res)) throw new Error(loginMsg);
      const slip = (j.betslips || [])[0];
      const ok = slip?.succeeded;
      if (/^success/i.test(String(j.status)) && ok?.betNumber) {
        const am = Number(ok.totalOdds?.american ?? ok.options?.[0]?.odds?.american);
        return { betId: `betmgm:${ok.betNumber}`, confirmedOdds: Number.isFinite(am) && am !== 0 ? am : null,
          detail: `BetMGM place response: ${JSON.stringify(j)}` };
      }
      // Still being reviewed (live bets can wait a few seconds): record it so it's never bet twice.
      if (slip && /pending|delay|wait|accepted/i.test(String(slip.status)) && (slip.betNumber || slip.pending?.betNumber)) {
        return { betId: `betmgm:${slip.betNumber || slip.pending.betNumber} (${slip.status})`, confirmedOdds: null, detail: `BetMGM place response: ${JSON.stringify(j)}` };
      }
      const why = bmWhy(j) || `HTTP ${res.status}`;
      const err = new Error(`rejected: ${why}`);
      err.detail = `BetMGM place response: ${JSON.stringify(j || res.text)}`;
      if (/odds|price/i.test(why) && /chang|moved|differ|new/i.test(why)) err.priceMoved = true;
      else if (/suspend|closed|unavailable|not.?(found|available|offered)|visible/i.test(why)) err.gone = true;
      throw err;
    },

    // Once a minute (session.js): the balance (read-only, the site reads it all the time) tells us
    // whether BetMGM still has you logged in.
    async sessionCheck() {
      const res = await bridge.send(name, { kind: 'session', url: `${origin}/en/api/balance`, method: 'GET', headers: { accept: 'application/json, text/plain, */*', 'x-bwin-sf-api': 'prod' }, credentials: 'include' }, 15000);
      const bal = res.json?.balance;
      if (res.status < 400 && bal) return { ok: true, balance: Number.isFinite(Number(bal.availableBalance)) ? Number(bal.availableBalance).toFixed(2) : null };
      if (authFail(res) || res.status === 200) return { ok: false, why: `BetMGM balance check answered ${res.status === 200 ? String(JSON.stringify(res.json) || res.text).slice(0, 100) : `HTTP ${res.status}`}` };
      throw new Error(`BetMGM balance check HTTP ${res.status}: ${String(JSON.stringify(res.json) || res.text || '').slice(0, 120)}`);
    },
  };
}
