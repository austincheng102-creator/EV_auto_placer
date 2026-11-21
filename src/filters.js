// Austin's placement rules on top of the EV and Novig checks:
//  - odds window: nothing shorter than -300 (minOdds) or longer than +250 (maxOdds)
//  - EV cap: nothing above 25% EV (maxEvPct), it's usually a stale or wrong price
//  - sharp books must agree: their no-vig win probabilities within 3 points of each other
//    (Pinnacle, Kalshi, Polymarket, Novig; FanDuel left out since 2026-11-19, sharp.spreadBooks)
//  - live mainlines need Pinnacle, Kalshi, Polymarket or Novig listed; live props need FanDuel
//  - live timing: a sharp price for the selection changed within the last 5 seconds (30 for props)
//  - groups: same game + market (period is part of the market) + side share 3 bets and $3 (was 1 and $1)
import { impliedProb } from './ev.js';

// Gambit sportsbook ids. PS3838 is Pinnacle's feed. Polymarket has two listings.
export const DEFAULT_SHARP_IDS = { pinnacle: 1014, kalshi: 194, polymarket: [193, 1011], novig: 192, fanduel: 100 };

/** Fills in defaults for the new settings, so configs from older versions get Austin's rules. */
export function applyFilterDefaults(cfg) {
  if (cfg.minOdds === undefined) cfg.minOdds = -300;
  if (cfg.maxEvPct === undefined) cfg.maxEvPct = 25;
  const s = (cfg.sharp ||= {});
  s.ids = { ...DEFAULT_SHARP_IDS, ...(s.ids || {}) };
  if (s.liveMainlineNeeds === undefined) s.liveMainlineNeeds = ['pinnacle', 'kalshi', 'polymarket', 'novig'];
  if (s.livePropNeeds === undefined) s.livePropNeeds = ['fanduel'];
  if (s.maxSpreadPts === undefined) s.maxSpreadPts = 3;
  // Books compared by the 3-point rule. FanDuel isn't in it: it isn't sharp on props and kept
  // knocking them out. Add "fanduel" here to compare it again on props.
  if (s.spreadBooks === undefined) s.spreadBooks = ['pinnacle', 'kalshi', 'polymarket', 'novig'];
  if (s.liveMaxAgeSec === undefined) s.liveMaxAgeSec = 5;
  // Live props: FanDuel's prop prices update slowly in Gambit's feed, so props get 30s.
  if (s.livePropMaxAgeSec === undefined) s.livePropMaxAgeSec = 30;
  const g = (cfg.group ||= {});
  if (g.maxBets === undefined) g.maxBets = 3;
  if (g.maxStake === undefined) g.maxStake = 3;
  return cfg;
}

/** -300 is allowed, -310 is not. Positive odds are never "shorter than" a negative limit. */
export const tooShort = (cfg, odds) => cfg.minOdds != null && odds < 0 && odds < cfg.minOdds;
export const evTooHigh = (cfg, ev) => cfg.maxEvPct != null && ev > cfg.maxEvPct;

const ids = (cfg, name) => [].concat(cfg.sharp.ids[name] ?? []).map(Number);

/** Sharp books whose price Gambit lists for this selection, by name. */
export function sharpPresent(cfg, row, names) {
  return names.filter((n) => ids(cfg, n).some((id) => row.prices?.[id]?.odds != null));
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
    for (const id of ids(cfg, n)) {
      const pr = row.prices?.[id];
      const p = pr && bookFairProb(pr.odds, pr.oppOdds);
      if (p != null) { probs[n] = p; break; }
    }
  }
  const vals = Object.values(probs);
  if (vals.length < 2) return { ok: true, n: vals.length, spread: null, probs };
  const spread = (Math.max(...vals) - Math.min(...vals)) * 100;
  return { ok: cfg.sharp.maxSpreadPts == null || spread <= cfg.sharp.maxSpreadPts, n: vals.length, spread, probs };
}

/** Live only: mainlines need one of Pinnacle/Kalshi/Polymarket/Novig, props need FanDuel. */
export function liveSharpMissing(cfg, row) {
  if (!row.isLive) return null;
  const need = row.isProp ? cfg.sharp.livePropNeeds : cfg.sharp.liveMainlineNeeds;
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
    .map((id) => `${id}:${row.prices?.[id]?.odds ?? ''}/${row.prices?.[id]?.oppOdds ?? ''}`).join(',');
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

/** Group: same game, market (period is part of it, e.g. 1H Moneyline), side. Line and book don't matter. */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9+-]/g, '');
export const groupKey = (r) => `${norm(r.event)}|${norm(r.market)}|${norm(r.selection)}`;

/** What's already been bet in each group over the last day (state.placed entries). */
export function groupTotals(placed, now = Date.now()) {
  const out = new Map();
  for (const p of placed) {
    if (now - Date.parse(p.at) > 24 * 3600e3) continue;
    const k = p.group || groupKey(p);
    const g = out.get(k) || { bets: 0, staked: 0 };
    g.bets++; g.staked += Number(p.stake) || 0;
    out.set(k, g);
  }
  return out;
}

/** Room left in a row's group: null = group is full. */
export function groupRoom(cfg, totals, row) {
  const g = totals.get(groupKey(row)) || { bets: 0, staked: 0 };
  if (cfg.group.maxBets != null && g.bets >= cfg.group.maxBets) return null;
  const left = cfg.group.maxStake == null ? Infinity : cfg.group.maxStake - g.staked;
  return left > 0.0001 ? left : null;
}
