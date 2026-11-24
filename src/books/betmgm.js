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
// Gambit's BetMGM links are Ontario (400, sports.on.betmgm.ca) and Michigan (1001,
// sports.mi.betmgm.com); there is no Colorado feed. Market and option ids are the same in every
// state (checked against Austin's CO recordings), so the link's ids are used and every price is
// read from BetMGM CO.
// Both kinds of BetMGM markets: newer ("6:..." fixtures, tv2Picks, betModel Option on the price id)
// and older (plain-number fixtures, tv1Picks with gameId/resultId, betModel Result on the result
// id; Austin's capture 2026-11-23). "betmgm": {"olderMarkets": false} skips the older ones.
//  - location: BetMGM's own location check (GeoComply) runs in the page and is kept on BetMGM's
//            side, so the bet request carries nothing for it.

import { decimalToAmerican, americanToDecimal } from '../ev.js';
import { log } from '../log.js';

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
      if (!o) continue;
      // An older-market game line can also come back in the newer shape, with price.id -1 (Austin's
      // debug.log 2026-11-23: BYU, San Francisco and Memphis game lines on fixtures 2012xxxx/2010xxxx).
      // Betting it on pick "-1" gets an empty HTTP 500. The site bets these as betModel "Result" on
      // the option (result) id, so do the same.
      const pid = Number(o.price?.id);
      if (!(pid > 0)) {
        return { fixture: fx, market: m, v1: true, option: { ...o, price: { ...o.price, id: o.id } } };
      }
      return { fixture: fx, market: m, option: o };
    }
    // Older markets (plain-number fixtures, "v1"): fixture.games[].results[], the price on the result
    // itself (Austin's capture 2026-11-23, Middle Tenn State at So Illinois, fixture 20129999).
    // Shaped like a newer option so the rest of the code reads it the same way.
    for (const g of fx.games || []) {
      if (String(g.id) !== String(ref.marketId)) continue;
      const r = (g.results || []).find((x) => String(x.id) === String(ref.optionId));
      if (r) return { fixture: fx, market: { ...g, status: g.visibility }, v1: true,
        option: { ...r, status: r.visibility, price: { id: r.id, americanOdds: r.americanOdds, odds: r.odds } } };
    }
  }
  return null;
}
/** Older BetMGM market (plain-number fixture id, no "6:"). */
export const isV1 = (ref) => /^\d+$/.test(String(ref?.fixtureId || ''));

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

// One settled bet slip from My Bets > Settled as a result for results.json. payout is the total
// return (stake + winnings; 0 for a loss), the same as for the other books.
export function settledSlip(x) {
  if (!x?.betSlipNumber || (x.bets || []).length !== 1) return null;
  const st = String(x.state || '').toUpperCase();
  const result = /CASH/.test(st) || x.isEarlyPayout ? 'cashout'
    : /HALF/.test(st) ? (/WON|WIN/.test(st) ? 'half-won' : 'half-lost')
    : /WON|WIN/.test(st) ? 'won' : /LOST|LOSE/.test(st) ? 'lost'
    : /PUSH|TIE|DRAW/.test(st) ? 'push' : /VOID|CANCEL|REFUND/.test(st) ? 'void' : null;
  if (!result) return null;
  const am = Number(x.totalOdds?.american ?? x.bets[0]?.odds?.american);
  return {
    betId: String(x.betSlipNumber), result, status: st,
    payout: Math.round((Number(x.payout?.value) || 0) * 100) / 100,
    stake: Number.isFinite(Number(x.stake?.value)) ? Number(x.stake.value) : null,
    odds: Number.isFinite(am) && am !== 0 ? am : null,
    settledAt: null, placedAt: x.conclusionDateUtc || null,
  };
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

  // Why a row can't be bet on BetMGM, or null.
  const cantBet = (ref, row) => !ref.fixtureId ? `no BetMGM ids in Gambit's link (${String(row.link || 'no link').slice(0, 160)})`
    : isV1(ref) ? (b.olderMarkets === false ? `older BetMGM market (fixture ${ref.fixtureId}), off in config (betmgm.olderMarkets)` : null)
    : !/^\d+:\d+$/.test(ref.fixtureId) ? `unknown BetMGM fixture id ${ref.fixtureId}` : null;
  const pickOf = (ref) => ({ fixtureId: ref.fixtureId, optionMarketId: Number(ref.marketId), isClassicBetBuilder: false, optionId: Number(ref.optionId) });
  // Older markets are asked for as tv1Picks: game id = market, result id = option (as the site does).
  const pick1Of = (ref) => ({ fixtureId: String(ref.fixtureId), gameId: Number(ref.marketId), resultId: Number(ref.optionId), useLiveFallback: false });
  async function readPicks(refs, kind = 'recheck') {
    const res = await send(kind, picksUrl, 'POST', JSON.stringify({ tv1Picks: refs.filter(isV1).map(pick1Of), tv2Picks: refs.filter((r) => !isV1(r)).map(pickOf) }));
    if (authFail(res)) throw new Error(loginMsg);
    if (res.status >= 400 || !res.json) throw new Error(`price check HTTP ${res.status}: ${String(JSON.stringify(res.json) || res.text || '').slice(0, 200)}`);
    return res.json;
  }
  async function readPick(row) {
    const ref = refOf(row);
    const no = cantBet(ref, row);
    if (no) throw new Error(no);
    return { ref, hit: findOption(await readPicks([ref]), ref) };
  }
  // The line BetMGM shows now: from the option's name ("Over 45", "Minnesota Vikings +7.5"), else
  // the market's. Gambit's line if it's the same number.
  const lineNow = (hit, row) => {
    if (row.line == null) return row.line;
    const inName = String(hit.option.name?.value || '').match(/[+-]?\d+(?:\.\d+)?(?!.*\d)/);
    const n = Number(inName ? inName[0] : hit.market.attr ?? (hit.market.parameters || []).find((p) => /^Decimal(Value|Handicap)$/.test(p.key))?.value);
    return Number.isFinite(n) ? (Math.abs(n) === Math.abs(row.line) ? row.line : n) : row.line;
  };
  const visible = (s) => !s || /^visible$/i.test(String(s));

  return {
    name, label,
    freePriceCheck: true,   // the price check reads the option, no bet: a failed check is checked again on later scans

    // Colorado prices for EV: every scan (and the 1s fast check), BetMGM CO's own price for each
    // BetMGM row within directMarginPts (5) of min EV, read in batches of 10, replaces Gambit's
    // Michigan price. A row whose line moved or that's suspended is dropped. "betmgm":
    // {"coPrices": false} goes back to Gambit's price (the check before a bet is always CO's).
    async livePrices(rows, minEvPct) {
      const st = { read: 0, moved: 0, gone: 0, unmatched: 0, why: '' };
      if (b.coPrices === false) return st;
      const margin = b.directMarginPts ?? 5, max = b.directMax ?? 60;
      const want = rows.filter((r) => r.book === name && Number.isFinite(r.ev) && r.ev >= minEvPct - margin)
        .sort((x, y) => y.ev - x.ev).slice(0, max);
      const ok = [];
      for (const r of want) {
        const no = cantBet(refOf(r), r);
        if (no) { st.unmatched++; if (!st.why) st.why = `${r.event} ${r.market || r.marketKey}: ${no}`; r.ev = -Infinity; r.direct = 'gone'; continue; }
        ok.push(r);
      }
      for (let i = 0; i < ok.length; i += 10) {
        const part = ok.slice(i, i + 10);
        let j;
        try { j = await readPicks(part.map(refOf), 'prices'); } catch (e) { if (!st.why) st.why = e.message; continue; }
        for (const r of part) {
          const hit = findOption(j, refOf(r));
          if (!hit) { st.unmatched++; continue; }   // keeps Gambit's price; the bet's own check decides
          const odds = bmAmerican(hit.option.price);
          r.gambitOdds = r.odds; r.gambitEv = r.ev;
          if (odds == null || !visible(hit.option.status) || !visible(hit.market.status) || lineNow(hit, r) !== r.line) { r.direct = 'gone'; r.ev = -Infinity; st.gone++; continue; }
          st.read++;
          if (odds !== r.odds) st.moved++;
          r.direct = true; r.odds = odds;
          r.ev = (r.fairProb * americanToDecimal(odds) - 1) * 100;
        }
      }
      return st;
    },

    // The price check: BetMGM's current price for this option (no bet is made).
    async recheck(row) {
      const { hit } = await readPick(row);
      if (!hit) return { odds: null, line: row.line, suspended: true };
      const odds = bmAmerican(hit.option.price);
      // BetMGM's main spread/total markets are "rolling lines": the same market and option can
      // move to a new line, so the engine skips one whose line moved.
      const line = lineNow(hit, row);
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
              // Older markets are bet as betModel "Result" on the result id (Austin's capture).
              index: 1, isBanker: false, betModel: hit.v1 ? 'Result' : 'Option',
              odds: { oddsFormat: 'American', american: quote.odds }, oddsFormat: 'American',
              additionalInformation: { informationItems: [
                ...(fx.startDate ? [{ key: 'fixtureStartTime', value: fx.startDate, valueType: 'DateTime' }] : []),
                ...(fx.fixtureType && !hit.v1 ? [{ key: 'fixtureType', value: fx.fixtureType, valueType: 'Enum' }] : []),
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
      let j = res.json || {};
      if (authFail(res)) throw new Error(loginMsg);
      // Live bets: BetMGM answers {"status":"Pending","pendingStatus":{"delay":<ms>}} and the
      // site then asks querystatus?requestId= for the outcome (about 3s for a live NFL bet).
      for (let i = 0; i < 20 && /^pending$/i.test(String(j.status)); i++) {
        const wait = Math.min(15000, Math.max(500, Number(j.pendingStatus?.delay) || 1500));
        await new Promise((r) => setTimeout(r, wait));
        const q = await send('status', `${origin}/en/sports/api/placebet/querystatus?requestId=${requestId}`, 'GET', null, {}, 20000);
        if (authFail(q)) throw new Error(loginMsg);
        if (q.json) j = q.json;
      }
      if (/^pending$/i.test(String(j.status))) {
        // Never got an answer: it may still go through, so record it (never bet twice) and say so.
        return { betId: `betmgm:pending-${requestId}`, confirmedOdds: null, detail: `BetMGM still pending after waiting: ${JSON.stringify(j)}` };
      }
      const slip = (j.betslips || [])[0];
      const ok = slip?.succeeded;
      if (/^success/i.test(String(j.status)) && ok?.betNumber) {
        const am = Number(ok.totalOdds?.american ?? ok.options?.[0]?.odds?.american);
        return { betId: `betmgm:${ok.betNumber}`, confirmedOdds: Number.isFinite(am) && am !== 0 ? am : null,
          detail: `BetMGM place response: ${JSON.stringify(j)}` };
      }
      // A refusal lists its reasons under betslips[].failed.errors[] (Austin's debug.log, 2026-11-23):
      // type OddsChanged (with the current price) or SessionTokenInvalid (location check lapsed).
      const errs = (j.betslips || []).flatMap((x) => x?.failed?.errors || []);
      const types = errs.map((e) => e?.type || e?.detailedErrorCode).filter(Boolean);
      const detail = `BetMGM place response: ${JSON.stringify(j || res.text)}`;
      if (types.some((t) => /SessionToken|Geo|Location/i.test(t)) || errs.some((e) => /SESSION_TOKEN|GEO/i.test(String(e?.detailedErrorCode || '')))) {
        // BetMGM's location check (run by its own page) had lapsed: nothing was placed. A reload of the
        // BetMGM tab makes the page run it again; the bet is checked again from the start next scan.
        bridge.tell?.({ type: 'mgmGeoRenew', why: 'a bet was refused with SessionTokenInvalid' });
        const e = new Error('refused with SessionTokenInvalid: BetMGM\'s location check had lapsed, nothing was placed; the extension renews it by clicking odds in the BetMGM tab; the bet is checked again next scan');
        e.detail = detail; e.notSent = true; e.geoRenewing = true;
        throw e;
      }
      const why = [...new Set(types)].join(', ') || bmWhy(j) || `HTTP ${res.status}`;
      const err = new Error(`rejected: ${why}${types.length ? '' : ` (${hit.v1 ? 'older' : 'newer'} BetMGM market, fixture ${fx.id})`}`);
      // An error with no reasons (Austin 2026-11-23: "HTTP 500" with an empty {} answer): keep the raw
      // text, any network error and the request we sent, so the cause can be found.
      err.detail = Object.keys(j).length ? detail
        : `BetMGM place: HTTP ${res.status}${res.error ? `, ${res.error}` : ''}, answer ${JSON.stringify(String(res.text ?? '').slice(0, 1500))}; we sent ${JSON.stringify(body).slice(0, 2500)}`;
      const moved = errs.find((e) => /OddsChanged|PriceChanged/i.test(String(e?.type)));
      if (moved || (/odds|price/i.test(why) && /chang|moved|differ|new/i.test(why))) {
        err.priceMoved = true;
        const now = Number(moved?.currentOddsInUserFormat?.american);
        if (Number.isFinite(now) && now !== 0) err.newOdds = now;
      } else if (/suspend|closed|unavailable|not.?(found|available|offered)|visible/i.test(why)) err.gone = true;
      throw err;
    },

    // One page of My Bets (typeFilter 'Settled' or 'Open'), newest first.
    async myBets(typeFilter, page, per) {
      const res = await send('history', `${origin}/en/sports/api/mybets/betslips`, 'POST',
        JSON.stringify({ index: page, maxItems: per, typeFilter, eventIds: [], useGroupedView: true, paging: { count: per, lastBetByBettingPlatformInstanceIds: {} } }),
        { 'x-xsrf-token': XSRF }, 30000);
      if (authFail(res)) throw new Error(loginMsg);
      const list = res.json?.betslips;
      if (res.status >= 400 || !Array.isArray(list)) throw new Error(`${typeFilter.toLowerCase()} bets HTTP ${res.status}: ${String(JSON.stringify(res.json) || res.text || '').slice(0, 200)}`);
      return list;
    },

    // Settled bets placed since `from` (ms), from the same list as My Bets > Settled (newest
    // first, read a page at a time). Read-only, so it works while the extension is disarmed.
    // If a page brings nothing new (BetMGM ignoring the page number), one big page is read instead,
    // so bets further down the list aren't missed.
    async settled(from) {
      const per = b.settledPageSize || 50;
      const seen = new Map();
      const take = (list) => { let n = 0; for (const x of list) if (x?.betSlipNumber && !seen.has(x.betSlipNumber)) { seen.set(x.betSlipNumber, x); n++; } return n; };
      for (let page = 1; page <= 20; page++) {
        const list = await this.myBets('Settled', page, per);
        const fresh = take(list);
        if (page > 1 && !fresh && list.length) {
          const big = await this.myBets('Settled', 1, per * 10);
          const more = take(big);
          log.debug(`BetMGM settled list: page ${page} repeated earlier pages; read one page of ${per * 10} instead (${big.length} slips, ${more} new)`);
          break;
        }
        const oldest = Math.min(...list.map((x) => Date.parse(x.conclusionDateUtc)).filter(Number.isFinite));
        if (list.length < per || (Number.isFinite(oldest) && oldest < from)) break;
      }
      return [...seen.values()].map(settledSlip).filter(Boolean);
    },

    // Where are these bets on BetMGM? For bets still unsettled long after they were placed: open, in the
    // settled list in a form we don't read, or not listed at all. Text for the log.
    async whereAre(ids) {
      const per = b.settledPageSize || 50;
      const where = new Map();
      for (const [type, pages] of [['Open', 4], ['Settled', 6]]) {
        for (let page = 1; page <= pages; page++) {
          const list = await this.myBets(type, page, per);
          for (const x of list) if (ids.includes(String(x.betSlipNumber)) && !where.has(String(x.betSlipNumber))) {
            where.set(String(x.betSlipNumber), `${type} list, state ${x.state}, ${(x.bets || []).length} bets, outcome ${(x.bets || []).map((y) => y.state || y.outcome).join('/')}`);
          }
          if (list.length < per) break;
        }
      }
      return ids.map((id) => `${id}: ${where.get(id) || 'not in the open or settled list (first pages)'}`);
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
