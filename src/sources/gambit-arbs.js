// Player props from Gambit's arbitrage table (/api/arbs.json), Austin's rules (2026-11-21):
//  - only player props, only on the books in arbProps.books (Hard Rock, BetRivers)
//  - fair price from the reference books DraftKings, FanDuel and Caesars (arbProps.refBooks), each
//    de-vigged from its own two sides; at least 2 of them (arbProps.minRefs) must agree within
//    3 percentage points (arbProps.maxSpreadPts); the agreeing ones set the fair price
//  - 8% EV minimum at the book's price (arbProps.minEvPct)
// Everything else (odds window, EV cap, live rules, groups, per-player stat cap, the price
// re-check before placing, the daily limit) is the same as for the +EV table's rows.
//
// arbs.json's rows weren't seen yet (the one capture had none: {"odds":[],...}). Its events
// have the same fields as evs.json's (evs.json events carry an empty "arbitrageOpportunities"),
// so this reads it loosely: any bet object (sportsbook_id + odds) under an event, with the same
// side's and other side's prices from the bet's comparableBets/opposingBets and from the other
// bets in the same opportunity. The first non-empty response is saved to arbs-sample.json.
import { americanToDecimal, decimalToAmerican } from '../ev.js';
import { fairKey } from '../betlog.js';
import { bookFairProb } from '../filters.js';
import { bookIdLists, detectBookIds, rowParts } from './gambit-evs.js';

export const DEFAULT_REF_BOOKS = { draftkings: 200, fanduel: 100, caesars: 300 };

/** Defaults for "arbProps" in config.json. "arbProps": false turns the arbitrage table off. */
export function arbDefaults(cfg) {
  if (cfg.arbProps === false) return null;
  const a = { enabled: true, books: ['hardrock', 'betrivers'], minRefs: 2, maxSpreadPts: 3, minEvPct: 8,
    fair: 'lowest', minArbPercentage: -5, ...(cfg.arbProps || {}) };
  a.refBooks = { ...DEFAULT_REF_BOOKS, ...(cfg.arbProps?.refBooks || {}) };
  if (!a.enabled) return null;
  // Default links: the +EV table's links with evs.json -> arbs.json (same leagues, live + pre-game).
  if (!a.urls) {
    a.urls = [].concat(cfg.gambit?.urls || cfg.gambit?.url || []).filter((u) => /\/evs\.json/.test(u))
      .map((u) => withParam(u.replace('/evs.json', '/arbs.json'), 'minArbPercentage', a.minArbPercentage));
  }
  cfg.arbProps = a;
  return a;
}

function withParam(url, k, v) {
  if (v == null) return url;
  const re = new RegExp(`([?&]${k}=)[^&]*`);
  return re.test(url) ? url.replace(re, `$1${v}`) : `${url}${url.includes('?') ? '&' : '?'}${k}=${v}`;
}

const isBet = (o) => o && typeof o === 'object' && !Array.isArray(o) && o.sportsbook_id != null && o.odds != null && Number.isFinite(Number(o.odds));
const sideOf = (b) => String(b.selection_line || b.selection || '').toLowerCase();
const lineOf = (b) => { const v = Number(b.points ?? b.selection_points); return Number.isFinite(v) ? v : null; };

/** Event objects in the response: anything with an event_name, wherever it sits. */
function events(json) {
  const out = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    if (o.event_name) { out.push(o); return; }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(json, 0);
  return out;
}

/** Opportunities in an event: arbitrageOpportunities entries (or evOpportunities), each with its bets. */
function opportunities(ev) {
  const list = [].concat(ev.arbitrageOpportunities || [], ev.arbOpportunities || [], ev.arbs || []);
  const out = [];
  for (const op of list) {
    if (!op || typeof op !== 'object') continue;
    // Top-level bets of the opportunity (its two legs), not their comparable/opposing lists.
    const legs = [];
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 3) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      if (isBet(o)) { legs.push(o); return; }
      for (const [k, v] of Object.entries(o)) if (!/^(comparableBets|opposingBets|devig)$/.test(k)) walk(v, depth + 1);
    };
    walk(op, 0);
    if (legs.length) out.push({ marketName: op.marketName || legs[0].marketName || op.market || '', legs, raw: op });
  }
  return out;
}

/**
 * Fair win probability from the reference books for one selection. prices: Gambit id -> {odds, oppOdds}.
 * The biggest set of reference books all within maxSpreadPts of each other wins; it needs minRefs books.
 */
export function refFair(a, prices) {
  const probs = {};
  for (const [n, idv] of Object.entries(a.refBooks)) {
    for (const id of [].concat(idv)) {
      const pr = prices[id];
      const p = pr && bookFairProb(pr.odds, pr.oppOdds);
      if (p != null) { probs[n] = p; break; }
    }
  }
  const names = Object.keys(probs);
  if (names.length < a.minRefs) return { ok: false, why: 'refsMissing', probs };
  // Largest agreeing set (3 books -> try all 3, then each pair), ties -> lowest fair (more careful).
  let best = null;
  const sets = [];
  for (let m = 1; m < 1 << names.length; m++) sets.push(names.filter((_, i) => m & (1 << i)));
  for (const s of sets) {
    if (s.length < a.minRefs) continue;
    const v = s.map((n) => probs[n]);
    const spread = (Math.max(...v) - Math.min(...v)) * 100;
    if (a.maxSpreadPts != null && spread > a.maxSpreadPts) continue;
    const prob = a.fair === 'average' ? v.reduce((x, y) => x + y, 0) / v.length : Math.min(...v);
    if (!best || s.length > best.books.length || (s.length === best.books.length && prob < best.prob)) best = { books: s, prob, spread };
  }
  if (!best) {
    const v = Object.values(probs);
    return { ok: false, why: 'refSpread', probs, spread: (Math.max(...v) - Math.min(...v)) * 100 };
  }
  return { ok: true, ...best, probs };
}

/** Counts from the last parse, for the scan line and the props funnel. */
export const arbStats = { events: 0, bets: 0, ours: 0, refsMissing: 0, refSpread: 0, passed: 0 };

/**
 * `fairOut` (optional Map) collects the DK/FD/Caesars fair price of every prop in the table, from any
 * book, keyed by fairKey, for closing line value on bets placed from this table (betlog.js track).
 */
export function arbsToRows(json, g, a, fairOut = null) {
  detectBookIds(json);
  const nameById = {};
  const idLists = bookIdLists(g);
  for (const [n, list] of Object.entries(idLists)) if (a.books.includes(n)) for (const id of list) nameById[id] = n;
  const st = { events: 0, bets: 0, ours: 0, refsMissing: 0, refSpread: 0, passed: 0 };
  const rows = [];
  const seen = new Set();
  for (const ev of events(json)) {
    st.events++;
    for (const op of opportunities(ev)) {
      const marketName = op.marketName;
      if (!/PLAYER_PROP/i.test(marketName)) continue;
      // Every leg, plus each leg's comparable/opposing books, gives a price for one side.
      // Sides are told apart by the leg's selection ("over"/"under") and line.
      const all = [];
      for (const leg of op.legs) {
        st.bets++;
        all.push({ b: leg, side: sideOf(leg), line: lineOf(leg), player: leg.player_name });
        for (const c of leg.comparableBets || []) if (isBet(c)) all.push({ b: c, side: sideOf(leg), line: lineOf(leg), player: leg.player_name });
        for (const c of leg.opposingBets || []) if (isBet(c)) all.push({ b: c, side: `!${sideOf(leg)}`, line: lineOf(leg), player: leg.player_name });
      }
      for (const leg of op.legs) {
        const book = nameById[leg.sportsbook_id];
        if (!book && !fairOut) continue;
        if (book) st.ours++;
        const mySide = sideOf(leg), myLine = lineOf(leg);
        const same = (x) => x.player === leg.player_name && (x.line == null || myLine == null || x.line === myLine);
        const prices = {};
        for (const x of all) {
          if (!same(x)) continue;
          const isMine = x.side === mySide || (x.side.startsWith('!') && x.side.slice(1) !== mySide);
          const k = isMine ? 'odds' : 'oppOdds';
          if ((prices[x.b.sportsbook_id] ||= {})[k] == null) prices[x.b.sportsbook_id][k] = Number(x.b.odds);
        }
        const rf = refFair(a, prices);
        const parts = rowParts(ev, { marketName }, leg, book);
        if (fairOut && rf.ok) {
          const k = fairKey({ event: ev.event_name, marketKey: marketName, selection: parts.selection, line: parts.line });
          const had = fairOut.get(k);
          if (!had || rf.prob < had.prob) fairOut.set(k, { prob: rf.prob, isLive: !!ev.isLive });
        }
        if (!book) continue;
        if (!rf.ok) { st[rf.why]++; continue; }
        const id = `arb:${leg.id ?? `${book}:${parts.bookRef}`}`;
        if (seen.has(id)) continue;
        seen.add(id);
        st.passed++;
        const odds = Number(leg.odds);
        rows.push({
          ...parts, id, book, gambitBookId: leg.sportsbook_id, odds, prices,
          fairProb: rf.prob, fairOdds: decimalToAmerican(1 / rf.prob), ev: (rf.prob * americanToDecimal(odds) - 1) * 100,
          devig: Object.fromEntries(Object.entries(rf.probs).map(([n, p]) => [n, p])),
          fairBooks: rf.books.length, fairSource: `arb table: ${rf.books.join('/')}`,
          refSpread: rf.spread, refProbs: rf.probs, minEv: a.minEvPct, arb: true, isProp: true,
          sharpKey: fairKey({ event: ev.event_name, marketKey: marketName, selection: parts.selection, line: parts.line }),
        });
      }
    }
  }
  Object.assign(arbStats, st);
  return rows;
}
