// Bet results (won / lost / push / void) and profit, for the P&L chart.
//
// Results live in their own file, results.json next to the app, keyed by bet id. They are
// kept apart from bets.json on purpose: the running placer rewrites bets.json from memory
// on every bet, so a result written into bets.json by `ev-placer bets` would be lost.
//
// Where results come from today: you mark them on the chart page (`ev-placer bets`).
// Hard Rock and BetRivers both have a settled-bets list on their sites; once that request
// is captured the placer can fill results.json by itself (source: "book").
import fs from 'node:fs';
import path from 'node:path';
import { americanToDecimal } from './ev.js';

export const RESULTS = ['won', 'lost', 'push', 'void', 'half-won', 'half-lost'];

/** Stable id for a bet: the book's bet id, or when there is none the time it was placed. */
export const betKey = (b) => String(b.betId || `placed:${b.placedAt}`);

/**
 * Profit in $ of a settled bet at American `odds`. `payout` (the book's total return,
 * stake included) wins over the odds when the book reports it.
 */
export function profitOf({ result, stake, odds, payout }) {
  const s = Number(stake) || 0;
  if (payout != null && Number.isFinite(Number(payout))) return Number(payout) - s;
  const win = s * (americanToDecimal(odds) - 1);
  switch (result) {
    case 'won': return win;
    case 'lost': return -s;
    case 'half-won': return win / 2;
    case 'half-lost': return -s / 2;
    case 'push': case 'void': return 0;
    default: return null;
  }
}

export function makeResults(dir, { dryRun = false } = {}) {
  const file = path.join(dir, dryRun ? 'results.dry.json' : 'results.json');
  // Always read fresh: the placer and the chart page can both write it.
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  function set(key, result, { source = 'manual', payout = null } = {}) {
    const all = read();
    if (!result) delete all[key];
    else {
      if (!RESULTS.includes(result)) throw new Error(`unknown result "${result}"`);
      all[key] = { result, payout, source, settledAt: new Date().toISOString() };
    }
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
    return all[key] || null;
  }
  return { file, read, set };
}

/**
 * Every bet we know about, newest last, with its result and profit filled in.
 * Uses bets.json, plus bets from state.json that were placed before bets.json existed.
 */
export function loadBets(dir, { dryRun = false } = {}) {
  const sfx = dryRun ? '.dry' : '';
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
  const logged = readJson(`bets${sfx}.json`, []);
  const state = readJson(`state${sfx}.json`, { placed: [] });
  const ids = new Set(logged.map((b) => b.betId).filter(Boolean));
  const older = (state.placed || []).filter((p) => !p.betId || !ids.has(p.betId)).map((p) => ({
    placedAt: p.at, betId: p.betId, book: p.book, event: p.event, market: p.market, selection: p.selection,
    line: p.line ?? null, sentOdds: p.odds, confirmedOdds: null, fairOdds: p.fair, ev: p.ev, stake: p.stake,
    live: null, clv: null, fromState: true,
  }));
  const results = makeResults(dir, { dryRun }).read();
  return [...older, ...logged]
    .filter((b) => b.placedAt && Number.isFinite(Date.parse(b.placedAt)))
    .sort((a, b) => Date.parse(a.placedAt) - Date.parse(b.placedAt))
    .map((b) => {
      const key = betKey(b);
      const r = results[key];
      const odds = b.confirmedOdds ?? b.sentOdds;
      const stake = Number(b.stake) || 0;
      return {
        key, placedAt: b.placedAt, book: b.book, event: b.event, market: b.market, selection: b.selection, line: b.line,
        live: b.live, odds, stake, ev: b.ev ?? null, clv: b.clv ?? null,
        // Expected profit: what the bet is worth on average at the fair price we had.
        expected: Number.isFinite(b.ev) ? stake * b.ev / 100 : null,
        result: r?.result || null, resultSource: r?.source || null, settledAt: r?.settledAt || null,
        profit: r ? profitOf({ result: r.result, stake, odds, payout: r.payout }) : null,
      };
    });
}
