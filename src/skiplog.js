// Price-check log (prices.csv next to the app): one line each time a book's real price is
// checked against what Gambit showed, so we can see how far behind Gambit's book prices are.
//  - gambitShownSec: how long our polls had already seen Gambit show that exact price
//  - gambitPriceAgeSec: age of the timestamp Gambit attaches to the book's price, if it has one
//  - msScanToCheck: time from the Gambit poll that found the bet to the book's answer
// Repeat checks of a bet being watched only add a line when something changed.
// Excel locks an open csv on Windows: lines are then kept and written on the next try.
import fs from 'node:fs';
import path from 'node:path';

export const PRICE_COLUMNS = ['time', 'book', 'live', 'event', 'market', 'selection', 'line', 'gambitOdds', 'gambitEvPct',
  'gambitShownSec', 'gambitPriceAgeSec', 'bookOdds', 'bookLine', 'bookEvPct', 'fairOdds', 'msScanToCheck', 'watching', 'outcome'];

const cell = (v) => {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function makePriceLog(dir, { dryRun = false } = {}) {
  const file = path.join(dir, dryRun ? 'prices.dry.csv' : 'prices.csv');
  let pending = [];
  return {
    file,
    record(o) {
      pending.push(PRICE_COLUMNS.map((k) => cell(o[k])).join(','));
      try {
        const head = fs.existsSync(file) ? '' : PRICE_COLUMNS.join(',') + '\n';
        fs.appendFileSync(file, head + pending.join('\n') + '\n');
        pending = [];
        // Keep it under ~10 MB.
        if (fs.statSync(file).size > 10e6) fs.renameSync(file, file.replace(/\.csv$/, '.old.csv'));
      } catch { if (pending.length > 500) pending = pending.slice(-500); }
    },
  };
}
