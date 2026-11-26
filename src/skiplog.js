// Price-check log (prices.csv next to the app): one line each time a book's real price is
// checked against what Gambit showed, so we can see how far behind Gambit's book prices are.
//  - gambitShownSec: how long our polls had already seen Gambit show that exact price
//  - gambitPriceAgeSec: age of the timestamp Gambit attaches to the book's price, if it has one
//  - msScanToCheck: time from the Gambit poll that found the bet to the book's answer
//  - bookChangedSec: how long before that poll the book last changed its price (BetRivers says)
//  - source: gambit (Gambit's copy of the price) or betrivers (read from BetRivers in the scan)
// Repeat checks of a bet being watched only add a line when something changed.
// Excel locks an open csv on Windows: lines are then kept and written on the next try.
import fs from 'node:fs';
import path from 'node:path';

export const PRICE_COLUMNS = ['time', 'book', 'live', 'event', 'market', 'selection', 'line', 'gambitOdds', 'gambitEvPct',
  'gambitShownSec', 'gambitPriceAgeSec', 'bookOdds', 'bookLine', 'bookEvPct', 'fairOdds', 'msScanToCheck', 'bookChangedSec', 'source', 'watching', 'outcome'];

const cell = (v) => {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// keepAll: a full file (10 MB) is kept as <name>.<date-time>.csv instead of replacing the one .old.csv.
function makeCsvLog(file, columns, { keepAll = false } = {}) {
  let pending = [];
  const write = () => {
    if (!pending.length) return;
    try {
      const head = fs.existsSync(file) ? '' : columns.join(',') + '\n';
      fs.appendFileSync(file, head + pending.join('\n') + '\n');
      pending = [];
      // Keep it under ~10 MB.
      if (fs.statSync(file).size > 10e6) fs.renameSync(file, file.replace(/\.csv$/, keepAll ? `.${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv` : '.old.csv'));
    } catch { if (pending.length > 2000) pending = pending.slice(-2000); }
  };
  return {
    file,
    record(o) { pending.push(columns.map((k) => cell(o[k])).join(',')); write(); },
    /** Several lines in one write. */
    recordMany(list) { for (const o of list) pending.push(columns.map((k) => cell(o[k])).join(',')); write(); },
  };
}

export function makePriceLog(dir, { dryRun = false } = {}) {
  return makeCsvLog(path.join(dir, dryRun ? 'prices.dry.csv' : 'prices.csv'), PRICE_COLUMNS);
}

// Sharp-spread skips (sharp-skips.csv): one line when a bet that passed minEvPct, the odds range,
// the EV cap and the pre-game window is skipped because the sharp books' no-vig probabilities are
// more than sharp.maxSpreadPts apart. Each sharp book's no-vig win % is shown, so we can see how
// many would pass at 4 or 5 points. The same bet is logged again only after 5 minutes or when its
// odds change, so the count is close to the number of distinct bets skipped.
export const SPREAD_COLUMNS = ['time', 'book', 'live', 'league', 'event', 'market', 'selection', 'line', 'odds', 'evPct',
  'spreadPts', 'pinnacle', 'kalshi', 'polymarket', 'novig', 'fanduel', 'passAt4', 'passAt5'];

export function makeSpreadSkipLog(dir, { dryRun = false } = {}) {
  return makeCsvLog(path.join(dir, dryRun ? 'sharp-skips.dry.csv' : 'sharp-skips.csv'), SPREAD_COLUMNS);
}

// Bet timing (bet-timing.csv): one line for each bet sent to a book, with where the seconds went.
//  - foundBy: scan (Gambit poll) or fast (the 1s price check of the book's own prices)
//  - findMs: Gambit poll (or fast price read) start -> the bet's price re-check starts
//  - gambitMs / bookPricesMs: of findMs, the Gambit request and the wait for the books' own prices
//  - checkMs: the book's price re-check; rulesMs: re-check answer -> bet sent (our rules)
//  - answerMs: bet sent -> the book's answer (includes the book's own live bet delay)
//  - bookDelaySec: the live bet delay the book says it holds bets for, if it says
//  - retries / totalMs: price-moved re-tries, and poll start -> the last answer
export const TIMING_COLUMNS = ['time', 'book', 'live', 'event', 'market', 'selection', 'line', 'odds', 'outcome', 'foundBy',
  'findMs', 'gambitMs', 'bookPricesMs', 'checkMs', 'rulesMs', 'answerMs', 'bookDelaySec', 'retries', 'totalMs'];

export function makeTimingLog(dir, { dryRun = false } = {}) {
  return makeCsvLog(path.join(dir, dryRun ? 'bet-timing.dry.csv' : 'bet-timing.csv'), TIMING_COLUMNS);
}

// Skipped bets (skipped.csv, Austin 2026-11-26): one line for each bet that reached the minimum EV but was
// skipped for any other reason: a scan rule (sharp books, soft books, groups, caps, timing, ...) or the
// check at the book (price moved, line moved, suspended, Gambit behind, ...). EV-too-low skips aren't in it.
//  - where: scan (our rules on the table's numbers) or book (the check at the book before betting)
//  - reason: short code (same names as props-funnel.csv), detail: what it means / what the book said
// The same bet and reason is written again only after 5 minutes or when its price changes.
export const SKIPPED_COLUMNS = ['time', 'book', 'live', 'feed', 'table', 'league', 'event', 'startDate', 'market', 'selection', 'line',
  'odds', 'tableOdds', 'bookOdds', 'evPct', 'fairOdds', 'fairSetBy', 'where', 'reason', 'detail'];

export function makeSkippedLog(dir, { dryRun = false } = {}) {
  return makeCsvLog(path.join(dir, dryRun ? 'skipped.dry.csv' : 'skipped.csv'), SKIPPED_COLUMNS, { keepAll: true });
}

// Loosened-rules data log (shadow-bets.csv, Austin 2026-11-26): every bet the table shows at shadowLog.minEvPct
// (3%) or more, whatever our rules say, with the numbers behind every rule, so new rules can be built from a few
// weeks of data. It never changes what gets bet. One line per bet (book + game + market + side + line), written
// once the table stops listing it (or after it's been listed 6 hours), with how its fair price moved after:
//  - failedRules: every rule it failed when first seen (each checked on its own, not just the first)
//  - firstSkip: what the bot did with it then (the first rule it failed, or sent), outcome: the book check's last
//    result (placed, price moved, ...)
//  - fair60sOdds / ev60sPct: the fair about a minute later; closeFairOdds / closeEvPct: the last fair seen (CLV)
export const SHADOW_COLUMNS = ['firstSeen', 'lastSeen', 'listedSec', 'book', 'live', 'feed', 'table', 'league', 'event', 'startDate',
  'minToStart', 'kind', 'market', 'selection', 'line', 'odds', 'tableOdds', 'evPct', 'minEvPct', 'maxEvPct', 'fairOdds', 'fairSetBy',
  'sharpAgeSec', 'sharpSpreadPts', 'pinnacle', 'kalshi', 'polymarket', 'novig', 'prophetx', 'pmGapPts',
  'softDraftkings', 'softCaesars', 'softFanduel', 'softPassing', 'pinVsMedianPts', 'pinVsDraftkingsPts', 'pinVsFanduelPts',
  'failedRules', 'firstSkip', 'outcome', 'fair60sOdds', 'ev60sPct', 'closeFairOdds', 'closeEvPct', 'closeOdds'];

export function makeShadowLog(dir, { dryRun = false } = {}) {
  return makeCsvLog(path.join(dir, dryRun ? 'shadow-bets.dry.csv' : 'shadow-bets.csv'), SHADOW_COLUMNS, { keepAll: true });
}
