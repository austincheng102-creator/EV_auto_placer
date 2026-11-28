// Austin's placement rules on top of the EV and Novig checks:
//  - odds window: nothing shorter than -300 (minOdds) or longer than +250 (maxOdds)
//  - EV cap: nothing above 25% EV (maxEvPct), it's usually a stale or wrong price; player props no cap (maxPropEvPct null,
//    Austin 2026-11-26; was 50)
//  - prop hold (propHold, Austin 2026-11-26): a player prop above 30% EV that passes every rule is held 40s,
//    then every rule runs again on the newest scan and the book re-check runs as usual before it's bet
//  - sharp books must agree: their no-vig win probabilities within 3 points of each other
//    (Pinnacle, plus liquid Kalshi/Polymarket; FanDuel left out since 2026-11-19, sharp.spreadBooks)
//  - Prediction markets (Kalshi, Polymarket, Novig, ProphetX) are sharp books (2026-11-23, sharp.predictionMarkets), but a
//    price only counts when its two sides add up to 103% or less and the thinner side has $500+ (Gambit's
//    liquidity). Its fair is the lower of the mid and the size-weighted mid. If Kalshi and Polymarket both count,
//    they must be within 2 points or neither counts. Ones that don't count are ignored everywhere: sharp rules,
//    live timing, and fair odds / EV. Ones that count lower the fair price when they're less optimistic than Pinnacle.
//  - live mainlines need Pinnacle or a liquid Kalshi/Polymarket listed; props (live and pre-game) need FanDuel
//  - soft-book check (softCheck): our price must be above 0% EV against the no-vig price of at least
//    2 of DraftKings, Caesars, FanDuel and Fanatics (the book we're betting doesn't count for itself;
//    Fanatics added 2026-11-26, Gambit id 722, PropProfessor "Fanatics")
//  - Pinnacle vs the market (marketCheck, 2026-11-23): skip when Pinnacle's no-vig win % for our side is more
//    than 3 points above the median no-vig of the soft books on the row (DraftKings, FanDuel, Caesars, BetMGM,
//    theScore, Hard Rock, ...; not the book we're betting). Needs 3+ soft books priced, otherwise it passes.
//  - odds bands (minEvByOdds): +201 to +250 needs 12% EV, everything else minEvPct
//  - pre-game minimum (pregameMinEvPct, Austin 2026-11-25): pre-game bets need 6% EV, live keeps minEvPct (8%).
//    The odds bands and long-odds props rules above still raise it (12% at +201..+250, 18% props over +250).
//  - longOddsProps (Austin 2026-11-25): player props on every book above +250 (maxOdds) are allowed up to
//    +400, at 18% EV or more, and only when DraftKings or Caesars (not the book we're betting) has a
//    no-vig win % for our side within 5 points of our fair win % (longPropConsensus). Game lines keep +250.
//  - live timing: a sharp price for the selection changed within the last 5 seconds (30 for props); props over
//    the propHold EV (30%) skip it (Austin 2026-11-26)
//  - groups: same game + market (period is part of the market) share group.maxBets bets and group.maxStake $.
//    Both sides count as one group (Over and Under, either team's spread), unless group.bothSides is true.
//    Player props: per player, so Over/Under on one player's stat are one group.
//    group.perBook (default on): each book gets its own maxBets/maxStake in the group, so the same side
//    can go on BetRivers and Hard Rock once each. The other side waits out the cooldown (group.otherSide).
//    group.pregameMaxBets (default 1): pre-game bets get this many per group (per book) instead of maxBets.
//    group.cooldownSec (default 150): a repeat bet in the same group (same book with perBook) waits this
//    long after the last one, and must still pass every rule. Different markets in one game don't wait.
//    group.repeatMinEvPts (default 3): a repeat of the same bet (same book, side and line) is skipped
//    while its EV is within 3 points of an earlier one's (10.1% then 13.0% = skipped, 13.1% = allowed).
import { impliedProb } from './ev.js';

// Gambit sportsbook ids. PS3838 is Pinnacle's feed. Polymarket has two listings.
export const DEFAULT_SHARP_IDS = { pinnacle: 1014, kalshi: 194, polymarket: [193, 1011], novig: 192, prophetx: 191, fanduel: 100 };

// Soft books the marketCheck median is taken over (Gambit ids). Prediction markets and exchanges
// (Kalshi, Polymarket, Novig, ProphetX) aren't soft books and aren't in it.
export const DEFAULT_MARKET_BOOKS = {
  draftkings: 200, fanduel: 100, caesars: 300, betmgm: [400, 1001], thescore: 700, hardrock: [851, 850, 1008, 1016],
  betrivers: 1004, kambi: 500, betparx: 1005, fliff: 800, bet365: 365, bovada: 1006, betonline: 613,
};

// Soft-book check books (Gambit ids). Fanatics (722) added 2026-11-26 (Austin) so more lines have two
// books priced; "need 2" (softCheck.minBooks) unchanged.
export const DEFAULT_SOFT_BOOKS = { draftkings: 200, caesars: 300, fanduel: 100, fanatics: 722 };

/** Fills in defaults for the new settings, so configs from older versions get Austin's rules. */
export function applyFilterDefaults(cfg) {
  if (cfg.minOdds === undefined) cfg.minOdds = -300;
  if (cfg.maxEvPct === undefined) cfg.maxEvPct = 25;
  // Player props (+EV and arb-table rows) get their own EV cap. null = no cap (Austin 2026-11-26: unlimited;
  // was 50). A number caps props there again.
  if (cfg.maxPropEvPct === undefined) cfg.maxPropEvPct = null;
  // Prop hold (Austin 2026-11-26): player props (+EV and arb-table, both sources) above evPct EV must pass
  // every rule, stay listed for sec seconds, then pass every rule and check again. false = off.
  if (cfg.propHold !== false) cfg.propHold = { evPct: 30, sec: 40, ...(cfg.propHold || {}) };
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
  if (g.cooldownSec === undefined) g.cooldownSec = 150;
  // Same bet again (same book, side and line): only when its EV differs by at least this many points from
  // every earlier one on that book in the last 24h (10.1% EV first -> 13.1%+ or 7.1%- for a repeat). 0/null = off.
  if (g.repeatMinEvPts === undefined) g.repeatMinEvPts = 3;
  // The opposite side (Under after an Over, the other team): "afterCooldown" (default) lets it go once the
  // group's last bet, on any book, is cooldownSec old and it passes every rule; "block" = never that game.
  if (g.otherSide === undefined) g.otherSide = 'afterCooldown';
  bothSides = !!g.bothSides;
  // Soft-book check: EV above minEvPct (4) against the no-vig price of at least minBooks (2) of these
  // books. A book that doesn't list both sides doesn't count; fewer than minBooks priced = skip.
  // skipOwnBook: the book we're betting isn't checked against itself (its own vig always makes that negative).
  const sc = (cfg.softCheck ||= {});
  if (sc.enabled === undefined) sc.enabled = true;
  if (sc.books === undefined) sc.books = { ...DEFAULT_SOFT_BOOKS };
  if (sc.minBooks === undefined) sc.minBooks = 2;
  // 4 (Austin 2026-11-25): bets that were only 0-4% EV against these books lost -$59 vs +$33 expected.
  if (sc.minEvPct === undefined) sc.minEvPct = 4;
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
  // Player props above maxOdds (+250): allowed, but only at this EV or more and up to this maxOdds
  // (null = no upper limit). Keyed by book; "all" covers every book without its own entry.
  // Austin 2026-11-25: all books, up to +400, 18% EV (replaces BetRivers' 15% rule). {} turns it off.
  if (cfg.longOddsProps === undefined) cfg.longOddsProps = { all: { minEvPct: 18, maxOdds: 400 } };
  // Those long-odds props also need consensus: at least minBooks of these books (both sides listed,
  // not the book we're betting) with a no-vig win % for our side within maxPts of our fair win %.
  // None of them priced = skip. "enabled": false turns it off.
  const lc = (cfg.longPropConsensus ||= {});
  if (lc.enabled === undefined) lc.enabled = true;
  if (lc.books === undefined) lc.books = { draftkings: 200, caesars: 300 };
  if (lc.maxPts === undefined) lc.maxPts = 5;
  if (lc.minBooks === undefined) lc.minBooks = 1;
  // Live totals at Hard Rock and BetRivers are skipped when the fair price comes from Pinnacle alone (no
  // prediction market counted) (Austin 2026-11-26). Team totals too; not props. "live": false / "pregame": true
  // change when it applies. false turns it off.
  if (cfg.pinnacleOnlyTotals === undefined) cfg.pinnacleOnlyTotals = { books: ['hardrock', 'betrivers'], live: true, pregame: false };
  // Prediction-market check (Austin 2026-11-26): on moneylines and player props, skip when any prediction market
  // listed on the row (Kalshi, Polymarket, Novig, ProphetX), even one too thin to count for the fair, gives our
  // side a win % pts (2) or more below our fair. markets: any of moneyline, props, spreads, totals. false = off.
  if (cfg.pmBelowFair === undefined) cfg.pmBelowFair = {};
  if (cfg.pmBelowFair) cfg.pmBelowFair = { pts: 2, markets: ['moneyline', 'props'], countThin: true, ...cfg.pmBelowFair };
  // Pre-game (Austin 2026-11-26): bet only if Pinnacle's no-vig win % for our side is within maxPts (2) of
  // both DraftKings' and FanDuel's. missing: "skip" (default) = Pinnacle, DraftKings or FanDuel not priced on
  // both sides means skip; "pass" = then the rule doesn't apply. false = off.
  if (cfg.pregamePinnacleCheck === undefined) cfg.pregamePinnacleCheck = {};
  if (cfg.pregamePinnacleCheck) cfg.pregamePinnacleCheck = { maxPts: 2, books: { draftkings: 200, fanduel: 100 }, missing: 'skip', ...cfg.pregamePinnacleCheck };
  // Pre-game book check (Austin 2026-11-28). Only when the fair was set by Pinnacle or a prediction market
  // (fairBy). Each reference book with the same line (both sides listed, never the book being bet) gives
  // its simple no-vig win % for our side; any one more than maxPts (2.0) from our fair, either way = skip.
  // None of them listed = nothing to check, bet as normal. PropProfessor's own fair (and FanDuel's, on
  // props) is not checked. It replaces pregamePinnacleCheck, which then doesn't run. false = off (and
  // pregamePinnacleCheck back as configured).
  if (cfg.pregameBookCheck === undefined) cfg.pregameBookCheck = {};
  if (cfg.pregameBookCheck) cfg.pregameBookCheck = {
    maxPts: 2, books: { draftkings: 200, fanduel: 100, caesars: 300, thescore: 700 },
    fairBy: ['pinnacle', 'kalshi', 'polymarket', 'novig', 'prophetx'], ...cfg.pregameBookCheck };
  if (cfg.pregameBookCheck && cfg.pregameBookCheck.enabled !== false && cfg.pregamePinnacleCheck) {
    cfg.pregamePinnacleReplaced = true;
    cfg.pregamePinnacleCheck = false;
  }
  // Live (Austin 2026-11-26): skip when the book's real price is different at all from the price the table
  // (Gambit / PropProfessor) quoted, better or worse, on every book (Hard Rock too). onRetry: a price that
  // moves while placing (or a DraftKings counter-offer) is held to the same rule. false = back to gambitBehind.
  if (cfg.livePriceMatch === undefined) cfg.livePriceMatch = {};
  if (cfg.livePriceMatch) cfg.livePriceMatch = { onRetry: true, ...cfg.livePriceMatch };
  return cfg;
}

/** Market kind of a row: props, moneyline, totals (game and team totals) or spreads. */
export function marketKind(row) {
  if (isPropBet(row)) return 'props';
  const m = String(row.marketKey || row.market || '');
  if (/money_?line/i.test(m)) return 'moneyline';
  if (/total/i.test(m)) return 'totals';
  return 'spreads';
}

// Books whose live player props from the +EV table are off unless "<book>": {"liveEvProps": true}
// (Austin 2026-11-26: Hard Rock). Arbitrage-table props on that book are still bet.
export const NO_LIVE_EV_PROPS_DEFAULT = ['hardrock'];
export const liveEvPropOff = (cfg, r) => r.isLive === true && !r.arb && isPropBet(r)
  && (cfg[r.book]?.liveEvProps ?? !NO_LIVE_EV_PROPS_DEFAULT.includes(r.book)) === false;

/** A total on pinnacleOnlyTotals' books whose fair came from Pinnacle alone (true = skip). */
export function pinnacleOnlyTotal(cfg, row) {
  const c = cfg.pinnacleOnlyTotals;
  if (!c || c.enabled === false || row.arb || !(c.books || []).includes(row.book)) return false;
  if (row.isLive === true ? c.live === false : c.pregame !== true) return false;
  if (marketKind(row) !== 'totals') return false;
  const fc = row.fairCalc;
  if (!fc || fc.ppFallback) return false;
  const names = Object.keys(fc.probs || {});
  return names.length > 0 && names.every((n) => n === 'pinnacle');
}

/**
 * Prediction-market check. Returns { ok, probs: {kalshi: 0.48}, worst, gap, fair, off }.
 * probs = each listed prediction market's win % for our side: the counted price (pmState) when it counts,
 * else (countThin) the mid of its two sides, or our side's implied % when only one side is listed.
 * Sides that cross (add up under 97%) are stale and ignored. gap = fair - worst, in points.
 */
export function pmBelowFair(cfg, row) {
  const c = cfg.pmBelowFair;
  if (!c || c.enabled === false || !(c.markets || []).includes(marketKind(row))) return { ok: true, off: true, probs: {} };
  const probs = pmListed(cfg, row, c.countThin !== false, c.books);
  const fair = row.fairProb;
  const vals = Object.values(probs);
  if (!vals.length || !Number.isFinite(fair)) return { ok: true, probs, worst: null, gap: null, fair };
  const worst = Math.min(...vals), gap = (fair - worst) * 100;
  return { ok: c.pts == null || gap < Number(c.pts) - 1e-9, probs, worst, gap, fair };
}

/** Win % for our side from every prediction market listed on a row (see pmBelowFair). */
export function pmListed(cfg, row, countThin = true, books = null) {
  const pm = cfg.sharp?.predictionMarkets;
  const st = pmState(cfg, row);
  const probs = {};
  for (const n of books || pm?.books || ['kalshi', 'polymarket', 'novig', 'prophetx']) for (const id of ids(cfg, n)) {
    const pr = row.prices?.[id];
    if (!pr || pr.odds == null || !Number.isFinite(Number(pr.odds))) continue;
    let p = null;
    if (st.used[n] === Number(id)) p = st.probs[n];
    else if (countThin) {
      const a = impliedProb(pr.odds);
      if (pr.oppOdds != null && Number.isFinite(Number(pr.oppOdds))) { const q = impliedProb(pr.oppOdds); if (a + q >= 0.97) p = (a + 1 - q) / 2; }
      else p = a;
    }
    if (p != null && Number.isFinite(p) && (probs[n] == null || p < probs[n])) probs[n] = p;
  }
  return probs;
}

/** "fair 52.0%: kalshi 49.5, novig 51.0" for logs. */
export const fmtPmBelow = (c) => `fair ${Number.isFinite(c.fair) ? (c.fair * 100).toFixed(1) : '?'}%: ${Object.entries(c.probs).map(([n, p]) => `${n} ${(p * 100).toFixed(1)}`).join(', ')}`;

/**
 * Pre-game Pinnacle check. Returns { ok, pin, probs: {draftkings: 0.51, fanduel: 0.5}, gaps: {draftkings: 1.2}, missing: [] }.
 * Every win % is the plain no-vig of that book's two sides. ok when Pinnacle is within maxPts of each book.
 */
export function pregamePinnacle(cfg, row) {
  const c = cfg.pregamePinnacleCheck;
  if (!c || c.enabled === false || row.isLive !== false || (row.arb && c.arb === false) || (isPropBet(row) && c.props === false)) return { ok: true, off: true, probs: {}, gaps: {}, missing: [] };
  const first = (idv) => {
    for (const id of [].concat(idv ?? []).map(Number)) { const pr = row.prices?.[id]; const p = pr && bookFairProb(pr.odds, pr.oppOdds); if (p != null) return p; }
    return null;
  };
  const pin = first(cfg.sharp?.ids?.pinnacle ?? 1014);
  const probs = {}, gaps = {}, missing = pin == null ? ['pinnacle'] : [];
  for (const [n, idv] of Object.entries(c.books || {})) {
    const p = first(idv);
    if (p == null) { missing.push(n); continue; }
    probs[n] = p;
    if (pin != null) gaps[n] = (pin - p) * 100;
  }
  if (missing.length) return { ok: c.missing === 'pass', pin, probs, gaps, missing };
  const ok = c.maxPts == null || Object.values(gaps).every((g) => Math.abs(g) <= Number(c.maxPts) + 1e-9);
  return { ok, pin, probs, gaps, missing };
}

/** Names of the books that set a row's fair (fairBreakdown role 'fair'). */
export function fairSetters(cfg, row) {
  try { return fairBreakdown(cfg, row).books.filter((b) => b.role === 'fair').map((b) => String(b.name).toLowerCase()); } catch { return []; }
}

/**
 * Pre-game book check. Returns { ok, off, fair, probs: {draftkings: 0.505}, gaps: {draftkings: -1.5}, worst }.
 * gaps = book win % minus our fair, in points. ok unless any listed book is more than maxPts away.
 */
export function pregameBooks(cfg, row) {
  const c = cfg.pregameBookCheck;
  const off = { ok: true, off: true, probs: {}, gaps: {} };
  if (!c || c.enabled === false || row.isLive !== false || (row.arb && c.arb === false) || (isPropBet(row) && c.props === false)) return off;
  if (row.ppFairFallback || row.fairCalc?.ppFallback) return off;
  const by = new Set((c.fairBy || []).map((n) => String(n).toLowerCase()));
  if (!fairSetters(cfg, row).some((n) => by.has(n))) return off;
  const fair = row.fairProb;
  if (!Number.isFinite(fair)) return off;
  const probs = {}, gaps = {};
  for (const [name, idv] of Object.entries(c.books || {})) {
    const idList = [].concat(idv ?? []).map(Number);
    if (name === row.book || idList.includes(Number(row.gambitBookId))) continue;
    for (const id of idList) {
      const pr = row.prices?.[id];
      const p = pr && bookFairProb(pr.odds, pr.oppOdds);
      if (p != null) { probs[name] = p; gaps[name] = (p - fair) * 100; break; }
    }
  }
  const vals = Object.values(gaps);
  const worst = vals.length ? Math.max(...vals.map(Math.abs)) : null;
  const ok = c.maxPts == null || worst == null || worst <= Number(c.maxPts) + 1e-9;
  return { ok, fair, probs, gaps, worst };
}

/** "fair 52.0%: draftkings 50.5 (-1.5), caesars 49.5 (-2.5)" for logs. */
export const fmtPregameBooks = (c) => `fair ${Number.isFinite(c.fair) ? (c.fair * 100).toFixed(1) : '?'}%: ${Object.entries(c.probs).map(([n, p]) => `${n} ${(p * 100).toFixed(1)} (${c.gaps[n] >= 0 ? '+' : ''}${c.gaps[n].toFixed(1)})`).join(', ') || 'no reference book listed'}`;

/** "Pinnacle 52.0%: draftkings 50.1 (+1.9), fanduel 49.2 (+2.8)" for logs. */
export const fmtPregamePin = (c) => `Pinnacle ${c.pin == null ? 'not priced' : (c.pin * 100).toFixed(1) + '%'}: ${[
  ...Object.entries(c.probs).map(([n, p]) => `${n} ${(p * 100).toFixed(1)}${c.gaps[n] != null ? ` (${c.gaps[n] >= 0 ? '+' : ''}${c.gaps[n].toFixed(1)})` : ''}`),
  ...c.missing.filter((n) => n !== 'pinnacle').map((n) => `${n} not priced`)].join(', ')}`;

/** The longOddsProps rule that lets this prop past the maxOdds cap at these odds, or null. */
export function longPropRule(cfg, row, odds = row?.odds) {
  if (!row || cfg.maxOdds == null || !Number.isFinite(odds) || odds <= cfg.maxOdds) return null;
  const r = cfg.longOddsProps?.[row.book] ?? cfg.longOddsProps?.all;
  if (!r || !Number.isFinite(Number(r.minEvPct)) || !isPropBet(row)) return null;
  if (r.maxOdds != null && odds > Number(r.maxOdds)) return null;
  return r;
}

/**
 * Consensus check for long-odds props (only when longPropRule lets the price past maxOdds).
 * Returns { ok, need, probs: {draftkings: 0.24, ...}, fair, n, off }. probs = each book's no-vig win %
 * for our side; ok when at least `need` of them are within maxPts of the fair win %.
 */
export function longPropConsensus(cfg, row, odds = row?.odds) {
  const lc = cfg.longPropConsensus;
  if (!lc?.enabled || !longPropRule(cfg, row, odds)) return { ok: true, off: true, probs: {}, n: 0 };
  const fair = Number.isFinite(row.fairProb) && row.fairOdds == null ? row.fairProb : impliedProb(row.fairOdds);
  const probs = {};
  for (const [name, idv] of Object.entries(lc.books || {})) {
    const idList = [].concat(idv ?? []).map(Number);
    if (name === row.book || idList.includes(Number(row.gambitBookId))) continue;
    for (const id of idList) {
      const pr = row.prices?.[id];
      const p = pr && bookFairProb(pr.odds, pr.oppOdds);
      if (p != null) { probs[name] = p; break; }
    }
  }
  const need = lc.minBooks ?? 1;
  const close = Number.isFinite(fair) ? Object.values(probs).filter((p) => Math.abs(p - fair) * 100 <= lc.maxPts).length : 0;
  return { ok: close >= need, probs, fair, n: Object.keys(probs).length, close, need };
}

/** Log text for longPropConsensus: "fair 22.0%: draftkings 24.1, caesars 30.2". */
export const fmtLongConsensus = (c) => `fair ${Number.isFinite(c.fair) ? (c.fair * 100).toFixed(1) : '?'}%: ${Object.entries(c.probs).map(([n, p]) => `${n} ${(p * 100).toFixed(1)}`).join(', ') || 'no DraftKings/Caesars price'}`;

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
/** The EV cap for a row: maxPropEvPct (default null = no cap) for player props, maxEvPct for everything else. */
export const maxEvFor = (cfg, row) => (row && isPropBet(row) && cfg.maxPropEvPct !== undefined ? cfg.maxPropEvPct : cfg.maxEvPct);
export const evTooHigh = (cfg, ev, row) => { const m = maxEvFor(cfg, row); return m != null && ev > m; };

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
  const gambitPinnacle = fromPinnacle && Number.isFinite(row.fairProb);
  if (!vals.length) return { prob: fromPinnacle ? row.fairProb : null, books: [], probs, changed: !fromPinnacle, gambitPinnacle };
  const prob = Math.min(...vals);
  const books = Object.keys(probs).filter((n) => probs[n] === prob);
  return { prob, books, probs, changed: !fromPinnacle || prob < row.fairProb, gambitPinnacle };
}

/**
 * What set a row's fair price, book by book, for the bet log and the Show bets popup (Austin,
 * 2026-11-24: the hover has to show the reference prices that were really used for the EV).
 * Returns { how, books: [{ name, id, noVig, role, why }] }:
 *   role 'fair' = set the fair price (the lowest, or part of the average on Arb-table rows),
 *        'used' = counted, but another book was lower, 'not used' = left out (why says why).
 * noVig = that book's win % for our side exactly as the fair calculation saw it.
 */
export function fairBreakdown(cfg, row) {
  const books = [];
  const firstId = (list) => list.map(Number).find((id) => row.prices?.[id]?.odds != null) ?? list.map(Number)[0] ?? null;
  const same = (a, b) => Math.abs(a - b) < 1e-12;
  if (row.arb && row.refProbs) {
    const used = new Set(row.refUsed || String(row.fairSource || '').replace(/^arb table: /, '').split('/'));
    const avg = row.refMode === 'average';
    for (const [n, p] of Object.entries(row.refProbs)) {
      const id = firstId([].concat(row.refIds?.[n] ?? []).filter((x) => Number(x) !== Number(row.gambitBookId)));
      const role = !used.has(n) ? 'not used' : avg || same(p, row.fairProb) ? 'fair' : 'used';
      books.push({ name: n, id, noVig: p, role, why: role === 'not used' ? 'too far from the other reference books' : null });
    }
    return { how: `${avg ? 'Average' : 'Lowest'} no-vig win % of the reference books that agree (simple no-vig of each book's two sides)`, books };
  }
  const fc = row.fairCalc;
  if (fc?.ppFallback) {
    return { how: "PropProfessor's own no-vig fair: no Pinnacle price and no prediction market with enough money behind it", books: [{ name: 'PropProfessor', id: null, noVig: row.fairProb, role: 'fair', why: null }] };
  }
  if (fc) {
    const pm = pmState(cfg, row);
    for (const [n, p] of Object.entries(fc.probs || {})) {
      const id = pm.used[n] ?? firstId(ids(cfg, n));
      books.push({ name: n, id, noVig: p, role: fc.books.includes(n) ? 'fair' : 'used',
        why: n === 'pinnacle' && fc.gambitPinnacle ? "Gambit's own Pinnacle fair (lowest of its 4 no-vig methods)" : null });
    }
    for (const b of pm.bad) if (!books.some((x) => x.id === Number(b.id))) books.push({ name: b.name, id: Number(b.id), noVig: null, role: 'not used', why: b.why });
    for (const n of ['pinnacle', ...(row.isProp ? ['fanduel'] : [])]) {
      if (fc.probs?.[n] != null) continue;
      const id = firstId(ids(cfg, n));
      if (row.prices?.[id]?.odds != null) books.push({ name: n, id, noVig: null, role: 'not used', why: 'other side missing or the two sides don\'t fit one line' });
    }
    return { how: 'Lowest win % of the sharp books: Pinnacle, prediction markets with enough money behind them' + (row.isProp ? ', FanDuel' : '') +
      '. Sportsbooks: lowest of 3 no-vig methods; prediction markets: lower of the mid and the money-weighted mid', books };
  }
  if (row.fairSource === 'PS3838') {
    books.push({ name: 'pinnacle', id: firstId(ids(cfg, 'pinnacle')), noVig: row.fairProb, role: 'fair', why: "Gambit's own Pinnacle fair (lowest of its 4 no-vig methods)" });
    return { how: "Gambit's Pinnacle fair, lowest of its 4 no-vig methods", books };
  }
  return { how: `Gambit's ${row.fairSource || 'market'} fair from ${row.fairBooks ?? '?'} book prices, lowest of its 4 no-vig methods`, books };
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
  // A PropProfessor game line priced off PropProfessor's own fair (no sharp book listed): the live
  // timing rule watches that fair instead (its no-vig odds), so it still needs a move in the last 5s.
  const sigOf = (row) => row.ppFairFallback ? `pp:${Number(row.fairProb).toFixed(4)}` : watched(cfg, row).flatMap((n) => ids(cfg, n))
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
    const g = out.get(k) || { bets: 0, staked: 0, lastAt: 0, byBook: new Map(), sides: new Set(), same: new Map() };
    // groupStake: the stake in base units (a $10 Hard Rock pre-game bet at a $1 base stake counts $1 toward
    // group.maxStake), so a bigger per-book stake doesn't fill the group's $ cap on its own.
    const stake = Number(p.groupStake ?? p.stake) || 0, at = Date.parse(p.at) || 0;
    g.bets++; g.staked += stake; g.lastAt = Math.max(g.lastAt, at);
    const b = g.byBook.get(p.book) || { bets: 0, staked: 0, lastAt: 0 };
    b.bets++; b.staked += stake; b.lastAt = Math.max(b.lastAt, at); g.byBook.set(p.book, b);
    if (p.selection != null) g.sides.add(sideOf(p));
    const sk = sameBetKey(p), e = Number(p.ev);
    if (p.ev != null && Number.isFinite(e)) { if (!g.same.has(sk)) g.same.set(sk, []); g.same.get(sk).push(e); }
    out.set(k, g);
  }
  return out;
}

/** Same bet: same book, side and line (the group key covers game + market). */
const sameBetKey = (r) => `${r.book}|${sideOf(r)}|${r.line ?? ''}`;

/**
 * An earlier bet on the same book, side and line whose EV is within group.repeatMinEvPts points of `ev`
 * (default: the row's EV). Returns that bet's EV, or null when none is that close.
 */
export function sameEvRepeat(cfg, totals, row, ev = row?.ev) {
  const pts = Number(cfg.group.repeatMinEvPts) || 0;
  const e = Number(ev);
  if (!pts || !Number.isFinite(e)) return null;
  const prev = totals.get(groupKey(row))?.same?.get(sameBetKey(row)) || [];
  for (const q of prev) if (Math.abs(e - q) < pts - 1e-9) return q;
  return null;
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
