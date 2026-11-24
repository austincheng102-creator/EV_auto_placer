// Austin's placement rules on top of the EV and Novig checks:
//  - odds window: nothing shorter than -300 (minOdds) or longer than +250 (maxOdds)
//  - EV cap: nothing above 25% EV (maxEvPct), it's usually a stale or wrong price
//  - sharp books must agree: their no-vig win probabilities within 3 points of each other
//    (Pinnacle, plus liquid Kalshi/Polymarket; FanDuel left out since 2026-11-19, sharp.spreadBooks)
//  - Prediction markets (Kalshi, Polymarket, Novig, ProphetX) are sharp books (2026-11-23, sharp.predictionMarkets), but a
//    price only counts when its two sides add up to 103% or less and the thinner side has $500+ (Gambit's
//    liquidity). Its fair is the lower of the mid and the size-weighted mid. If Kalshi and Polymarket both count,
//    they must be within 2 points or neither counts. Ones that don't count are ignored everywhere: sharp rules,
//    live timing, and fair odds / EV. Ones that count lower the fair price when they're less optimistic than Pinnacle.
//  - live mainlines need Pinnacle or a liquid Kalshi/Polymarket listed; props (live and pre-game) need FanDuel
//  - soft-book check (softCheck): our price must be above 0% EV against the no-vig price of at least
//    2 of DraftKings, Caesars and FanDuel (the book we're betting doesn't count for itself)
//  - Pinnacle vs the market (marketCheck, 2026-11-23): skip when Pinnacle's no-vig win % for our side is more
//    than 3 points above the median no-vig of the soft books on the row (DraftKings, FanDuel, Caesars, BetMGM,
//    theScore, Hard Rock, ...; not the book we're betting). Needs 3+ soft books priced, otherwise it passes.
//  - odds bands (minEvByOdds): +201 to +250 needs 12% EV, everything else minEvPct
//  - longOddsProps: BetRivers player props above +250 are allowed at 15% EV or more
//  - live timing: a sharp price for the selection changed within the last 5 seconds (30 for props)
//  - groups: same game + market (period is part of the market) share group.maxBets bets and group.maxStake $.
//    Both sides count as one group (Over and Under, either team's spread), unless group.bothSides is true.
//    Player props: per player, so Over/Under on one player's stat are one group.
//    group.perBook (default on): each book gets its own maxBets/maxStake in the group, so the same side
//    can go on BetRivers and Hard Rock once each. The other side waits out the cooldown (group.otherSide).
//    group.pregameMaxBets (default 1): pre-game bets get this many per group (per book) instead of maxBets.
//    group.cooldownSec (default 60): a repeat bet in the same group (same book with perBook) waits this
//    long after the last one, and must still pass every rule. Different markets in one game don't wait.
import { impliedProb } from './ev.js';

// Gambit sportsbook ids. PS3838 is Pinnacle's feed. Polymarket has two listings.
export const DEFAULT_SHARP_IDS = { pinnacle: 1014, kalshi: 194, polymarket: [193, 1011], novig: 192, prophetx: 191, fanduel: 100 };

// Soft books the marketCheck median is taken over (Gambit ids). Prediction markets and exchanges
// (Kalshi, Polymarket, Novig, ProphetX) aren't soft books and aren't in it.
export const DEFAULT_MARKET_BOOKS = {
  draftkings: 200, fanduel: 100, caesars: 300, betmgm: [400, 1001], thescore: 700, hardrock: [851, 850, 1008, 1016],
  betrivers: 1004, kambi: 500, betparx: 1005, fliff: 800, bet365: 365, bovada: 1006, betonline: 613,
};

/** Fills in defaults for the new settings, so configs from older versions get Austin's rules. */
export function applyFilterDefaults(cfg) {
  if (cfg.minOdds === undefined) cfg.minOdds = -300;
  if (cfg.maxEvPct === undefined) cfg.maxEvPct = 25;
  const s = (cfg.sharp ||= {});
  s.ids = { ...DEFAULT_SHARP_IDS, ...(s.ids || {}) };
  if (s.liveMainlineNeeds === undefined) s.liveMainlineNeeds = ['pinnacle', 'polymarket', 'novig'];
  if (s.livePropNeeds === undefined) s.livePropNeeds = ['fanduel'];
  // Pre-game player props need FanDuel listed too (Austin, 2026-11-22). [] = no requirement.
  if (s.pregamePropNeeds === undefined) s.pregamePropNeeds = ['fanduel'];
  if (s.maxSpreadPts === undefined) s.maxSpreadPts = 3;
  // Books compared by the 3-point rule. FanDuel isn't in it: it isn't sharp on props and kept
  // knocking them out. Add "fanduel" here to compare it again on props.
  if (s.spreadBooks === undefined) s.spreadBooks = ['pinnacle', 'polymarket', 'novig'];
  // Books never used as sharp, even if a list above names them (Austin, 2026-11-22: no Kalshi; 2026-11-23:
  // Kalshi back via predictionMarkets below).
  if (s.excludeBooks === undefined) s.excludeBooks = [];
  // Prediction markets (Austin, 2026-11-23): Kalshi, Polymarket, Novig and ProphetX count as sharp books for mainlines.
  // A price is valid when its two sides' implied % add up to 100 + maxHoldPct (3) or less, i.e. a 3 cent
  // spread, and the thinner side has at least minLiquidity $ (500). Its fair for our side is the lower of
  // the mid and the size-weighted mid (not the 4 no-vig methods). agreeBooks (Kalshi, Polymarket): when both
  // are valid they must be within agreePts (2) points of each other, or neither counts. Not valid = ignored
  // by every sharp rule and by the fair price. inFair: valid ones also go into the fair price (lowest wins).
  // They're added to spreadBooks and liveMainlineNeeds and taken off excludeBooks, so older configs
  // that still say "excludeBooks": ["kalshi"] or list only Pinnacle get them too. enabled: false = off.
  const pm = (s.predictionMarkets ||= {});
  if (pm.enabled === undefined) pm.enabled = true;
  if (pm.books === undefined) pm.books = ['kalshi', 'polymarket', 'novig', 'prophetx'];
  if (pm.minLiquidity === undefined) pm.minLiquidity = 500;
  if (pm.maxHoldPct === undefined) pm.maxHoldPct = 3;
  if (pm.agreeBooks === undefined) pm.agreeBooks = ['kalshi', 'polymarket'];
  if (pm.agreePts === undefined) pm.agreePts = 2;
  if (pm.inFair === undefined) pm.inFair = true;
  if (pm.enabled) {
    s.excludeBooks = (s.excludeBooks || []).filter((n) => !pm.books.includes(n));
    for (const k of ['spreadBooks', 'liveMainlineNeeds']) if (Array.isArray(s[k])) s[k] = [...new Set([...s[k], ...pm.books])];
  }
  const out = new Set(s.excludeBooks || []);
  for (const k of ['liveMainlineNeeds', 'livePropNeeds', 'pregamePropNeeds', 'spreadBooks']) if (Array.isArray(s[k])) s[k] = s[k].filter((n) => !out.has(n));
  if (s.liveMaxAgeSec === undefined) s.liveMaxAgeSec = 5;
  // Live props: FanDuel's prop prices update slowly in Gambit's feed, so props get 30s.
  if (s.livePropMaxAgeSec === undefined) s.livePropMaxAgeSec = 30;
  const g = (cfg.group ||= {});
  if (g.maxBets === undefined) g.maxBets = 3;
  if (g.maxStake === undefined) g.maxStake = 3;
  // Pre-game bets: at most this many per group (per book with perBook). Live keeps maxBets.
  // A pre-game bet still counts once the game goes live, so live can add up to maxBets in all. null = use maxBets.
  if (g.pregameMaxBets === undefined) g.pregameMaxBets = 1;
  if (g.bothSides === undefined) g.bothSides = false;
  if (g.perBook === undefined) g.perBook = true;
  if (g.cooldownSec === undefined) g.cooldownSec = 60;
  // The opposite side (Under after an Over, the other team): "afterCooldown" (default) lets it go once the
  // group's last bet, on any book, is cooldownSec old and it passes every rule; "block" = never that game.
  if (g.otherSide === undefined) g.otherSide = 'afterCooldown';
  bothSides = !!g.bothSides;
  // Soft-book check: EV above minEvPct (0) against the no-vig price of at least minBooks (2) of these
  // books. A book that doesn't list both sides doesn't count; fewer than minBooks priced = skip.
  // skipOwnBook: the book we're betting isn't checked against itself (its own vig always makes that negative).
  const sc = (cfg.softCheck ||= {});
  if (sc.enabled === undefined) sc.enabled = true;
  if (sc.books === undefined) sc.books = { draftkings: 200, caesars: 300, fanduel: 100 };
  if (sc.minBooks === undefined) sc.minBooks = 2;
  if (sc.minEvPct === undefined) sc.minEvPct = 0;
  if (sc.skipOwnBook === undefined) sc.skipOwnBook = true;
  // Pinnacle vs the market: Pinnacle's no-vig % for our side may be at most maxPts above the median
  // no-vig % of these soft books (each needs both sides; one price per book, first listed id wins).
  // The book we're betting is left out, plus ownAlso (BetRivers runs on Kambi's odds). Fewer than
  // minBooks priced = nothing to compare, passes. arb: false = Arb-table rows (no Pinnacle fair) skip it.
  const mc = (cfg.marketCheck ||= {});
  if (mc.enabled === undefined) mc.enabled = true;
  if (mc.maxPts === undefined) mc.maxPts = 3;
  if (mc.minBooks === undefined) mc.minBooks = 3;
  if (mc.sharp === undefined) mc.sharp = 'pinnacle';
  if (mc.books === undefined) mc.books = DEFAULT_MARKET_BOOKS;
  if (mc.ownAlso === undefined) mc.ownAlso = { betrivers: ['kambi'] };
  if (mc.arb === undefined) mc.arb = false;
  // Higher minimum EV for long odds: first band whose odds range holds the price wins (if above minEvPct).
  if (cfg.minEvByOdds === undefined) cfg.minEvByOdds = [{ from: 201, to: 250, minEvPct: 12 }];
  // Player props above maxOdds (+250) on these books: allowed, but only at this EV or more
  // (Austin 2026-11-24: BetRivers props over +250 need 15% EV). maxOdds here = optional upper
  // limit (null = none). Everything else keeps the maxOdds cap. {} turns it off.
  if (cfg.longOddsProps === undefined) cfg.longOddsProps = { betrivers: { minEvPct: 15, maxOdds: null } };
  return cfg;
}

/** The longOddsProps rule that lets this prop past the maxOdds cap at these odds, or null. */
export function longPropRule(cfg, row, odds = row?.odds) {
  if (!row || cfg.maxOdds == null || !Number.isFinite(odds) || odds <= cfg.maxOdds) return null;
  const r = cfg.longOddsProps?.[row.book];
  if (!r || !Number.isFinite(Number(r.minEvPct)) || !isPropBet(row)) return null;
  if (r.maxOdds != null && odds > Number(r.maxOdds)) return null;
  return r;
}

/** Minimum EV for a price: the base minimum, raised by a matching minEvByOdds band. */
export function minEvFor(cfg, base, odds, row) {
  let m = base;
  const lp = longPropRule(cfg, row, odds);
  if (lp) m = Math.max(m, Number(lp.minEvPct));
  for (const b of cfg.minEvByOdds || []) {
    if (Number.isFinite(odds) && odds >= (b.from ?? -Infinity) && odds <= (b.to ?? Infinity)) m = Math.max(m, Number(b.minEvPct) || 0);
  }
  return m;
}

/**
 * Soft-book check at a price. Returns { ok, evs: {draftkings: 3.1, ...}, pass, n, need, mine }.
 * evs = our EV % against each book's own no-vig price (books with both sides only).
 */
export function softCheck(cfg, row, odds = row.odds) {
  const sc = cfg.softCheck;
  if (!sc?.enabled) return { ok: true, off: true, evs: {}, pass: 0, n: 0 };
  const evs = {};
  let mine = null;
  for (const [name, idv] of Object.entries(sc.books || {})) {
    const idList = [].concat(idv ?? []).map(Number);
    if (sc.skipOwnBook && (name === row.book || idList.includes(Number(row.gambitBookId)))) { mine = name; continue; }
    for (const id of idList) {
      const pr = row.prices?.[id];
      const p = pr && bookFairProb(pr.odds, pr.oppOdds);
      if (p != null) { evs[name] = (p * (odds > 0 ? 1 + odds / 100 : 1 + 100 / -odds) - 1) * 100; break; }
    }
  }
  const vals = Object.values(evs), need = sc.minBooks ?? 2;
  const pass = vals.filter((e) => e > (sc.minEvPct ?? 0)).length;
  return { ok: pass >= need, evs, pass, n: vals.length, need, mine };
}

/**
 * Pinnacle vs the market. Returns { ok, sharp, median, gap, probs: {draftkings: 0.48, ...}, n, need }.
 * sharp/median are win probabilities (0..1) for our side; gap = (sharp - median) in points.
 * ok when off, when Pinnacle lacks both sides, when fewer than minBooks soft books are priced,
 * or when gap <= maxPts. Pinnacle below the market never fails it.
 */
export function marketCheck(cfg, row) {
  const mc = cfg.marketCheck;
  if (!mc?.enabled || (row.arb && !mc.arb)) return { ok: true, off: true, probs: {}, n: 0 };
  let sharp = null;
  for (const id of [].concat(cfg.sharp?.ids?.[mc.sharp] ?? []).map(Number)) {
    const pr = sharpPrice(cfg, row, id);
    sharp = pr ? bookFairProb(pr.odds, pr.oppOdds) : null;
    if (sharp != null) break;
  }
  const own = new Set([row.book, ...((mc.ownAlso || {})[row.book] || [])]);
  const probs = {};
  for (const [name, idv] of Object.entries(mc.books || {})) {
    const idList = [].concat(idv ?? []).map(Number);
    if (own.has(name) || idList.includes(Number(row.gambitBookId))) continue;
    for (const id of idList) {
      const pr = row.prices?.[id];
      const p = pr && bookFairProb(pr.odds, pr.oppOdds);
      if (p != null) { probs[name] = p; break; }
    }
  }
  const vals = Object.values(probs).sort((a, b) => a - b), need = mc.minBooks ?? 3;
  const median = vals.length ? (vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2) : null;
  if (sharp == null || vals.length < need) return { ok: true, sharp, median, gap: null, probs, n: vals.length, need };
  const gap = (sharp - median) * 100;
  return { ok: mc.maxPts == null || gap <= mc.maxPts, sharp, median, gap, probs, n: vals.length, need };
}

/** "Pinnacle 53.0% vs soft-book median 48.5% (+4.5 pts, 8 books)" for logs. */
export const fmtMarket = (mc) => (mc.gap == null ? `not compared (${mc.sharp == null ? 'no two-sided Pinnacle price' : `${mc.n} soft books priced, need ${mc.need}`})`
  : `Pinnacle ${(mc.sharp * 100).toFixed(1)}% vs soft-book median ${(mc.median * 100).toFixed(1)}% (${mc.gap >= 0 ? '+' : ''}${mc.gap.toFixed(1)} pts, ${mc.n} books)`);

/** "DraftKings +3.1%, Caesars -0.4%" for logs. */
export const fmtSoft = (sc) => Object.entries(sc.evs).map(([n, e]) => `${n} ${e >= 0 ? '+' : ''}${e.toFixed(1)}%`).join(', ') || 'none priced';

/** -300 is allowed, -310 is not. Positive odds are never "shorter than" a negative limit. */
export const tooShort = (cfg, odds) => cfg.minOdds != null && odds < 0 && odds < cfg.minOdds;
export const evTooHigh = (cfg, ev) => cfg.maxEvPct != null && ev > cfg.maxEvPct;

const ids = (cfg, name) => [].concat(cfg.sharp.ids[name] ?? []).map(Number);

/** Gambit ids of the prediction markets (Kalshi, Polymarket) when that setting is on. */
const pmIds = (cfg) => {
  const pm = cfg.sharp?.predictionMarkets;
  return new Set(pm?.enabled ? pm.books.flatMap((n) => ids(cfg, n)) : []);
};

/**
 * One prediction-market price checked against Austin's rules. p = our side's implied, q = the other side's.
 * Returns { ok, why, prob }: prob = lower of mid (p + 1 - q) / 2 and the size-weighted mid
 * ((1 - q) * ourLiq + p * oppLiq) / (ourLiq + oppLiq).
 */
export function pmPrice(pm, pr) {
  if (!pr || pr.odds == null || pr.oppOdds == null) return { ok: false, why: 'one side missing' };
  const p = impliedProb(pr.odds), q = impliedProb(pr.oppOdds);
  if (p + q > 1 + (pm.maxHoldPct ?? 3) / 100 + 1e-9) return { ok: false, why: `spread ${((p + q - 1) * 100).toFixed(1)}c` };
  if (p + q < 0.97) return { ok: false, why: 'sides cross (stale)' };
  const a = Number(pr.liq), b = Number(pr.oppLiq);
  if (!(Math.min(a, b) >= (pm.minLiquidity ?? 0))) return { ok: false, why: `thinner side $${Number.isFinite(Math.min(a, b)) ? Math.round(Math.min(a, b)) : '?'}` };
  const mid = (p + 1 - q) / 2;
  const sw = a + b > 0 ? ((1 - q) * a + p * b) / (a + b) : mid;
  return { ok: true, prob: Math.min(mid, sw), mid, sw };
}

const pmCache = new WeakMap();
/**
 * Prediction markets on a row: { probs: {kalshi: 0.51}, used: {kalshi: 194}, bad: [{name, id, why}] }.
 * Each book's first valid id counts (Polymarket has two). Then the agreement rule: if every agreeBooks
 * book is valid and they're more than agreePts apart, none of them counts.
 */
export function pmState(cfg, row) {
  const pm = cfg.sharp?.predictionMarkets;
  const out = { probs: {}, used: {}, bad: [] };
  if (!pm?.enabled || !row.prices) return out;
  const hit = pmCache.get(row);
  if (hit && hit.prices === row.prices) return hit.out;
  for (const n of pm.books) for (const id of ids(cfg, n)) {
    const pr = row.prices[id];
    if (!pr || pr.odds == null) continue;
    const c = pmPrice(pm, pr);
    if (!c.ok) { out.bad.push({ name: n, id, why: c.why }); continue; }
    if (out.probs[n] == null) { out.probs[n] = c.prob; out.used[n] = id; }
  }
  const ag = (pm.agreeBooks || []).filter((n) => out.probs[n] != null);
  if (ag.length >= 2 && ag.length === (pm.agreeBooks || []).length) {
    const v = ag.map((n) => out.probs[n]), gap = (Math.max(...v) - Math.min(...v)) * 100;
    if (pm.agreePts != null && gap > pm.agreePts) {
      for (const n of ag) { out.bad.push({ name: n, id: out.used[n], why: `${ag.join('/')} ${gap.toFixed(1)} pts apart` }); delete out.probs[n]; delete out.used[n]; }
    }
  }
  pmCache.set(row, { prices: row.prices, out });
  return out;
}

/**
 * A book's price for a row as the sharp rules may use it: a prediction-market price that isn't the
 * one pmState counts for that book is treated as not there.
 */
export function sharpPrice(cfg, row, id) {
  const pr = row.prices?.[id];
  if (!pr) return null;
  if (pmIds(cfg).has(Number(id))) {
    const used = Object.values(pmState(cfg, row).used);
    if (!used.includes(Number(id))) return null;
  }
  return pr;
}

/** Prediction-market prices on a row that don't count, with why: [{name, id, why}]. */
export const thinMarkets = (cfg, row) => pmState(cfg, row).bad;

/** No-vig win probability a sharp book gives our side: the pmState fair for prediction markets. */
function sharpProb(cfg, row, name, fallback) {
  if (cfg.sharp?.predictionMarkets?.enabled && cfg.sharp.predictionMarkets.books.includes(name)) return pmState(cfg, row).probs[name] ?? null;
  for (const id of ids(cfg, name)) {
    const pr = row.prices?.[id];
    const p = pr && fallback(pr.odds, pr.oppOdds);
    if (p != null) return p;
  }
  return null;
}

/** Sharp books whose price Gambit lists for this selection, by name (thin prediction markets don't count). */
export function sharpPresent(cfg, row, names) {
  return names.filter((n) => ids(cfg, n).some((id) => sharpPrice(cfg, row, id)?.odds != null));
}

/** Lowest no-vig win probability of one book's two sides over the multiplicative, additive and power methods. */
export function worstNoVig(odds, oppOdds) {
  if (bookFairProb(odds, oppOdds) == null) return null;
  const p = impliedProb(odds), q = impliedProb(oppOdds);
  const mult = p / (p + q), add = p - (p + q - 1) / 2;
  let lo = 0.5, hi = 5;   // power: p^k + q^k = 1
  for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2; if (p ** k + q ** k > 1) lo = k; else hi = k; }
  const pow = p ** ((lo + hi) / 2);
  return Math.min(mult, add, pow);
}

/**
 * Fair win probability from the sharp books only, for +EV-table rows (not Arb-table rows):
 * the lowest of Pinnacle and each valid prediction market (pmState; FanDuel too on props).
 * Rows whose fair came from Pinnacle (PS3838) keep Gambit's Pinnacle number and are only lowered.
 * Rows with Gambit's "market" fair are recomputed from the sharp books, since Gambit's blend can hold
 * thin prediction-market prices we can't take out; with no sharp book priced, prob is null (skip).
 * Returns { prob, books: ['pinnacle', 'kalshi'], changed } or null when the setting is off.
 */
export function sharpFair(cfg, row) {
  const pm = cfg.sharp?.predictionMarkets;
  if (!pm?.enabled || !pm.inFair || row.arb) return null;
  const names = ['pinnacle', ...pm.books, ...(row.isProp ? ['fanduel'] : [])];
  const probs = {};
  for (const n of names) {
    const p = sharpProb(cfg, row, n, worstNoVig);
    if (p != null) probs[n] = p;
  }
  const fromPinnacle = row.fairSource === 'PS3838';
  if (fromPinnacle && Number.isFinite(row.fairProb)) probs.pinnacle = row.fairProb;
  const vals = Object.values(probs);
  if (!vals.length) return { prob: fromPinnacle ? row.fairProb : null, books: [], probs, changed: !fromPinnacle };
  const prob = Math.min(...vals);
  const books = Object.keys(probs).filter((n) => probs[n] === prob);
  return { prob, books, probs, changed: !fromPinnacle || prob < row.fairProb };
}

/** No-vig win probability from one book's two sides; null if one side is missing or they don't fit one line. */
export function bookFairProb(odds, oppOdds) {
  if (odds == null || oppOdds == null) return null;
  const p = impliedProb(odds), q = impliedProb(oppOdds);
  if (p + q < 0.97 || p + q > 1.15) return null;
  return p / (p + q);
}

/** Which sharp books the 3-point rule compares for a row (sharp.spreadBooks; FanDuel only on props). */
export function sharpNames(cfg, row) {
  const list = cfg.sharp.spreadBooks || [];
  return row.isProp ? [...new Set(list)] : [...new Set(list.filter((n) => n !== 'fanduel'))];
}

/**
 * Sharp agreement: each sharp book's no-vig probability (needs both sides), spread = max - min in
 * percentage points. With fewer than 2 sharp books priced on both sides there is nothing to compare,
 * so it passes and says so.
 */
export function sharpSpread(cfg, row) {
  const probs = {};
  for (const n of sharpNames(cfg, row)) {
    const p = sharpProb(cfg, row, n, bookFairProb);
    if (p != null) probs[n] = p;
  }
  const vals = Object.values(probs);
  if (vals.length < 2) return { ok: true, n: vals.length, spread: null, probs };
  const spread = (Math.max(...vals) - Math.min(...vals)) * 100;
  return { ok: cfg.sharp.maxSpreadPts == null || spread <= cfg.sharp.maxSpreadPts, n: vals.length, spread, probs };
}

/**
 * Needed sharp books: live mainlines need Pinnacle or a liquid Kalshi/Polymarket, live props need FanDuel,
 * pre-game props need FanDuel too (sharp.pregamePropNeeds, 2026-11-22). Pre-game mainlines need none.
 */
export function liveSharpMissing(cfg, row) {
  const need = row.isLive
    ? (row.isProp ? cfg.sharp.livePropNeeds : cfg.sharp.liveMainlineNeeds)
    : (row.isProp && row.isLive === false ? cfg.sharp.pregamePropNeeds : null);
  if (!need?.length) return null;
  return sharpPresent(cfg, row, need).length ? null : need;
}

/** Live timing limit for a row in seconds: liveMaxAgeSec, or livePropMaxAgeSec for player props. null = off. */
export const liveAgeLimit = (cfg, row) => (row.isProp && cfg.sharp.livePropMaxAgeSec !== undefined
  ? cfg.sharp.livePropMaxAgeSec : cfg.sharp.liveMaxAgeSec);

/** Which books' prices the live timing rule watches for a row. */
const watched = (cfg, row) => (row.isProp ? cfg.sharp.livePropNeeds : cfg.sharp.liveMainlineNeeds);

/**
 * Remembers each selection's sharp prices between polls, to tell how recently one changed.
 * Gambit gives no time for the sharp prices, so the time comes from our own polls, counted
 * conservatively: a change seen now is dated to the previous poll where the old price was
 * still showing. A selection seen for the first time has no known age (skipped).
 */
export function makeSharpClock(cfg) {
  const seen = new Map();   // key -> { sig, changedAt, lastSeen }
  const sigOf = (row) => watched(cfg, row).flatMap((n) => ids(cfg, n))
    .map((id) => { const pr = sharpPrice(cfg, row, id); return `${id}:${pr?.odds ?? ''}/${pr?.oppOdds ?? ''}`; }).join(',');
  return {
    update(rows, now = Date.now()) {
      const done = new Set();
      for (const r of rows) {
        if (!r.isLive || !r.sharpKey || done.has(r.sharpKey)) continue;
        done.add(r.sharpKey);
        const sig = sigOf(r), prev = seen.get(r.sharpKey);
        if (!prev) seen.set(r.sharpKey, { sig, changedAt: null, lastSeen: now });
        else if (prev.sig !== sig) seen.set(r.sharpKey, { sig, changedAt: prev.lastSeen, lastSeen: now });
        else prev.lastSeen = now;
      }
      for (const [k, v] of seen) if (now - v.lastSeen > 60e3) seen.delete(k);
    },
    /** Seconds since a watched sharp price changed; null = unknown (not seen change yet). */
    ageSec(row, now = Date.now()) {
      const v = seen.get(row.sharpKey);
      return v?.changedAt == null ? null : (now - v.changedAt) / 1000;
    },
  };
}

/**
 * Group: same game and market (period is part of it, e.g. 1H Moneyline). Line and book don't matter.
 * By default both sides share the group: Over/Under on a total, either team's spread or moneyline,
 * and Over/Under on one player's prop (the player stays in the key). group.bothSides: true = per side.
 */
let bothSides = false;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9+-]/g, '');
const SIDE = /\s*\b(over|under|yes|no)$/i;
// "Over" -> "", "Trae Young Over" -> "Trae Young", a team name (spread/moneyline) -> "".
const sideless = (sel) => { const s = String(sel ?? '').trim(); return SIDE.test(s) ? s.replace(SIDE, '') : ''; };
export const groupKey = (r) => `${norm(r.event)}|${norm(r.market)}|${norm(bothSides ? r.selection : sideless(r.selection))}`;

/**
 * A player prop bet (row, or a state.placed entry). Entries saved before isProp was stored:
 * a player name before Over/Under, in a market that isn't a game/team total, spread or moneyline.
 */
export const isPropBet = (p) => p.isProp ?? (sideless(p.selection) !== '' && !/total|spread|moneyline/i.test(p.market || ''));

/** Game + player of a prop bet, for maxPropStatsPerPlayer ("Trae Young Over" -> "...|traeyoung"). */
export const playerKey = (p) => `${norm(p.event)}|${norm(sideless(p.selection))}`;
export const statKey = (p) => norm(p.market);

/**
 * Stats already bet per game + player (placed in the last day, or being placed now): key -> Set of markets.
 * The same stat on both books counts once.
 */
export function playerStats(bets, now = Date.now()) {
  const out = new Map();
  for (const p of bets) {
    if (!isPropBet(p) || (p.at && now - Date.parse(p.at) > 24 * 3600e3)) continue;
    const k = playerKey(p);
    if (!out.has(k)) out.set(k, new Set());
    out.get(k).add(statKey(p));
  }
  return out;
}

/** A prop on a new stat for a player who already has maxPropStatsPerPlayer stats bet. */
export function tooManyStats(cfg, stats, row) {
  const max = cfg.maxPropStatsPerPlayer;
  if (max == null || !isPropBet(row)) return false;
  const have = stats.get(playerKey(row));
  return !!have && !have.has(statKey(row)) && have.size >= max;
}

/** The side within a group ("over", a team name, "trae young over"). */
const sideOf = (r) => norm(r.selection);

/** What's already been bet in each group over the last day (state.placed entries): totals, per book, sides. */
export function groupTotals(placed, now = Date.now()) {
  const out = new Map();
  for (const p of placed) {
    if (now - Date.parse(p.at) > 24 * 3600e3) continue;
    const k = p.market != null ? groupKey(p) : p.group;   // recomputed, so older bets follow the current grouping
    const g = out.get(k) || { bets: 0, staked: 0, lastAt: 0, byBook: new Map(), sides: new Set() };
    const stake = Number(p.stake) || 0, at = Date.parse(p.at) || 0;
    g.bets++; g.staked += stake; g.lastAt = Math.max(g.lastAt, at);
    const b = g.byBook.get(p.book) || { bets: 0, staked: 0, lastAt: 0 };
    b.bets++; b.staked += stake; b.lastAt = Math.max(b.lastAt, at); g.byBook.set(p.book, b);
    if (p.selection != null) g.sides.add(sideOf(p));
    out.set(k, g);
  }
  return out;
}

/**
 * Room left in a row's group: null = group is full. With group.perBook the bet count and $ cap are
 * per book, and a group that already has a bet on one side takes no bet on the other side, any book.
 */
export function groupRoom(cfg, totals, row, now = Date.now()) {
  const all = totals.get(groupKey(row));
  if (otherSideBlocked(cfg, all, row, now)) return null;
  const g = (cfg.group.perBook ? all?.byBook.get(row.book) : all) || { bets: 0, staked: 0, lastAt: 0 };
  const max = groupMaxBets(cfg, row);
  if (max != null && g.bets >= max) return null;
  if (groupWaitSec(cfg, g, now) > 0) return null;
  const left = cfg.group.maxStake == null ? Infinity : cfg.group.maxStake - g.staked;
  return left > 0.0001 ? left : null;
}

/** Bet limit for a row's group: group.pregameMaxBets for a pre-game row, else group.maxBets. null = no limit. */
export function groupMaxBets(cfg, row) {
  const g = cfg.group;
  return row?.isLive === false && g.pregameMaxBets != null ? g.pregameMaxBets : g.maxBets;
}

/** Seconds until the group's cooldown ends (0 = no wait). */
export function groupWaitSec(cfg, g, now = Date.now()) {
  const cd = Number(cfg.group.cooldownSec) || 0;
  if (!cd || !g?.lastAt) return 0;
  return Math.max(0, cd - (now - g.lastAt) / 1000);
}

/** True when a row's group is only waiting out its cooldown (it has bet room otherwise). */
export function groupCoolingDown(cfg, totals, row, now = Date.now()) {
  const all = totals.get(groupKey(row));
  const g = cfg.group.perBook ? all?.byBook.get(row.book) : all;
  if (groupWaitSec(cfg, g, now) > 0) return true;
  return hasOtherSide(cfg, all, row) && cfg.group.otherSide !== 'block' && groupWaitSec(cfg, all, now) > 0;
}

const hasOtherSide = (cfg, all, row) => cfg.group.perBook && !!all && [...all.sides].some((s) => s !== sideOf(row));

/** Opposite side of a bet already in the group: blocked for good with otherSide "block", else until the cooldown ends. */
function otherSideBlocked(cfg, all, row, now) {
  if (!hasOtherSide(cfg, all, row)) return false;
  if (cfg.group.otherSide === 'block' || !Number(cfg.group.cooldownSec)) return true;
  return groupWaitSec(cfg, all, now) > 0;
}

/** Two bets that can't run side by side: same group, and (per book) same book or opposite sides. */
export function groupClash(cfg, a, b) {
  if (groupKey(a) !== groupKey(b)) return false;
  return !cfg.group.perBook || a.book === b.book || sideOf(a) !== sideOf(b);
}
