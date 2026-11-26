// FanDuel Sportsbook (Colorado, co.sportsbook.fanduel.com). Requests below match what the site
// itself sent for a $1 pre-game straight bet (Austin's capture, 2026-11-21):
//  - price:  POST smp.<st>.../readonly/v1/getMarketPrices   {marketIds:[...]}  (no login needed)
//  - slip:   POST sib.<st>.../transactional/v1/implyBets     -> live price, max stake and a
//            betReference that placeBet needs. No bet is made, so this is the price re-check.
//  - place:  POST spb.<st>.../transactional/v1/placeBet      with the exact price from the slip
//            check and acceptLowerOdds=false, so FanDuel refuses the bet if the price dropped.
//  - auth:   x-authentication header (FanDuel login, about an hour, the page renews it) and, for
//            placeBet only, x-geo-packet (FanDuel's location check, lasts 20 minutes). The
//            extension copies both from your FanDuel tab, and gets the page to renew the location
//            check when it's about to run out (see background.js).
// Gambit only carries FanDuel New Jersey (id 100, market ids "42.x"); Colorado's market ids are
// different ("708.x"), so each row is first matched to the Colorado market (coMarket below).
// Player props are not bet on FanDuel (Austin, 2026-11-21): FanDuel is the live-prop sharp
// reference, so a FanDuel prop would be checked against itself. "fanduel": {"props": true} allows them.

import { decimalToAmerican, americanToDecimal } from '../ev.js';
import { log } from '../log.js';

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

// Why FanDuel refused a slip or a bet: every code/reason/message anywhere in its reply (the
// specific reason often sits a level down, e.g. legFailures[].runnerFailures[].failureCode).
const WHY_KEY = /^(resultCode|failureCode|failureReason|code|reason|message|errorCode|subCode|respCode)$/i;
const fdWhy = (j) => {
  const out = [];
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 6) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && WHY_KEY.test(k) && x && !/^SUCCESS$|^OK$/i.test(x)) out.push(x);
      else if (x && typeof x === 'object') walk(x, depth + 1);
    }
  };
  walk(j, 0);
  return [...new Set(out)].join(', ');
};

const uuid = () => (globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
}));

const r0 = (m, sel) => (m.runners || []).find((r) => String(r.selectionId) === String(sel));
const parseStart = (t) => { const n = Number(t); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(t); };
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
// FanDuel writes some schools with a state in brackets: "Miami (OH)", "Loyola (MD)". Gambit
// spells the state out ("Miami Ohio RedHawks"), so the bracket becomes the state's name.
const STATES = { OH: 'Ohio', FL: 'Florida', PA: 'Pennsylvania', IL: 'Illinois', MD: 'Maryland', NY: 'New York',
  CA: 'California', MN: 'Minnesota', TX: 'Texas', LA: 'Louisiana', CHI: 'Chicago', MS: 'Mississippi', AL: 'Alabama',
  MO: 'Missouri', IN: 'Indiana', MI: 'Michigan', NC: 'North Carolina', SC: 'South Carolina', VA: 'Virginia', OR: 'Oregon' };
export const fdTeamName = (s) => String(s || '').replace(/\(([A-Za-z]{2,3})\)/g, (all, st) => STATES[st.toUpperCase()] || st);
/** A virtual (simulated) game: FanDuel adds a player tag in brackets to both teams, "Celtics (JDOE)".
 *  A state in brackets ("Miami (OH)") doesn't count. */
const tagged = (side) => (String(side).match(/\(([^)]*)\)/g) || []).some((b) => !STATES[b.slice(1, -1).trim().toUpperCase()]);
export const isVirtual = (name) => { const sides = String(name || '').split(' @ '); return sides.length === 2 && sides.every(tagged); };
/** "Eastern Washington @ Oregon State" vs Gambit's "Eastern Washington Eagles @ Oregon State Beavers":
 *  each side's FanDuel words all appear on the same side of Gambit's name (or the other way round). */
export function sameGame(fdName, gambitName) {
  const a = String(fdName).split(' @ '), b = String(gambitName).split(' @ ');
  if (a.length !== 2 || b.length !== 2) return false;
  const inside = (x, y) => { const wy = new Set(words(y)); const wx = words(x); return wx.length > 0 && wx.every((w) => wy.has(w)); };
  const same = (x, y) => inside(x, y) || inside(y, x);
  // Either order: PropProfessor's game names don't always put the away team first.
  return (same(a[0], b[0]) && same(a[1], b[1])) || (same(a[0], b[1]) && same(a[1], b[0]));
}

// Gambit market key -> which FanDuel markets can be the same bet: the kind (FanDuel marketType
// pattern) and the period. Alternate lines, 3-way, team totals and the like never count.
// FanDuel spells periods both ways: 1ST_HALF_HANDICAP and FIRST_HALF_ALTERNATE_HANDICAP.
const PERIODS = [
  [/_first_half$/, /^(1ST|FIRST)_HALF_/, /half/i], [/_second_half$/, /^(2ND|SECOND)_HALF_/, /half/i],
  [/_first_quarter$/, /^(1ST|FIRST)_QUARTER_/, /1st quarter/i], [/_second_quarter$/, /^(2ND|SECOND)_QUARTER_/, /2nd quarter/i],
  [/_third_quarter$/, /^(3RD|THIRD)_QUARTER_/, /3rd quarter/i], [/_fourth_quarter$/, /^(4TH|FOURTH)_QUARTER_/, /4th quarter/i],
  [/_first_period$/, /^(1ST|FIRST)_PERIOD_/, /period/i],
];
export function marketKind(key) {
  const k = String(key || '').toLowerCase();
  if (/player|prop|team_total|alternate/.test(k)) return null;
  const kind = /^money_line/.test(k) ? /MONEY_?LINE|^((1ST|2ND|FIRST|SECOND)_HALF_|(1ST|2ND|3RD|4TH|FIRST|SECOND|THIRD|FOURTH)_QUARTER_|(1ST|FIRST)_PERIOD_)?MATCH_BETTING$/
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

// Alternate lines: FanDuel lists every line of an alternate spread/total in one market, one runner
// per side and line ("Over 145.5", "Iowa Hawkeyes -16.5"). Runner handicap may be 0 there, so the
// line also comes from the runner's name.
const ALT_BAD = /TEAM|3-WAY|3_WAY|ODD|EVEN|BAND|MARGIN|MADE|RACE|FIRST_TO|WINNING|EXACT|_OR_|PLAYER|SAME_GAME/;
const nums = (s) => (String(s || '').match(/[+-]?\d+(?:\.\d+)?/g) || []).map(Number);
/** Line of an alternate-line runner: its handicap, or else the number in its name. */
export function altLine(r) {
  const h = Number(r?.handicap);
  if (Number.isFinite(h) && h !== 0) return h;
  const n = nums(r?.runnerName);
  return n.length ? n[n.length - 1] : (Number.isFinite(h) ? h : null);
}
/** Our side in an alternate spread/total market: Gambit's selection id, or else by name at exactly
 *  our line (spread: same sign). Exactly one runner may match by name. Returns {m, sel, line} or null. */
export function pickAlt(markets, eventId, sel, selection, want, line) {
  const spread = /HANDICAP|SPREAD|PUCK_LINE|RUN_LINE/.test(String(want.kind));
  const lineOk = (v) => line == null || (spread ? v === Number(line) : Math.abs(v) === Math.abs(Number(line)));
  const w = words(selection).filter((x) => !/^[+-]?\d/.test(x));
  const same = (n) => { const a = words(n).filter((x) => !/^[+-]?\d/.test(x)); const A = new Set(a), W = new Set(w);
    return w.length > 0 && a.length > 0 && (a.every((x) => W.has(x)) || w.every((x) => A.has(x))); };
  const alts = markets.filter((m) => {
    const t = String(m.marketType || '');
    if ((eventId != null && m.eventId !== eventId) || !/ALT/.test(t) || ALT_BAD.test(t) || !want.kind.test(t)) return false;
    return want.period ? want.period.test(t) : !ANY_PERIOD.test(t.replace(/^ALTERNATE_|^ALT_/, ''));
  });
  for (const m of alts) {
    const r = r0(m, sel);
    if (r && lineOk(altLine(r))) return { m, sel: r.selectionId, line: altLine(r) };
  }
  for (const m of alts) {
    const hit = (m.runners || []).filter((r) => same(r.runnerName) && lineOk(altLine(r)));
    if (hit.length === 1) return { m, sel: hit[0].selectionId, line: altLine(hit[0]) };
  }
  return null;
}

// FanDuel's sport ids (eventTypeId, the same ids as Betfair's), so a league with no page of its
// own can still be found: by the league's name, or the sport name PropProfessor/Gambit send.
// "fanduel": {"eventTypes": {"<league>": <id>}} adds or overrides one.
const SPORT_IDS = [
  [/^golf|^pga|^lpga|^liv|dp world/i, 3],
  [/tennis|^atp|^wta|^itf|challenger|davis cup|billie jean|united cup|laver cup|wimbledon|french open|roland garros|australian open/i, 2],
  [/^(nba|wnba|ncaab|ncaaw|wncaab|cbb|euroleague|eurocup|nbl|cba|acb|g ?league|fiba|basketball|bball)/i, 7522],
  [/^(nhl|ahl|khl|shl|liiga|del|nla|iihf|hockey|ice hockey)/i, 7524],
  [/^(mlb|kbo|npb|cpbl|wbc|baseball|ncaa ?baseball)/i, 7511],
  [/^(nfl|ncaaf|cfb|cfl|ufl|xfl|football|american football)$/i, 6423],
  [/^(ufc|mma|pfl|bellator|one championship|lfa)/i, 26420387],
  [/^boxing/i, 6],
  [/soccer|^epl|premier league|^championship$|efl championship|la ?liga|bundesliga|serie [ab]|ligue [12]|^mls|uefa|^ucl|^uel|champions league|europa|conference league|eredivisie|liga mx|primeira|super lig|world cup|copa|fa cup|carabao|efl|^nwsl|scottish|a-league|j1|k league|brasileir|argentin|saudi/i, 1],
  [/cricket|^ipl|big bash|^t20|^odi/i, 4],
  [/darts|^pdc/i, 3503],
  [/snooker/i, 6422],
  [/rugby league|^nrl|super league/i, 1477],
  [/rugby|six nations|super rugby|premiership rugby|top 14/i, 5],
  [/aussie rules|^afl/i, 61420],
  [/volleyball/i, 998917],
  [/handball/i, 468328],
  [/esports|^lol|league of legends|^cs2?$|counter-strike|dota|valorant/i, 27454571],
];
export function eventTypeFor(league, extra = {}) {
  const lg = String(league || '').trim();
  const own = Object.entries(extra || {}).find(([k]) => k.toUpperCase() === lg.toUpperCase());
  if (own) return Number(own[1]) || null;
  return SPORT_IDS.find(([re]) => re.test(lg))?.[1] || null;
}
// FanDuel names tennis, soccer and fight events "A v B" (US leagues "Away @ Home"); same for both.
export const atName = (s) => String(s || '').replace(/\s+(?:v|vs\.?|versus)\s+/i, ' @ ');

/** Every event in a FanDuel page or search answer: attachments.events, or anywhere deeper
 *  (the event search's answer shape isn't the pages' one). */
export function pageEvents(j) {
  const out = new Map();
  for (const e of Object.values(j?.attachments?.events || {})) if (e?.eventId != null && e.name) out.set(String(e.eventId), e);
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 8) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (v.eventId != null && typeof v.name === 'string' && (v.openDate || / v | @ /.test(v.name)) && !out.has(String(v.eventId))) out.set(String(v.eventId), v);
    for (const x of Object.values(v)) if (x && typeof x === 'object') walk(x, depth + 1);
  };
  walk(j, 0);
  return [...out.values()];
}
/** The few event names closest to ours (shared words), for the not-found message. */
export function nearestNames(events, event, n = 2) {
  const want = new Set(words(atName(event)).filter((w) => w.length > 2));
  return events.map((e) => ({ name: atName(e.name), k: words(e.name).filter((w) => want.has(w)).length }))
    .filter((x) => x.k > 0).sort((a, b) => b.k - a.k).slice(0, n).map((x) => x.name);
}

/** Our game among a page's (or search's) events: by team selection id or names and start time. */
export function matchEvent(rawEvents, markets, row, sel) {
  const event = atName(row.event);
  // Real games only (not virtual ones), with "(OH)"-style states spelled out like Gambit does.
  const events = rawEvents.map((e) => ({ ...e, name: atName(e.name) })).filter((e) => / @ /.test(e.name || '') && !isVirtual(e.name))
    .map((e) => ({ ...e, name: fdTeamName(e.name) }));
  const start = parseStart(row.startDate);
  // An event without a start time (some answers leave it out) isn't ruled out by it.
  const near = (e) => !Number.isFinite(start) || !Number.isFinite(Date.parse(e.openDate)) || Math.abs(Date.parse(e.openDate) - start) < 12 * 3600e3;
  const byTeam = sel == null ? [] : events.filter((e) => near(e) && markets.some((m) => m.eventId === e.eventId && (m.runners || []).some((r) => String(r.selectionId) === String(sel)) && !/OVER|UNDER/i.test(r0(m, sel)?.runnerName || '')));
  const byName = events.filter((e) => near(e) && sameGame(e.name, event));
  // Names FanDuel shortens ("NC State" for North Carolina State): one side matching, the other
  // sharing a word, and the same start (within 30 min), if that is a single game.
  const oneSide = (e) => { const a = String(e.name).split(' @ '), b = String(event).split(' @ ');
    const inside = (x, y) => { const wy = new Set(words(y)); const wx = words(x); return wx.length > 0 && wx.every((w) => wy.has(w)); };
    const share = (x, y) => { const wy = new Set(words(y)); return words(x).some((w) => wy.has(w)); };
    const one = (bb) => [0, 1].some((i) => (inside(a[i], bb[i]) || inside(bb[i], a[i])) && share(a[1 - i], bb[1 - i]));
    return a.length === 2 && b.length === 2 && (one(b) || one([b[1], b[0]])); };
  const soon = (e) => Number.isFinite(start) && Math.abs(Date.parse(e.openDate) - start) <= 30 * 60e3;
  const byHalf = events.filter((e) => soon(e) && oneSide(e));
  return (byName.length === 1 ? byName[0] : byTeam.length === 1 ? byTeam[0] : byName.find((e) => byTeam.includes(e))
    || (byName.length === 0 && byHalf.length === 1 ? byHalf[0] : null)) || null;
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
  // The event search (scan.<state>.sportsbook) is public too and is sent without cookies: with
  // FanDuel's large .fanduel.com cookies on it the server answers HTTP 431 (headers too large).
  const creds = (url) => (/^https:\/\/(api\.sportsbook|scan\.[a-z]+\.sportsbook)\.fanduel\.com\//.test(url) ? 'omit' : 'include');
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

  // Leagues without a page above (Tennis, soccer, UFC, ...) are found through FanDuel's sport:
  // first its sport page, then FanDuel's own event search for every game of that sport.
  const sportPage = (t) => `${api}/content-managed-page?page=SPORT&eventTypeId=${t}&pbHorizontal=false&_ak=${appKey}&timezone=America%2FDenver`;
  const facetUrl = `${host('scan')}/api/sports/navigation/facet/v1.0/search`;
  // Body shapes tried in turn until FanDuel takes one (it answers 400 to a shape it doesn't
  // like); the one that works is remembered. A big maxValues first: with FanDuel's default only
  // the first few matches of the sport come back, and tennis has hundreds.
  let searchShape = null;
  const shapes = [1000, 500, 200, 100, null];
  async function searchSport(t, text) {
    const key = `facet:${t}:${text || ''}`;
    const c = cache.get(key);
    if (c && Date.now() - c.at < 120e3) return c.json;
    const body = (max) => ({ filter: { eventTypeIds: [Number(t)], contentGroup: { language: 'en', regionCode: 'NAMERICA' },
      marketLevels: ['AVB_EVENT'], maxResults: 0, productTypes: ['SPORTSBOOK'], selectBy: 'FIRST_TO_START', ...(text ? { textQuery: text } : {}) },
      facets: [{ type: 'EVENT', ...(max ? { maxValues: max } : {}) }], currencyCode: 'USD', locale: 'en_US' });
    let res = null;
    for (const max of searchShape != null ? [searchShape] : shapes) {
      res = await send('recheck', facetUrl, 'POST', body(max), {}, 30000, false);
      if (res.status !== 400) { if (res.status < 400 && res.json) searchShape = max; break; }
    }
    if (res.status >= 400 || !res.json) throw new Error(`FanDuel event search HTTP ${res.status}: ${String(res.text || '').slice(0, 120)}`);
    cache.set(key, { at: Date.now(), json: res.json });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return res.json;
  }

  async function findEvent(row, sel) {
    const lg = String(row.league || '');
    const page = pages[lg.toUpperCase()] || Object.entries(f.leaguePages || {}).find(([k]) => k.toUpperCase() === lg.toUpperCase())?.[1];
    const type = eventTypeFor(lg, f.eventTypes);
    if (!page && !type) throw new Error(`no FanDuel page known for league ${row.league} (set "fanduel": {"leaguePages": {"${row.league}": "<page id>"}} or {"eventTypes": {"${row.league}": <FanDuel sport id>}})`);
    const tried = [];
    const look = async (what, read) => {
      try {
        const j = await read();
        const evs = pageEvents(j);
        const hit = matchEvent(evs, Object.values(j.attachments?.markets || {}), row, sel);
        if (hit) { tried.push(`${what}: found`); return hit; }
        // Not there: say how many games FanDuel listed and the closest names, so the next
        // log line shows whether the game is missing or its name is written differently.
        const near = nearestNames(evs, row.event);
        tried.push(`${what}: not there (${evs.length} games${near.length ? `, closest: ${near.join(' / ')}` : ''})`);
        if (!evs.length) log.debug(`FanDuel ${what} for ${row.league} listed no games. Answer: ${JSON.stringify(j).slice(0, 1500)}`);
        return null;
      } catch (e) { tried.push(`${what}: ${e.message}`); return null; }
    };
    // FanDuel's search by name: the longest word of each side (a surname, a team's city).
    const keyWord = (side) => words(side).sort((a, b) => b.length - a.length)[0];
    const sides = atName(row.event).split(' @ ').map(keyWord).filter(Boolean);
    const hit = (page && await look(`${row.league} page`, () => getJson(`${api}/content-managed-page?page=CUSTOM&customPageId=${page}&pbHorizontal=false&_ak=${appKey}&timezone=America%2FDenver`, 120e3)))
      || (type && await look('sport page', () => getJson(sportPage(type), 120e3)))
      || (type && await look('event search', () => searchSport(type)))
      || (type && sides[0] && await look(`search "${sides[0]}"`, () => searchSport(type, sides[0])));
    if (!hit) throw new Error(`FanDuel CO: game "${row.event}" not found (${row.league}; ${tried.join(', ')})`);
    return hit.eventId;
  }

  // Which CO market each Gambit row is: kept apart from the page cache (whose 200-page limit
  // used to push these out, so the same games were looked up again and again).
  const mapKey = (row) => `${row.event}|${row.marketKey}|${row.bookRef}`;
  const mapCache = new Map();   // key -> { at, out } or { at, err }
  const remember = (key, v) => {
    mapCache.delete(key); mapCache.set(key, { at: Date.now(), ...v });
    if (mapCache.size > 3000) mapCache.delete(mapCache.keys().next().value);
  };
  // Looking a game up can take several page reads through the FanDuel tab, so it runs in the
  // background (a few at a time) and the scan uses whatever is already known. A row not found
  // is looked up again after 60s.
  const mapQueue = [], mapping = new Set();
  let mapRunning = 0;
  const mapNext = () => {
    while (mapRunning < (f.lookupsAtOnce ?? 4) && mapQueue.length) {
      const r = mapQueue.shift();
      const key = mapKey(r);
      mapRunning++;
      coMarket(r).catch((e) => remember(key, { err: e.message }))
        .finally(() => { mapRunning--; mapping.delete(key); mapNext(); });
    }
  };
  const lookUpLater = (r) => {
    const key = mapKey(r);
    if (mapping.has(key)) return;
    mapping.add(key); mapQueue.push(r); mapNext();
  };

  async function coMarket(row) {
    if (row.coMarket) return row.coMarket;
    const sel = row.bookRef;
    if (!sel) throw new Error(`no FanDuel selection id in Gambit's link (${String(row.link || 'no link').slice(0, 160)})`);
    const want = marketKind(row.marketKey);
    if (!want) throw new Error(`FanDuel: market "${row.marketKey}" isn't supported yet`);
    const key = mapKey(row);
    const c = mapCache.get(key);
    if (c?.out && Date.now() - c.at < 10 * 60e3) return c.out;
    // Fast path: the market id from the row's own link (PropProfessor's one-click data). If
    // FanDuel CO has that market with our selection, it is the bet; no game lookup needed.
    // (Gambit's ids are New Jersey's and won't be there, so those rows go the long way.)
    if (row.marketRef) {
      try {
        const mk = (await marketPrices([String(row.marketRef)])).find((x) => String(x.marketId) === String(row.marketRef));
        if (mk && runnerOf(mk, sel)) { const out = { marketId: mk.marketId, selectionId: Number(sel), eventId: mk.eventId }; remember(key, { out }); return out; }
      } catch { /* the long way below */ }
    }
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
      if (m) { const out = { marketId: m.marketId, selectionId: Number(sel), eventId }; remember(key, { out }); return out; }
      const byName = pickByName(all, eventId, row.selection, want, row.line);
      if (byName) { const out = { marketId: byName.m.marketId, selectionId: Number(byName.sel), eventId }; remember(key, { out }); return out; }
      for (const x of all) {
        if (x.eventId !== eventId) continue;
        if (r0(x, sel)) seenIn.add(`${x.marketType} at ${altLine(r0(x, sel))}`);
        if (want.kind.test(String(x.marketType || ''))) kindTypes.add(`${x.marketType}[${(x.runners || []).map((r) => r.selectionId).slice(0, 3).join('/')}]`);
      }
    }
    // Not a main line: look for exactly this line among FanDuel CO's alternate lines (main page,
    // then tabs that can hold them). "fanduel": {"altLines": false} turns this off.
    if (f.altLines !== false) {
      // Likely tabs first, then any other non-player tab (titles differ by sport), at most 10.
      const likely = tabs.filter((t) => /alt|spread|total|line|handicap|points|goals|runs/i.test(t) && !/player|prop|same game/i.test(t));
      const other = tabs.filter((t) => !/player|prop|same game|odd\/even|margin|scorer|touchdown/i.test(t));
      const altTabs = [...new Set([...likely, ...other])].slice(0, 10);
      // The Same Game Parlay tab often carries every alternate line too (NFL), so look there last.
      for (const t of [...new Set([null, ...altTabs, ...tabs.filter((x) => /same game/i.test(x))])]) {
        const j = t == null ? first : await getJson(`${base}&tab=${slug(t)}`, 5 * 60e3);
        const a = pickAlt(Object.values(j.attachments?.markets || {}), eventId, sel, row.selection, want, row.line);
        if (a) { const out = { marketId: a.m.marketId, selectionId: Number(a.sel), eventId, alt: true, line: a.line }; remember(key, { out }); return out; }
        if (t != null) tries.push(t);
      }
    }
    // Say what FanDuel CO does have, so a mismatch can be fixed from one log line.
    const list = (set) => [...set].slice(0, 4).join(', ') || 'none';
    throw new Error(`FanDuel CO: no ${row.market || row.marketKey} market with this selection in "${row.event}" (event ${eventId}, Gambit line ${row.line}, selection ${sel} is in: ${list(seenIn)}; markets of that kind: ${list(kindTypes)}; tabs tried: ${[...new Set(tries)].map((t) => t ?? 'main').join(', ')}; tabs on the page: ${tabs.join(', ') || 'none listed'})`);
  }

  // A runner's line: its handicap; on an alternate-line market with no handicap, the line we matched.
  const lineOf = (rn, m) => { const h = Number(rn?.handicap); return m?.alt && !(Number.isFinite(h) && h !== 0) ? Number(m.line) : h; };
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
      // Only rows whose CO market is already known are priced now; the rest are looked up in
      // the background and keep Gambit's price until then (the check before a bet always uses
      // FanDuel CO's own price), so a slow FanDuel tab never holds up the scan.
      for (const r of want) {
        const c = mapCache.get(mapKey(r)), age = c ? Date.now() - c.at : Infinity;
        if (c?.out && age < 10 * 60e3) { r.coMarket = c.out; mapped.push(r); continue; }
        if (c?.err && age < 60e3) { miss(r, c.err); continue; }
        if (!r.bookRef) { miss(r, `no FanDuel selection id in Gambit's link (${String(r.link || 'no link').slice(0, 160)})`); continue; }
        st.lookingUp = (st.lookingUp || 0) + 1;
        lookUpLater(r);
      }
      if (!mapped.length) return st;
      const ids = [...new Set(mapped.map((r) => r.coMarket.marketId))];
      const got = new Map();
      for (let i = 0; i < ids.length; i += 50) for (const m of await marketPrices(ids.slice(i, i + 50))) got.set(m.marketId, m);
      for (const r of mapped) {
        const mk = got.get(r.coMarket.marketId), rn = runnerOf(mk, r.coMarket.selectionId);
        const odds = fdAmerican(rn?.winRunnerOdds);
        r.gambitOdds = r.odds; r.gambitEv = r.ev;
        const lineOff = r.line != null && rn && Math.abs(lineOf(rn, r.coMarket)) !== Math.abs(Number(r.line));
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
      // The market read (status, line, bet delay) and the slip check (price, betReference) go out
      // together instead of one after the other: one round trip through the FanDuel tab, not two.
      // Both are reads; no bet is made.
      const [mks, slip] = await Promise.all([
        marketPrices([m.marketId]),
        send('recheck', `${host('sib')}/api/sports/fixedodds/transactional/v1/implyBets?pricePolicy=SUGGESTED`, 'POST',
          { betLegs: [{ legType: 'SIMPLE_SELECTION', betRunners: [{ runner: { marketId: m.marketId, selectionId: m.selectionId } }] }] }),
      ]);
      const mk = mks.find((x) => x.marketId === m.marketId);
      const rn = runnerOf(mk, m.selectionId);
      if (!mk || !rn) return { odds: null, suspended: true };
      const line = row.line == null ? null : lineOf(rn, m);
      if (mk.marketStatus !== 'OPEN' || rn.runnerStatus !== 'ACTIVE') return { odds: fdAmerican(rn.winRunnerOdds), line, suspended: true };

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
        betDelaySec: Number(mk.betDelay) || null,   // FanDuel holds live bets this long before it answers
        // The line goes with the slip's reference: the slip check says which line it priced (a
        // spread/total's line can move under the same selection), so the bet sends that one.
        fd: { ...m, handicap: Number((j.winRunnerOdds || j.runnerOdds || []).find((r) => String(r.runner?.selectionId) === String(m.selectionId))?.runner?.handicap ?? rn.handicap) || 0, betReference: combo.betReference, trueOdds: ro?.trueOdds, oddsFor: odds, delay: mk.betDelay },
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
      const err = new Error(`rejected: ${why} (FanDuel's full reply is in debug.log)`);
      err.detail = detail;
      if (/PRICE|ODDS/i.test(why)) {
        // REQUESTED_PRICE_NOT_AVAILABLE: the price moved between the slip check and the bet. The
        // reply carries FanDuel's current price; the engine checks every rule again at it.
        err.priceMoved = true;
        const now = Number(r?.runners?.[0]?.winOdds?.americanDisplayOdds?.americanOdds ?? r?.legs?.[0]?.winOdds?.americanDisplayOdds?.americanOdds);
        if (Number.isFinite(now) && now !== 0 && now !== quote.odds) err.newOdds = now;
      }
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
