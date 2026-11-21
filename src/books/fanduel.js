// FanDuel Sportsbook (Colorado, co.sportsbook.fanduel.com). Requests below match what the site
// itself sent for a $1 pre-game straight bet (Austin's capture, 2026-11-21):
//  - price:  POST smp.<st>.../readonly/v1/getMarketPrices   {marketIds:[...]}  (no login needed)
//  - slip:   POST sib.<st>.../transactional/v1/implyBets     -> live price, max stake and a
//            betReference that placeBet needs. No bet is made, so this is the price re-check.
//  - place:  POST spb.<st>.../transactional/v1/placeBet      with the exact price from the slip
//            check and acceptLowerOdds=false, so FanDuel refuses the bet if the price dropped.
//  - auth:   x-authentication header (FanDuel login, about an hour, the page renews it) and, for
//            placeBet only, x-geo-packet (FanDuel's location check, lasts 20 minutes). The
//            extension copies both from your FanDuel tab.
// Gambit only carries FanDuel New Jersey (id 100, market ids "42.x"); Colorado's market ids are
// different ("708.x"), so each row is first matched to the Colorado market (coMarket below).
// Player props are not bet on FanDuel (Austin, 2026-11-21): FanDuel is the live-prop sharp
// reference, so a FanDuel prop would be checked against itself. "fanduel": {"props": true} allows them.

import { decimalToAmerican, americanToDecimal } from '../ev.js';

const GEO = '{{fdGeo}}';

/** American odds from a FanDuel odds object ({americanDisplayOdds}, {trueOdds}), or null. */
export function fdAmerican(o) {
  const a = Number(o?.americanDisplayOdds?.americanOddsInt ?? o?.americanDisplayOdds?.americanOdds);
  if (Number.isFinite(a) && a !== 0) return Math.round(a);
  const d = Number(o?.trueOdds?.decimalOdds?.decimalOdds ?? o?.decimalDisplayOdds?.decimalOdds);
  return Number.isFinite(d) && d > 1 ? decimalToAmerican(d) : null;
}

// One settled bet from My Bets > Settled (search-bets) as a result for results.json.
// pandl is the total return (stake + winnings; 0 for a loss), the same as payout elsewhere.
export function settledBet(b) {
  if (!b?.betReceiptId || !b.isSettled || (b.legs || []).length !== 1) return null;
  const st = String(b.result || '').toUpperCase();
  const result = /CASH/.test(st) ? 'cashout'
    : /HALF/.test(st) ? (/WON|WIN/.test(st) ? 'half-won' : 'half-lost')
    : /WON|WIN/.test(st) ? 'won' : /LOST|LOSE/.test(st) ? 'lost'
    : /PUSH/.test(st) ? 'push' : /VOID|CANCEL|REFUND/.test(st) ? 'void' : null;
  if (!result) return null;
  const am = Number(b.legs[0]?.parts?.[0]?.americanPrice);
  return {
    betId: String(b.betReceiptId), result, status: st,
    payout: Math.round((Number(b.pandl) || 0) * 100) / 100,
    stake: Number.isFinite(Number(b.currentSize)) ? Number(b.currentSize) : null,
    odds: Number.isFinite(am) && am !== 0 ? am : null,
    settledAt: b.settledDate || null, placedAt: b.placedDate || null,
  };
}

// Why FanDuel refused a slip or a bet, from its failure lists and result codes.
const fdWhy = (j) => [...new Set([
  ...(j?.betFailures || []), ...(j?.legFailures || []),
  ...(j?.result || []).filter((r) => r.resultCode && r.resultCode !== 'SUCCESS'),
].map((f) => [f.resultCode, f.failureCode, f.code, f.reason, f.message].filter(Boolean).join(' ')).filter(Boolean)
  .concat(j?.respCode && j.respCode !== 'SUCCESS' ? [j.respCode] : []))].join(', ');

const uuid = () => (globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
}));

const r0 = (m, sel) => (m.runners || []).find((r) => String(r.selectionId) === String(sel));
const parseStart = (t) => { const n = Number(t); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(t); };
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
/** "Eastern Washington @ Oregon State" vs Gambit's "Eastern Washington Eagles @ Oregon State Beavers":
 *  each side's FanDuel words all appear on the same side of Gambit's name (or the other way round). */
export function sameGame(fdName, gambitName) {
  const a = String(fdName).split(' @ '), b = String(gambitName).split(' @ ');
  if (a.length !== 2 || b.length !== 2) return false;
  const inside = (x, y) => { const wy = new Set(words(y)); const wx = words(x); return wx.length > 0 && wx.every((w) => wy.has(w)); };
  return [0, 1].every((i) => inside(a[i], b[i]) || inside(b[i], a[i]));
}

// Gambit market key -> which FanDuel markets can be the same bet: the kind (FanDuel marketType
// pattern) and the period. Alternate lines, 3-way, team totals and the like never count.
const PERIODS = [
  [/_first_half$/, /^1ST_HALF_/, /half/i], [/_second_half$/, /^2ND_HALF_/, /half/i],
  [/_first_quarter$/, /^1ST_QUARTER_/, /1st quarter/i], [/_second_quarter$/, /^2ND_QUARTER_/, /2nd quarter/i],
  [/_third_quarter$/, /^3RD_QUARTER_/, /3rd quarter/i], [/_fourth_quarter$/, /^4TH_QUARTER_/, /4th quarter/i],
  [/_first_period$/, /^1ST_PERIOD_/, /period/i],
];
export function marketKind(key) {
  const k = String(key || '').toLowerCase();
  if (/player|prop|team_total|alternate/.test(k)) return null;
  const kind = /^money_line/.test(k) ? /MONEY_?LINE|^(1ST_HALF_|2ND_HALF_|1ST_QUARTER_|2ND_QUARTER_|3RD_QUARTER_|4TH_QUARTER_|1ST_PERIOD_)?MATCH_BETTING$/
    : /^spread/.test(k) ? /HANDICAP|SPREAD|PUCK_LINE|RUN_LINE/
    : /^total/.test(k) ? /TOTAL/ : null;
  if (!kind) return null;
  const p = PERIODS.find(([re]) => re.test(k));
  if (!p && /_(half|quarter|period|inning)/.test(k)) return null;   // a period we don't know
  return { kind, period: p ? p[1] : null, tab: p ? p[2] : /^$/ };
}
const BAD_TYPE = /ALTERNATE|ALT_|3-WAY|3_WAY|TEAM|ODD|EVEN|BAND|MARGIN|MADE|RACE|FIRST_TO|WINNING|EXACT|_OR_|PLAYER|SAME_GAME/;
const ANY_PERIOD = /^(1ST|2ND|3RD|4TH)_(HALF|QUARTER|PERIOD|INNING)|HALF|QUARTER|PERIOD|INNING/;
/** The FanDuel market for a row: right kind and period, two runners, has our selection. Prefers the one at our line. */
export function pickMarket(markets, eventId, sel, want, line) {
  const ok = markets.filter((m) => {
    const t = String(m.marketType || '');
    if ((eventId != null && m.eventId !== eventId) || BAD_TYPE.test(t) || !want.kind.test(t)) return false;
    if (want.period ? !want.period.test(t) : ANY_PERIOD.test(t)) return false;
    return (m.runners || []).length === 2 && !!r0(m, sel);
  });
  return ok.find((m) => line == null || Math.abs(Number(r0(m, sel).handicap)) === Math.abs(Number(line))) || ok[0] || null;
}

/** Fallback when no market has Gambit's selection id: the same kind/period market whose runner is
 *  our side by name (team, Over/Under), at exactly our line (spread: same sign too). Exactly one
 *  runner of the market may match, so the other side can never be picked. Returns {m, sel} or null. */
export function pickByName(markets, eventId, selection, want, line) {
  const w = words(selection).filter((x) => !/^[+-]?\d/.test(x));
  if (!w.length) return null;
  const same = (n) => { const a = words(n).filter((x) => !/^[+-]?\d/.test(x)); const A = new Set(a), W = new Set(w);
    return a.length > 0 && (a.every((x) => W.has(x)) || w.every((x) => A.has(x))); };
  const spread = /HANDICAP|SPREAD|PUCK_LINE|RUN_LINE/.test(String(want.kind));
  for (const m of markets) {
    const t = String(m.marketType || '');
    if ((eventId != null && m.eventId !== eventId) || BAD_TYPE.test(t) || !want.kind.test(t)) continue;
    if (want.period ? !want.period.test(t) : ANY_PERIOD.test(t)) continue;
    const rs = m.runners || [];
    if (rs.length !== 2) continue;
    const hit = rs.filter((r) => same(r.runnerName));
    if (hit.length !== 1) continue;
    const h = Number(hit[0].handicap);
    if (line != null && (spread ? h !== Number(line) : Math.abs(h) !== Math.abs(Number(line)))) continue;
    return { m, sel: hit[0].selectionId };
  }
  return null;
}

export function makeFanDuel(name, label, cfg, bridge) {
  const f = cfg.fanduel || {};
  const st = String(cfg.region || 'CO').toLowerCase();
  const host = (sub) => `https://${sub}.${st}.sportsbook.fanduel.com`;
  const appKey = f.appKey || 'FhMFpcPWXMeyZxOx';   // FanDuel's site key, the same for everyone
  const json = { accept: 'application/json', 'content-type': 'application/json', 'x-application': appKey };
  const loginMsg = 'FanDuel didn\'t accept the login: refresh the FanDuel tab and stay logged in';
  // api.sportsbook.fanduel.com (game pages, My Bets) allows the CO site's requests only without
  // cookies (no Access-Control-Allow-Credentials), the way the site makes them; with cookies the
  // browser blocks them ("Failed to fetch"). The *.co.sportsbook hosts take cookies.
  const creds = (url) => (/^https:\/\/api\.sportsbook\.fanduel\.com\//.test(url) ? 'omit' : 'include');
  // Only the headers the site itself sends to each host (the login only where it sends one).
  const send = (kind, url, method, body, extra = {}, ms = 20000, auth = true) => {
    const headers = { ...json, ...extra };
    if (body == null) delete headers['content-type'];
    return bridge.send(name, { kind, url, method, headers, body, credentials: creds(url), ...(auth ? { useFanDuelAuth: true } : {}) }, ms);
  };
  const authFail = (res) => res.status === 401 || res.status === 403;

  // ---- Gambit (New Jersey) row -> FanDuel Colorado market --------------------------------
  // Selection ids are the same in every state (a team's id, or Over 7017823 / Under 7017824);
  // market ids aren't. So: find the game on FanDuel CO's league page (by team id or names and
  // start time), read the game's markets from its event page, and pick the market of the same
  // kind and period (spread, total, moneyline; full game, 1st half, ...) that has our selection.
  const api = 'https://api.sportsbook.fanduel.com/sbapi';
  const pages = { NBA: 'nba', NCAAB: 'ncaab', NFL: 'nfl', NCAAF: 'ncaaf', NHL: 'nhl', MLB: 'mlb', WNBA: 'wnba', ...(f.leaguePages || {}) };
  const cache = new Map();   // url -> { at, json }
  const pending = new Map(); // url -> promise, so rows of the same game share one page read
  async function getJson(url, maxAgeMs) {
    const c = cache.get(url);
    if (c && Date.now() - c.at < maxAgeMs) return c.json;
    if (pending.has(url)) return pending.get(url);
    const p = readJson(url).finally(() => pending.delete(url));
    pending.set(url, p);
    return p;
  }
  async function readJson(url) {
    const res = await bridge.send(name, { kind: 'recheck', url, method: 'GET', credentials: creds(url), headers: { accept: 'application/json', 'x-sportsbook-region': st.toUpperCase() } }, 30000);
    if (res.status >= 400 || !res.json) throw new Error(`FanDuel page HTTP ${res.status}: ${String(res.text || '').slice(0, 120)}`);
    cache.set(url, { at: Date.now(), json: res.json });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return res.json;
  }

  async function findEvent(row, sel) {
    const page = pages[String(row.league || '').toUpperCase()];
    if (!page) throw new Error(`no FanDuel page known for league ${row.league} (set "fanduel": {"leaguePages": {"${row.league}": "<page id>"}})`);
    const j = await getJson(`${api}/content-managed-page?page=CUSTOM&customPageId=${page}&pbHorizontal=false&_ak=${appKey}&timezone=America%2FDenver`, 120e3);
    const events = Object.values(j.attachments?.events || {}).filter((e) => / @ /.test(e.name || '') && !/\(/.test(e.name));
    const markets = Object.values(j.attachments?.markets || {});
    const start = parseStart(row.startDate);
    const near = (e) => !Number.isFinite(start) || Math.abs(Date.parse(e.openDate) - start) < 12 * 3600e3;
    const byTeam = events.filter((e) => near(e) && markets.some((m) => m.eventId === e.eventId && (m.runners || []).some((r) => String(r.selectionId) === String(sel)) && !/OVER|UNDER/i.test(r0(m, sel)?.runnerName || '')));
    const byName = events.filter((e) => near(e) && sameGame(e.name, row.event));
    const hit = byName.length === 1 ? byName[0] : byTeam.length === 1 ? byTeam[0] : byName.find((e) => byTeam.includes(e));
    if (!hit) throw new Error(`FanDuel CO: game "${row.event}" not found on its ${row.league} page`);
    return hit.eventId;
  }

  async function coMarket(row) {
    if (row.coMarket) return row.coMarket;
    const sel = row.bookRef;
    if (!sel) throw new Error(`no FanDuel selection id in Gambit's link (${String(row.link || 'no link').slice(0, 160)})`);
    const want = marketKind(row.marketKey);
    if (!want) throw new Error(`FanDuel: market "${row.marketKey}" isn't supported yet`);
    const key = `${row.event}|${row.marketKey}|${sel}`;
    const c = cache.get(key);
    if (c && Date.now() - c.at < 10 * 60e3) return c.json;
    const eventId = await findEvent(row, sel);
    const base = `${api}/event-page?_ak=${appKey}&eventId=${eventId}&useCombinedTouchdownsVirtualMarket=true&useQuickBets=true&useQuickBetsMLB=true`;
    const first = await getJson(base, 5 * 60e3);
    const tabs = Object.values(first.layout?.tabs || {}).map((t) => t.title || '');
    const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const tries = [null, ...tabs.filter((t) => want.tab.test(t)), ...tabs.filter((t) => /same game/i.test(t))];
    const seenIn = new Set(), kindTypes = new Set();
    for (const t of [...new Set(tries)]) {
      const j = t == null ? first : await getJson(`${base}&tab=${slug(t)}`, 5 * 60e3);
      const all = Object.values(j.attachments?.markets || {});
      const m = pickMarket(all, eventId, sel, want, row.line);
      if (m) { const out = { marketId: m.marketId, selectionId: Number(sel), eventId }; cache.set(key, { at: Date.now(), json: out }); return out; }
      const byName = pickByName(all, eventId, row.selection, want, row.line);
      if (byName) { const out = { marketId: byName.m.marketId, selectionId: Number(byName.sel), eventId }; cache.set(key, { at: Date.now(), json: out }); return out; }
      for (const x of all) {
        if (x.eventId !== eventId) continue;
        if (r0(x, sel)) seenIn.add(x.marketType);
        if (want.kind.test(String(x.marketType || ''))) kindTypes.add(`${x.marketType}[${(x.runners || []).map((r) => r.selectionId).slice(0, 3).join('/')}]`);
      }
    }
    // Say what FanDuel CO does have, so a mismatch can be fixed from one log line.
    const list = (set) => [...set].slice(0, 4).join(', ') || 'none';
    throw new Error(`FanDuel CO: no ${row.market || row.marketKey} market with this selection in "${row.event}" (event ${eventId}, selection ${sel} is in: ${list(seenIn)}; markets of that kind: ${list(kindTypes)}; tabs tried: ${[...new Set(tries)].map((t) => t ?? 'main').join(', ')})`);
  }

  const runnerOf = (m, sel) => (m?.runnerDetails || []).find((r) => String(r.selectionId) === String(sel));
  const marketPrices = async (ids) => {
    const res = await send('recheck', `${host('smp')}/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0`, 'POST', { marketIds: ids }, {}, 20000, false);
    if (res.status >= 400) throw new Error(`price check HTTP ${res.status}: ${JSON.stringify(res.json || res.text).slice(0, 200)}`);
    return Array.isArray(res.json) ? res.json : [];
  };

  return {
    name, label,
    freePriceCheck: true,   // the slip check makes no bet, so a failed check can be watched and retried

    // Every scan: swap Gambit's New Jersey price for FanDuel Colorado's own price (no login
    // needed) on the FanDuel rows near or above min EV, and recompute EV from it. A row whose
    // Colorado market can't be found keeps Gambit's price; the re-check before a bet still uses
    // Colorado's price. "fanduel": {"coPrices": false} turns this off.
    async livePrices(rows, minEvPct) {
      const st = { read: 0, moved: 0, gone: 0, unmatched: 0, why: '' };
      if (f.coPrices === false) return st;
      const margin = f.directMarginPts ?? 5, max = f.directMax ?? 60;
      const near = rows.filter((r) => r.book === name && !(r.isProp && f.props !== true)
        && Number.isFinite(r.ev) && r.ev >= minEvPct - margin);
      const want = near.sort((x, y) => y.ev - x.ev).slice(0, max);
      const mapped = [];
      // A row we can't match to a Colorado market keeps Gambit's NJ price; the scan line says why.
      const miss = (r, msg) => { st.unmatched++; if (!st.why) st.why = `${r.event} ${r.market || r.marketKey}: ${msg}`; };
      await Promise.all(want.map(async (r) => {
        try { r.coMarket = await coMarket(r); mapped.push(r); } catch (e) { miss(r, e.message); }
      }));
      if (!mapped.length) return st;
      const ids = [...new Set(mapped.map((r) => r.coMarket.marketId))];
      const got = new Map();
      for (let i = 0; i < ids.length; i += 50) for (const m of await marketPrices(ids.slice(i, i + 50))) got.set(m.marketId, m);
      for (const r of mapped) {
        const mk = got.get(r.coMarket.marketId), rn = runnerOf(mk, r.coMarket.selectionId);
        const odds = fdAmerican(rn?.winRunnerOdds);
        r.gambitOdds = r.odds; r.gambitEv = r.ev;
        const lineOff = r.line != null && rn && Math.abs(Number(rn.handicap)) !== Math.abs(Number(r.line));
        if (!rn || odds == null || mk.marketStatus !== 'OPEN' || rn.runnerStatus !== 'ACTIVE' || lineOff) { r.direct = 'gone'; r.ev = -Infinity; st.gone++; continue; }
        st.read++;
        if (odds !== r.odds) st.moved++;
        r.direct = true; r.odds = odds;
        r.ev = (r.fairProb * americanToDecimal(odds) - 1) * 100;
      }
      return st;
    },

    // Live price, line and max stake from FanDuel Colorado, plus the betReference placeBet needs.
    async recheck(row) {
      if (row.isProp && f.props !== true) throw new Error('player props are off for FanDuel');
      const m = await coMarket(row);
      const mk = (await marketPrices([m.marketId])).find((x) => x.marketId === m.marketId);
      const rn = runnerOf(mk, m.selectionId);
      if (!mk || !rn) return { odds: null, suspended: true };
      const line = row.line == null ? null : Number(rn.handicap);
      if (mk.marketStatus !== 'OPEN' || rn.runnerStatus !== 'ACTIVE') return { odds: fdAmerican(rn.winRunnerOdds), line, suspended: true };

      const slip = await send('recheck', `${host('sib')}/api/sports/fixedodds/transactional/v1/implyBets?pricePolicy=SUGGESTED`, 'POST',
        { betLegs: [{ legType: 'SIMPLE_SELECTION', betRunners: [{ runner: { marketId: m.marketId, selectionId: m.selectionId } }] }] });
      const j = slip.json || {};
      if (authFail(slip)) throw new Error(loginMsg);
      if (slip.status >= 400 || j.respCode !== 'SUCCESS') throw new Error(`slip check ${slip.status >= 400 ? `HTTP ${slip.status}` : j.respCode || 'failed'}: ${fdWhy(j) || JSON.stringify(j || slip.text).slice(0, 200)}`);
      const combo = (j.betCombinations || []).find((c) => c.betType === 'SINGLE');
      const ro = (j.winRunnerOdds || j.runnerOdds || []).find((r) => String(r.runner?.selectionId) === String(m.selectionId))?.odds;
      const odds = fdAmerican(ro || combo?.winAvgOdds);
      if (!combo?.betReference || odds == null) return { odds: null, suspended: true };
      const max = Number(combo.betMaxStake);
      return {
        odds, line, suspended: false, loginOk: true,   // the slip check used your login and FanDuel accepted it
        maxStake: Number.isFinite(max) && max > 0 ? max : null,
        fd: { ...m, handicap: Number(rn.handicap) || 0, betReference: combo.betReference, trueOdds: ro?.trueOdds, oddsFor: odds, delay: mk.betDelay },
      };
    },

    async place(row, stake, quote) {
      const q = quote.fd;
      // The slip's reference and price go together: if the engine is retrying at a new price,
      // check the slip again instead of sending a price FanDuel didn't just quote.
      if (!q?.betReference || q.oddsFor !== quote.odds) {
        const fresh = await this.recheck(row);
        if (fresh.suspended || fresh.odds == null) { const e = new Error('rejected: no longer offered'); e.gone = true; throw e; }
        if (fresh.odds !== quote.odds) { const e = new Error(`rejected: price is now ${fresh.odds}`); e.priceMoved = true; e.newOdds = fresh.odds; e.newQuote = { fd: fresh.fd, maxStake: fresh.maxStake }; throw e; }
        return this.place(row, stake, { ...quote, fd: fresh.fd });
      }
      const dec = Number(q.trueOdds?.decimalOdds?.decimalOdds);
      const body = {
        customerRef: uuid(), acceptLowerOdds: false, useAvailableBonus: false, dryRun: false,
        betDefinitions: [{
          betReference: q.betReference, betType: 'SINGLE', betNo: 0, stakePerLine: stake,
          winExpectedOdds: { trueOdds: { decimalOdds: { decimalOdds: dec } } }, edges: [],
          legs: [{ legType: 'SIMPLE_SELECTION', betRunners: [{ runner: { marketId: q.marketId, selectionId: q.selectionId, handicap: q.handicap } }],
            ...(q.trueOdds?.fractionalOdds ? { winExpectedOdds: { fractionalOdds: q.trueOdds.fractionalOdds } } : {}), edgeContexts: [] }],
          wallets: [],
        }],
      };
      // Live bets wait out FanDuel's bet delay (betDelay seconds) before it answers.
      const res = await send('place', `${host('spb')}/api/sports/fixedodds/transactional/v1/placeBet`, 'POST', body, { 'x-geo-packet': GEO }, 60000);
      const j = res.json || {};
      if (authFail(res)) throw new Error(loginMsg);
      const r = j.result?.[0];
      const detail = `FanDuel placeBet response: ${JSON.stringify(j || res.text)}`;
      if (r?.resultCode === 'SUCCESS' && r.betReceiptId) {
        return { betId: `fanduel:${r.betReceiptId}`, confirmedOdds: fdAmerican(r.betPrice || r.runners?.[0]?.winOdds || r.runners?.[0]?.odds), detail };
      }
      // A receipt with a pending/accepted code: record it so the same bet is never sent twice.
      if (r?.betReceiptId && /PENDING|DELAY|ACCEPT|REFER/i.test(String(r.resultCode))) {
        return { betId: `fanduel:${r.betReceiptId} (${r.resultCode})`, confirmedOdds: null, detail };
      }
      const why = fdWhy(j) || `HTTP ${res.status}`;
      const err = new Error(`rejected: ${why}`);
      err.detail = detail;
      if (/PRICE|ODDS/i.test(why)) err.priceMoved = true;      // re-checked and retried once by the engine
      else if (/SUSPEND|CLOSED|UNAVAILABLE|NOT_ACTIVE|INACTIVE/i.test(why)) err.gone = true;
      throw err;
    },

    // Settled bets since `from` (ms), newest first, from My Bets > Settled. Read-only.
    async settled(from) {
      const out = [];
      for (let start = 1; start <= 400; start += 20) {
        const res = await send('history', `https://api.sportsbook.fanduel.com/my-bets/search-bets?isSettled=true&fromRecord=${start}&toRecord=${start + 19}&sortDir=DESC&sortParam=SETTLEMENT_DATE&rewardsClubEnabled=false&_ak=${appKey}`,
          'GET', null, { 'x-sportsbook-region': st.toUpperCase() }, 30000);
        const j = res.json || {};
        if (authFail(res)) throw new Error(loginMsg);
        if (res.status >= 400 || !Array.isArray(j.bets)) throw new Error(`settled bets HTTP ${res.status}: ${JSON.stringify(j || res.text).slice(0, 200)}`);
        out.push(...j.bets.map(settledBet).filter(Boolean));
        const oldest = Date.parse(j.bets.at(-1)?.settledDate);
        if (!j.moreAvailable || !j.bets.length || (Number.isFinite(oldest) && oldest < from)) break;
      }
      return out;
    },

    // Once a minute (session.js): read the balance, like the site does, to tell whether you're
    // still logged in.
    async sessionCheck() {
      // Once a minute (session.js): read your open bets (one record, read-only, the same list as
      // My Bets) with the sportsbook login the bets use. Not the balance on api.fanduel.com: that
      // server answers a refused login with a browser "Sign in" box (seen 2026-11-21).
      const res = await send('session', `https://api.sportsbook.fanduel.com/my-bets/search-bets?isSettled=false&fromRecord=1&toRecord=20&sortDir=DESC&sortParam=PLACEMENT_DATE&rewardsClubEnabled=false&_ak=${appKey}`,
        'GET', null, { 'x-sportsbook-region': st.toUpperCase() }, 15000);
      if (res.status < 400 && Array.isArray(res.json?.bets)) return { ok: true };
      if (authFail(res)) return { ok: false, why: `FanDuel My Bets check answered HTTP ${res.status}` };
      throw new Error(`FanDuel login check HTTP ${res.status}: ${JSON.stringify(res.json || res.text).slice(0, 120)}`);
    },
  };
}
