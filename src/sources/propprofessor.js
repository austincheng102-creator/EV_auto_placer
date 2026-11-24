// PropProfessor (propprofessor.com) as a source of +EV rows, next to or instead of Gambit.
// config.json: "source": "gambit" (default) | "propprofessor" | "both".
//
// How the rows get here: PropProfessor's own pages (Positive EV, Arbitrage) keep their table in the
// page, fed live by PropProfessor's servers. The Chrome extension reads that table out of your open,
// logged-in PropProfessor tabs every poll. The app never calls PropProfessor itself: it only reads
// what the page already shows you. So the login is the page's own (it renews itself), and the data
// is whatever your PropProfessor settings show (books, leagues, min EV, hours away, ...). Keep those
// settings at least as wide as the app's rules (e.g. PropProfessor min EV at or below the app's 8%).
//
// The extension keeps one tab per table it needs (pre-game +EV, live +EV, pre-game arbitrage, live
// arbitrage), opens any that are missing and clicks Live / Pre-Match on it, because a page only
// shows one of the two at a time and goes back to Pre-Match when it reloads.
//
// Each PropProfessor row becomes the same kind of row Gambit's evs.json gives, so every rule applies
// the same way (min/max EV, odds window, sharp books, prediction markets, live timing, soft-book and
// Pinnacle-vs-market checks, groups, Novig, gambitBehind, the price re-check at the book, ...):
//  - book prices: PropProfessor lists every book's price for both sides (sportsbookData) -> prices,
//    keyed by the Gambit ids the rules use (Pinnacle 1014, Kalshi 194, Polymarket 193/1011, Novig 192, ...)
//  - fair: PropProfessor's no-vig fair (noVigOdds, set by your PropProfessor devig/comparison settings)
//  - the bet itself: PropProfessor's link / ids for that book (BetRivers outcome, Hard Rock selection,
//    FanDuel selection, BetMGM option, DraftKings outcome, theScore selection)
//  - arbitrage table: player props on arbProps.books, priced off arbProps.refBooks like Gambit's.
import fs from 'node:fs';
import path from 'node:path';
import { americanToDecimal, decimalToAmerican, impliedProb } from '../ev.js';
import { fairKey } from '../betlog.js';
import { arbDefaults, refFair, arbStats } from './gambit-arbs.js';
import { DEFAULT_BOOK_IDS, kambiRef, betmgmRefs, prettyMarket } from './gambit-evs.js';
import { draftkingsRef } from '../books/draftkings.js';
import { thescoreRef } from '../books/thescore.js';

// PropProfessor book names -> our book names (the ones the app can bet).
export const PP_BOOKS = { BetRivers: 'betrivers', Hardrock: 'hardrock', FanDuel: 'fanduel', BetMGM: 'betmgm', DraftKings: 'draftkings', theScore: 'thescore' };
// PropProfessor book names -> the Gambit ids the rules know them by. Books Gambit doesn't have get
// ids of their own (90000+), so they're in the row but no rule counts them.
export const PP_IDS = {
  Pinnacle: 1014, Kalshi: 194, Polymarket: 193, PolymarketUS: 1011, NoVigApp: 192, Prophet: 191,
  FanDuel: 100, DraftKings: 200, Caesars: 300, BetMGM: 400, theScore: 700, BetRivers: 1004, Hardrock: DEFAULT_BOOK_IDS.hardrock,
  BallyBet: 500, BetParx: 1005, Fliff: 800, Bovada: 1006, BetOnline: 613, PrizePicks: 385,
};
const otherIds = new Map();
export function ppId(name) {
  if (PP_IDS[name] != null) return PP_IDS[name];
  if (!otherIds.has(name)) otherIds.set(name, 90000 + otherIds.size);
  return otherIds.get(name);
}

// PropProfessor market names -> Gambit's market keys (what the book code and the rules expect).
// Markets not listed here (3-way moneylines, draw no bet, corners, ...) aren't used.
const BASE = {
  'Moneyline': 'money_line', 'Point Spread': 'spread', 'Match Handicap': 'spread', 'Game Handicap': 'spread',
  'Total Points': 'total_game_points', 'Total Goals': 'total_game_points', 'Total Games': 'total_games',
  'Team Total Points': 'team_total_points', 'Team Total Goals': 'team_total_points',
};
// Player props Gambit spells differently (so groups and the bet log line up with Gambit's rows).
const PROP_ALIAS = { RECEPTIONS: 'TOTAL_RECEPTIONS', THREES_MADE: 'THREE_POINTER' };
const PERIOD = { '1st Half': 'first_half', '2nd Half': 'second_half', '1st Quarter': 'first_quarter', '2nd Quarter': 'second_quarter',
  '3rd Quarter': 'third_quarter', '4th Quarter': 'fourth_quarter', '1st Period': 'first_period', '2nd Period': 'second_period',
  '3rd Period': 'third_period', '1st Set': 'first_set', '2nd Set': 'second_set' };
export function marketKeyOf(market) {
  const [base, per] = String(market || '').split(/\s+-\s+/);
  const p = per == null ? '' : PERIOD[per.trim()];
  if (p === undefined) return null;
  const suffix = p ? `_${p}` : '';
  if (BASE[base]) return BASE[base] + suffix;
  const m = /^Player (.+)$/.exec(base);
  if (!m) return null;
  let k = m[1].toUpperCase().replace(/\s*\+\s*/g, '_').replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  k = PROP_ALIAS[k] || k;
  return `PLAYER_PROP_${k}${suffix.toUpperCase()}`;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
const SIDE_RE = /\s+(Over|Under)\s+[\d.]+$/i;

/** Selection and signed line the way Gambit writes them: "Over" / "Trae Young Over" / team name, spreads signed. */
export function selectionOf(r, marketKey) {
  const sel = String(r.selection || '').trim();
  const ou = SIDE_RE.exec(` ${sel}`) || /^(Over|Under)\b/i.exec(sel);
  const absLine = Number(r.line);
  if (/^money_line/.test(marketKey)) return { selection: r.participant || sel, line: null };
  if (/^spread/.test(marketKey)) {
    const m = /([+-]\d+(?:\.\d+)?)$/.exec(sel);
    const line = m ? Number(m[1]) : (Number.isFinite(absLine) ? absLine : null);
    return { selection: r.participant || sel.replace(/\s*[+-]\d+(?:\.\d+)?$/, ''), line };
  }
  const side = ou ? cap(ou[1]) : '';
  if (!side) return null;
  const who = r.participant ? `${r.participant} ` : '';
  return { selection: `${who}${side}`.trim(), line: Number.isFinite(absLine) ? absLine : null };
}

/** Game start: the time in the game id (epoch seconds), else the start field (UTC). */
function startOf(r) {
  const n = Number(String(r.gameId || '').split(':').pop());
  if (Number.isFinite(n) && n > 1e9) return n;
  const s = String(r.start || '');
  const t = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
}

/**
 * "Away @ Home" like Gambit and the books. PropProfessor's home/away fields aren't always the right
 * way round, so a FanDuel or DraftKings page link for the same game ("kansas-@-oklahoma-state")
 * decides the order when there is one.
 */
function eventNames(rows) {
  const order = new Map();   // gameId -> true when homeTeam is listed first (away)
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (const r of rows) {
    if (order.has(r.gameId)) continue;
    for (const u of [r.pageUrl, r.site1Url, r.site2Url, r.site1PageUrl, r.site2PageUrl]) {
      const m = /\/([a-z0-9%.'-]+?)-(?:%40|@)-([a-z0-9%.'-]+?)(?:-\d+|\/\d+)?(?:[/?#]|$)/i.exec(decodeURIComponent(String(u || '')).replace(/%40/g, '@'));
      if (!m) continue;
      const a = m[1].toLowerCase(), h = slug(r.homeTeam), w = slug(r.awayTeam);
      if (h && a.startsWith(h.slice(0, Math.min(5, h.length)))) { order.set(r.gameId, true); break; }
      if (w && a.startsWith(w.slice(0, Math.min(5, w.length)))) { order.set(r.gameId, false); break; }
    }
  }
  return (r) => (order.get(r.gameId) === false ? `${r.awayTeam} @ ${r.homeTeam}` : `${r.homeTeam} @ ${r.awayTeam}`);
}

/** The ids each book needs to bet the row, from PropProfessor's link / extra data for that book. */
export function refsOf(book, link, ad = {}, mobileLink = '') {
  if (book === 'betrivers') {
    const r = kambiRef(link);
    return r.bookRef ? r : ad.outcome_id ? { bookRef: String(ad.outcome_id) } : {};
  }
  if (book === 'hardrock') {
    const id = ad.selection_id_string || /betslip[-/](\d{10,})/.exec(decodeURIComponent(link || mobileLink || ''))?.[1];
    return id ? { bookRef: String(id), link: `https://app.hardrock.bet/?deep_link_value=betslip/${id}` } : {};
  }
  if (book === 'fanduel') {
    const sel = ad.selection_id ?? /selectionId(?:\[\d*\])?=(\d+)/.exec(decodeURIComponent(link || ''))?.[1];
    const mk = ad.market_id ?? /marketId(?:\[\d*\])?=([\d.]+)/.exec(decodeURIComponent(link || ''))?.[1];
    return sel ? { bookRef: String(sel), marketRef: mk ? String(mk) : undefined } : {};
  }
  if (book === 'betmgm') return betmgmRefs(link);
  if (book === 'draftkings') return draftkingsRef(link);
  // PropProfessor writes theScore's selection as "MarketSelection:<uuid>"; Gambit's links have the bare uuid.
  if (book === 'thescore') { const l = String(link || '').replace(/MarketSelection:/g, ''); return { ...thescoreRef(l), link: l }; }
  return {};
}

/** Every book's price for our side (odds) and the other side (oppOdds), by Gambit id. 0 = not offered. */
function pricesOf(list, flip = false, absLine = null) {
  const prices = {};
  for (const s of list || []) {
    if (absLine != null && s.line != null && Number.isFinite(Number(s.line)) && Math.abs(Number(s.line)) !== Math.abs(absLine)) continue;
    const id = ppId(s.book);
    if (prices[id]) continue;
    const a = Number(flip ? s.subOdds : s.odds), b = Number(flip ? s.odds : s.subOdds);
    const la = Number(flip ? s.subLiquidity : s.liquidity), lb = Number(flip ? s.liquidity : s.subLiquidity);
    prices[id] = {
      odds: Number.isFinite(a) && a !== 0 ? a : null, oppOdds: Number.isFinite(b) && b !== 0 ? b : null,
      liq: Number.isFinite(la) ? la : null, oppLiq: Number.isFinite(lb) ? lb : null,
    };
  }
  return prices;
}

/** Counts from the last read, for the scan line. */
export const ppStats = { rows: 0, ours: 0, unknownMarket: 0, noRef: 0, noFair: 0 };

/**
 * PropProfessor +EV rows -> app rows. `fairOut` (optional Map) collects every selection's fair (any
 * book) by fairKey, for closing line value.
 */
export function ppEvToRows(list, { books = null, fairOut = null } = {}) {
  const st = { rows: 0, ours: 0, unknownMarket: 0, noRef: 0, noFair: 0 };
  const out = [];
  const nameOf = eventNames(list || []);
  for (const r of list || []) {
    st.rows++;
    const book = PP_BOOKS[r.book];
    const ours = book && (!books || books.includes(book));
    const marketKey = marketKeyOf(r.market);
    if (!marketKey) { if (ours) st.unknownMarket++; continue; }
    const sl = selectionOf(r, marketKey);
    if (!sl) { if (ours) st.unknownMarket++; continue; }
    const fairAm = Number(r.noVigOdds);
    const p = Number.isFinite(fairAm) && Math.abs(fairAm) >= 100 ? impliedProb(fairAm) : null;
    const event = nameOf(r);
    const key = fairKey({ event, marketKey, selection: sl.selection, line: sl.line });
    if (fairOut && p != null) {
      const had = fairOut.get(key), own = !!ours;
      if (!had || (own && !had.own) || (own === had.own && p < had.prob)) fairOut.set(key, { prob: p, isLive: !!r.isLive, own });
    }
    if (!ours) continue;
    st.ours++;
    if (p == null || !(p > 0 && p < 1)) { st.noFair++; continue; }
    const refs = refsOf(book, r.deepLink, r.additionalData || {}, r.mobileLink);
    if (!refs.bookRef && !refs.optionId) { st.noRef++; continue; }
    const prices = pricesOf(r.sportsbookData, false, sl.line == null ? null : Math.abs(sl.line));
    const odds = Number(r.odds);
    const nv = prices[PP_IDS.NoVigApp];
    out.push({
      id: `pp:${r.id}`, src: 'propprofessor', book, gambitBookId: PP_IDS[r.book],
      event, league: r.league, isLive: !!r.isLive, startDate: startOf(r),
      market: prettyMarket(marketKey), marketKey, selection: sl.selection, line: sl.line,
      odds, fairOdds: decimalToAmerican(1 / p), fairProb: p, devig: { PropProfessor: p },
      ev: (p * americanToDecimal(odds) - 1) * 100, ppEv: Number(r.ev),
      fairBooks: (r.sportsbookData || []).length, fairSource: 'PropProfessor',
      novigOdds: nv?.odds ?? null, novigOppOdds: nv?.oppOdds ?? null,
      isProp: r.marketType === 'player' || /^PLAYER_PROP/.test(marketKey), prices,
      priceAt: r.lastChanged ?? null, sharpKey: key,
      link: refs.link || r.deepLink || '', ...refs,
    });
  }
  Object.assign(ppStats, st);
  return out;
}

/**
 * PropProfessor arbitrage rows -> player-prop rows on arbProps.books, priced off arbProps.refBooks
 * (Gambit ids) the same way Gambit's arbitrage table is (refFair). `st` gets the counts.
 */
export function ppArbsToRows(list, a, fairOut = null, st = { events: 0, bets: 0, ours: 0, refsMissing: 0, refSpread: 0, passed: 0 }) {
  const rows = [];
  const seen = new Set();
  const nameOf = eventNames(list || []);
  const games = new Set();
  for (const r of list || []) {
    const marketKey = marketKeyOf(r.market);
    if (!marketKey || !/^PLAYER_PROP/.test(marketKey)) continue;
    if (!games.has(r.gameId)) { games.add(r.gameId); st.events++; }
    for (const n of [1, 2]) {
      st.bets++;
      const ppBook = r[`site${n}`];
      const book = PP_BOOKS[ppBook];
      const ours = book && a.books.includes(book);
      const leg = { ...r, selection: r[`site${n}Selection`], participant: r.participant, line: lineOfSel(r[`site${n}Selection`]) };
      const sl = selectionOf(leg, marketKey);
      if (!sl) continue;
      // sportsbookData is written from site 1's side: flip it for site 2's leg.
      const prices = pricesOf(r.sportsbookData, n === 2, sl.line);
      const ownId = PP_IDS[ppBook] ?? null;
      const rf = refFair(a, prices, ours ? ownId : null);
      const event = nameOf(r);
      const key = fairKey({ event, marketKey, selection: sl.selection, line: sl.line });
      if (fairOut && rf.ok) { const had = fairOut.get(key); if (!had || rf.prob < had.prob) fairOut.set(key, { prob: rf.prob, isLive: !!r.isLive }); }
      if (!ours) continue;
      st.ours++;
      if (!rf.ok) { st[rf.why]++; continue; }
      const refs = refsOf(book, r[`site${n}DeepLink`], r[`site${n}AdditionalData`] || {}, r[`site${n}MobileLink`]);
      if (!refs.bookRef && !refs.optionId) continue;
      const id = `arb:pp:${r[`site${n}SelectionId`]}:${r.gameId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      st.passed++;
      const odds = Number(r[`site${n}Odds`]);
      const nv = prices[PP_IDS.NoVigApp];
      rows.push({
        id, src: 'propprofessor', book, gambitBookId: ownId, event, league: r.league, isLive: !!r.isLive, startDate: startOf(r),
        market: prettyMarket(marketKey), marketKey, selection: sl.selection, line: sl.line,
        novigOdds: nv?.odds ?? null, novigOppOdds: nv?.oppOdds ?? null, priceAt: r.lastChanged ?? null,
        link: refs.link || r[`site${n}DeepLink`] || '', ...refs, odds, prices,
        fairProb: rf.prob, fairOdds: decimalToAmerican(1 / rf.prob), ev: (rf.prob * americanToDecimal(odds) - 1) * 100,
        devig: Object.fromEntries(Object.entries(rf.probs)), fairBooks: rf.books.length, fairSource: `arb table: ${rf.books.join('/')}`,
        refSpread: rf.spread, refProbs: rf.probs, minEv: a.minEvPct, arb: true, isProp: true,
        refUsed: rf.books, refMode: a.fair, refIds: a.refBooks, sharpKey: key,
      });
    }
  }
  return rows;
}
const lineOfSel = (s) => { const m = /([+-]?\d+(?:\.\d+)?)\s*$/.exec(String(s || '')); return m ? Math.abs(Number(m[1])) : null; };

/**
 * The tables to read: +EV pre-game and live, and the arbitrage table's (only when arbProps is on for
 * a book we bet). "propprofessor": {"live": false} / {"pregame": false} leave one out.
 */
export function ppWants(cfg, arb) {
  const p = cfg.propprofessor || {};
  const w = [];
  if (p.pregame !== false) w.push({ page: 'ev', live: false });
  if (p.live !== false) w.push({ page: 'ev', live: true });
  if (arb) {
    if (p.pregame !== false && p.arbPregame !== false) w.push({ page: 'arb', live: false });
    if (p.live !== false && p.arbLive !== false) w.push({ page: 'arb', live: true });
  }
  return w;
}

export function makePropProfessorSource(cfg, bridge, { root = null, log = null } = {}) {
  const p = cfg.propprofessor || {};
  const ourBooks = (cfg.books || []).filter((b) => Object.values(PP_BOOKS).includes(b));
  const arb = arbDefaults(cfg);
  const arbBooks = arb ? arb.books.filter((b) => (cfg.books || []).includes(b)) : [];
  const wants = ppWants(cfg, arb && arbBooks.length ? arb : null);
  // A table the page hasn't refreshed for this long is treated as missing (the tab froze or lost its feed).
  const maxAge = { live: (Number(p.liveMaxAgeSec) || 30) * 1000, pre: (Number(p.pregameMaxAgeSec) || 180) * 1000 };
  const ppNames = Object.entries(PP_BOOKS).filter(([, b]) => ourBooks.includes(b) || arbBooks.includes(b)).map(([n]) => n);
  const sampled = new Set();
  const arbState = { error: null, rows: 0 };
  let fair = new Map(), arbFair = new Map();
  let warnAt = {};
  const warn = (k, msg) => { if (Date.now() - (warnAt[k] || 0) > 60e3) { warnAt[k] = Date.now(); log?.warn(msg); } };
  return {
    name: 'propprofessor', label: 'PropProfessor',
    needsBridge: true,
    fairIndex: () => fair,
    arbFairIndex: () => arbFair,
    arb: arb && arbBooks.length ? { cfg: arb, books: arbBooks, state: arbState } : null,
    async fetchRows() {
      if (!bridge?.connected()) throw new Error('Chrome extension not connected (needed to read PropProfessor)');
      const timeoutMs = Number(p.timeoutSec || 15) * 1000;
      const res = await bridge.send('propprofessor', { kind: 'ppRead', wants, books: ppNames, timeoutMs,
        openTabs: p.openTabs !== false }, timeoutMs + 5000);
      if (res.error) throw new Error(`PropProfessor: ${res.error}`);
      if (res.loggedOut) throw new Error(`PropProfessor: log in again in the PropProfessor tab (${res.loggedOut})`);
      for (const n of res.notes || []) log?.info(`PropProfessor: ${n}`);
      const now = Date.now();
      const nextFair = new Map(), nextArbFair = new Map();
      const out = [];
      const ast = { events: 0, bets: 0, ours: 0, refsMissing: 0, refSpread: 0, passed: 0 };
      let evTables = 0;
      for (const w of wants) {
        const t = (res.tables || []).find((x) => x.page === w.page && !!x.live === w.live);
        const what = `${w.page === 'ev' ? 'Positive EV' : 'Arbitrage'} ${w.live ? 'live' : 'pre-game'} table`;
        if (!t) { warn(`miss:${w.page}${w.live}`, `PropProfessor: no tab showing the ${what} yet${res.opening ? ' (opening one)' : ''}`); continue; }
        if (t.error) { warn(`err:${w.page}${w.live}`, `PropProfessor ${what}: ${t.error}`); continue; }
        const age = now - Number(t.updatedAt || 0);
        if (age > (w.live ? maxAge.live : maxAge.pre)) { warn(`old:${w.page}${w.live}`, `PropProfessor ${what} hasn't updated for ${Math.round(age / 1000)}s: not used until it does (the tab may be frozen)`); continue; }
        if (root && !sampled.has(`${w.page}${w.live}`) && (t.rows || []).length) {
          sampled.add(`${w.page}${w.live}`);
          try { fs.writeFileSync(path.join(root, `propprofessor-sample-${w.page}-${w.live ? 'live' : 'pregame'}.json`), JSON.stringify(t.rows.slice(0, 200), null, 1)); } catch {}
        }
        if (w.page === 'ev') { evTables++; out.push(...ppEvToRows(t.rows, { books: ourBooks, fairOut: nextFair })); }
        else out.push(...ppArbsToRows(t.rows, { ...arb, books: arbBooks }, nextArbFair, ast));
      }
      if (!evTables && wants.some((w) => w.page === 'ev')) throw new Error('PropProfessor: no up-to-date Positive EV table in any open tab');
      fair = nextFair;
      arbFair = nextArbFair;
      if (this.arb) { Object.assign(arbStats, ast); arbState.rows = out.filter((r) => r.arb).length; arbState.error = null; }
      return out;
    },
  };
}
