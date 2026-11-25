// Bet results (won / lost / push / void) and profit, for the P&L chart.
//
// Results live in their own file, results.json next to the app, keyed by bet id. They are
// kept apart from bets.json on purpose: the running placer rewrites bets.json from memory
// on every bet, so a result written into bets.json by `ev-placer bets` would be lost.
//
// Where results come from: the running placer reads Hard Rock's and BetRivers' settled bets
// (My Bets > Settled) every few minutes and fills them in (source "book", with the book's
// payout and odds). Anything can also be marked by hand on the chart page.
import fs from 'node:fs';
import path from 'node:path';
import { americanToDecimal, evMovedTo } from './ev.js';
import { betSource } from './betlog.js';

// 'not placed': the app logged a bet the book never took (DraftKings declined it after the live delay).
export const RESULTS = ['won', 'lost', 'push', 'void', 'half-won', 'half-lost', 'cashout', 'not placed'];

/** Stable id for a bet: the book's bet id, or when there is none the time it was placed. */
export const betKey = (b) => String(b.betId || `placed:${b.placedAt}`);

/**
 * Profit in $ of a settled bet at American `odds`. `payout` (the book's total return,
 * stake included) wins over the odds when the book reports it.
 */
export function profitOf({ result, stake, odds, payout }) {
  const s = Number(stake) || 0;
  if (result === 'not placed') return 0;
  if (payout != null && Number.isFinite(Number(payout))) return Number(payout) - s;
  const win = s * (americanToDecimal(odds) - 1);
  switch (result) {
    case 'won': return win;
    case 'lost': return -s;
    case 'half-won': return win / 2;
    case 'half-lost': return -s / 2;
    case 'push': case 'void': return 0;
    case 'cashout': return null;   // needs the book's payout
    default: return null;
  }
}

export function makeResults(dir, { dryRun = false } = {}) {
  const file = path.join(dir, dryRun ? 'results.dry.json' : 'results.json');
  // Always read fresh: the placer and the chart page can both write it.
  // Fix-up for BetRivers results saved before this fix, which read Kambi's x1000 payout as
  // cents (10x too big). Those entries have no "v"; divide once and mark them.
  function migrate(all) {
    let changed = false;
    for (const [k, r] of Object.entries(all)) {
      // DraftKings bets logged without DraftKings' bet id were matched to its settled bets by time and
      // stake only, which gave some of them another bet's result (two bets 7s apart, same $1). Drop those
      // once so they're matched again by selection (resultsync.js looseMatch).
      if (k.startsWith('draftkings:waiting-') && r?.source === 'book' && !r.bookBetId && !(r.v >= 3)) { delete all[k]; changed = true; continue; }
      if (k.startsWith('coupon:') && r?.source === 'book' && !r.v) {
        if (r.payout != null) r.payout = Math.round(r.payout * 10) / 100;
        r.v = 2; changed = true;
      }
    }
    if (changed) try { fs.writeFileSync(file, JSON.stringify(all, null, 2)); } catch {}
    return all;
  }
  const read = () => { try { return migrate(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return {}; } };
  function set(key, result, { source = 'manual', payout = null, odds = null, settledAt = null } = {}) {
    const all = read();
    if (!result) delete all[key];
    else {
      if (!RESULTS.includes(result)) throw new Error(`unknown result "${result}"`);
      all[key] = { result, payout, odds, source, settledAt: settledAt || new Date().toISOString() };
    }
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
    return all[key] || null;
  }
  /** Save several book results at once. Never overwrites a result you marked by hand. */
  function setMany(list) {
    const all = read();
    let n = 0;
    for (const { key, result, payout = null, odds = null, settledAt = null, stake = null, bookBetId = null } of list) {
      if (all[key]?.source === 'manual' || (all[key] && all[key].result === result && all[key].payout === payout && (!bookBetId || all[key].bookBetId === String(bookBetId)))) continue;
      // stake: what the book says was staked; bookBetId: the book's bet id this result came from.
      all[key] = { result, payout, odds, stake, bookBetId: bookBetId == null ? null : String(bookBetId), source: 'book', settledAt: settledAt || new Date().toISOString(), v: 3 };
      n++;
    }
    if (n) fs.writeFileSync(file, JSON.stringify(all, null, 2));
    return n;
  }
  return { file, read, set, setMany };
}

/**
 * Market type of a bet, for the Show bets sections: 'ml' (moneyline), 'spread', 'total', 'prop'
 * (player prop) or 'other' (team totals, halves, quarters, periods, sets). Full game only for the
 * first three. Works from what every bet already has saved, old ones included: Gambit's market key
 * (bets.json marketKey, saved since 2026-11-22) or else the market name and selection.
 */
const PERIOD_RE = /first_?half|second_?half|1h|2h|quarter|period|inning|set\b|_set_|half/i;
export function marketTypeOf(b) {
  const raw = String(b?.marketKey || b?.market || '').trim();
  const k = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (/^player_prop/.test(k) || b?.isProp === true || betSource(b) === 'arb') return 'prop';
  // Game markets: the name starts with the market (then maybe a period).
  const game = /^(\d?[hq]_)?(money_?line|moneyline|spread|handicap|run_line|puck_line|point_spread|total|total_game_points|total_games|total_goals|total_points|team_total)(_|$)/.exec(k);
  // "Total Receptions", "Total Bases" (player props) start with "total" too: only the game totals count.
  const isGame = game && !(game[2] === 'total' && /^total_(?!game_points|games|goals|points)(?!first|second|third|fourth|1|2|3|4)/.test(k));
  if (!isGame) {
    // A player name before Over/Under, Yes/No (Gambit's prop rows: "Trae Young Over").
    const sel = String(b?.selection ?? '').trim();
    if (/\S\s+(over|under|yes|no)$/i.test(sel)) return 'prop';
    return 'other';
  }
  if (game[2] === 'team_total' || PERIOD_RE.test(k.slice(game[0].length)) || game[1]) return 'other';
  return /money/.test(game[2]) ? 'ml' : /total/.test(game[2]) ? 'total' : 'spread';
}

/**
 * Every bet we know about, newest last, with its result and profit filled in.
 * Uses bets.json, plus bets from state.json that were placed before bets.json existed.
 */
/** Every bet placed: bets.json plus bets from state.json placed before bets.json existed. */
// The running placer asks for this every 15s for each book (results check), and bets.json is
// several MB after a few thousand bets: the files are only read again when they changed (size +
// modified time), otherwise the last read is handed out again. Nothing changes the bets it returns.
const allCache = new Map();   // dir|sfx -> { stamp, list }
const fileStamp = (f) => { try { const st = fs.statSync(f); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; } };
export function allBets(dir, { dryRun = false } = {}) {
  const sfx = dryRun ? '.dry' : '';
  const ck = `${dir}|${sfx}`;
  const stamp = fileStamp(path.join(dir, `bets${sfx}.json`)) + '|' + fileStamp(path.join(dir, `state${sfx}.json`));
  const hit = allCache.get(ck);
  if (hit && hit.stamp === stamp) return [...hit.list];
  const list = readAllBets(dir, sfx);
  allCache.set(ck, { stamp, list });
  return [...list];
}
function readAllBets(dir, sfx) {
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
  const logged = readJson(`bets${sfx}.json`, []);
  const state = readJson(`state${sfx}.json`, { placed: [] });
  const ids = new Set(logged.map((b) => b.betId).filter(Boolean));
  const older = (state.placed || []).filter((p) => !p.betId || !ids.has(p.betId)).map((p) => ({
    placedAt: p.at, betId: p.betId, book: p.book, event: p.event, market: p.market, selection: p.selection,
    line: p.line ?? null, sentOdds: p.odds, confirmedOdds: null, fairOdds: p.fair, ev: p.ev, stake: p.stake,
    live: null, clv: null, fromState: true,
  }));
  return [...older, ...logged];
}

export function loadBets(dir, { dryRun = false } = {}) {
  const results = makeResults(dir, { dryRun }).read();
  return allBets(dir, { dryRun })
    .filter((b) => b.placedAt && Number.isFinite(Date.parse(b.placedAt)))
    .sort((a, b) => Date.parse(a.placedAt) - Date.parse(b.placedAt))
    .map((b) => {
      const key = betKey(b);
      const r = results[key];
      // The book's own record of the price wins over what placeBets said.
      const odds = r?.odds ?? b.confirmedOdds ?? b.sentOdds;
      const stake = Number(b.stake) || 0;
      // bets.json "ev" is the EV at the price we checked and sent. The book can accept a different
      // price (Hard Rock checked +110, accepted +115): EV here is at the price we got, vs the same fair.
      const ev = Number.isFinite(b.ev) ? evMovedTo(b.ev, b.sentOdds, odds) : null;
      // EV after: the same price we got, against the first fair seen after the book accepted the bet.
      const acc = b.atAccept, accProb = Number(acc?.fairProb);
      const evAfter = acc && !acc.gone && !acc.none && accProb > 0 && accProb < 1 && Number.isFinite(Number(odds)) && Number(odds) !== 0
        ? (accProb * americanToDecimal(Number(odds)) - 1) * 100 : Number.isFinite(acc?.ev) ? acc.ev : null;
      return {
        key, placedAt: b.placedAt, book: b.book, event: b.event, market: b.market, selection: b.selection, line: b.line,
        // Moneyline / spread / total / player prop / other, worked out again on every load (old bets too).
        mkt: marketTypeOf(b),
        live: b.live, source: betSource(b), feed: b.feed ?? null, otherBooks: b.otherBooks ?? null, sharpNoVig: b.sharpNoVig ?? null,
        // For the hover popup: the fair price and reference prices the EV was judged on, and when.
        fairOdds: b.fairOdds ?? null, fairProb: b.fairProb ?? null, fairSource: b.fairSource ?? null, sentOdds: b.sentOdds ?? null,
        ref: b.ref ?? null, timing: b.timing ?? null, atAccept: b.atAccept ?? null, odds, stake, ev, evAfter, checkedEv: b.ev ?? null, clv: b.clv ?? null,
        // Expected profit: what the bet is worth on average at the fair price we had, at the price we got.
        expected: r?.result === 'not placed' ? 0 : Number.isFinite(ev) ? stake * ev / 100 : null,
        result: r?.result || null, resultSource: r?.source || null, settledAt: r?.settledAt || null,
        // The book's own stake when it reported one (a bet it took for less than we sent).
        profit: r ? profitOf({ result: r.result, stake: r.stake ?? stake, odds, payout: r.payout }) : null,
      };
    });
}
