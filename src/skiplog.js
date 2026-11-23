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

function makeCsvLog(file, columns) {
  let pending = [];
  return {
    file,
    record(o) {
      pending.push(columns.map((k) => cell(o[k])).join(','));
      try {
        const head = fs.existsSync(file) ? '' : columns.join(',') + '\n';
        fs.appendFileSync(file, head + pending.join('\n') + '\n');
        pending = [];
        // Keep it under ~10 MB.
        if (fs.statSync(file).size > 10e6) fs.renameSync(file, file.replace(/\.csv$/, '.old.csv'));
      } catch { if (pending.length > 500) pending = pending.slice(-500); }
    },
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
