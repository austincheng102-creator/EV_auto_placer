// Fake Gambit feed for dry runs. Produces a few rows per poll, some +EV.
import { evPct, impliedProb } from '../ev.js';
import { fairKey } from '../betlog.js';

const EVENTS = [
  ['James Madison Dukes @ Southern Miss Golden Eagles', 'Total', 71.5],
  ['Cal Poly Mustangs @ Arizona Wildcats', 'Total', 180.5],
  ['Kings @ Lakers', 'Spread', -4.5],
  ['Leafs @ Canadiens', 'Moneyline', null],
];

export function makeMockSource(cfg) {
  let n = 0;
  let fair = new Map();
  return {
    fairIndex: () => fair,
    async fetchRows() {
      n++;
      const rows = [];
      const count = 36 + Math.floor(Math.random() * 6);
      for (let i = 0; i < count; i++) {
        const [event, market, line] = EVENTS[i % EVENTS.length];
        const side = i % 2 ? 'Under' : 'Over';
        const fair = [110, 131, -114, 150, 185][i % 5] * (Math.random() < 0.5 ? 1 : 1);
        const edge = Math.random() < 0.06 ? 25 + Math.random() * 60 : -Math.random() * 30;
        const odds = Math.round(fair + (fair > 0 ? edge : edge));
        const book = cfg.books[i % cfg.books.length];
        rows.push({
          id: `${book}|${event}|${market}|${side}|${line}|${n}|${i}`,
          book, event, market, selection: market === 'Total' ? side : 'Home', line,
          odds: Math.abs(odds) < 100 ? 100 : odds, fairOdds: fair, fairBooks: 8 + (i % 4),
          bookRef: `mock-${n}-${i}`,
        });
      }
      for (const r of rows) {
        r.ev = evPct(r.odds, r.fairOdds);
        // Fake Novig price: usually close to fair, sometimes sharper (so Novig disagrees), sometimes missing.
        const roll = Math.random();
        if (roll > 0.1) r.novigOdds = roll < 0.4 ? r.odds - 4 : Math.round(r.fairOdds + (r.fairOdds > 0 ? 3 : -3));
      }
      // Fair price drifts a little each poll, so dry runs show closing line value moving.
      fair = new Map(rows.map((r) => [fairKey(r), { prob: Math.min(0.95, impliedProb(r.fairOdds) * (1 + (Math.random() - 0.45) * 0.06)), isLive: true }]));
      return rows;
    },
  };
}
