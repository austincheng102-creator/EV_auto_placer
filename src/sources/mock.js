// Fake Gambit feed for dry runs. Produces a few rows per poll, some +EV, with sharp and soft-book prices
// (Pinnacle, DraftKings, FanDuel, Caesars, sometimes a thin Kalshi price) so every rule has something to check.
import { evPct, impliedProb, decimalToAmerican } from '../ev.js';
import { fairKey } from '../betlog.js';

const EVENTS = [
  ['James Madison Dukes @ Southern Miss Golden Eagles', 'Total', 'total_game_points', 71.5],
  ['Cal Poly Mustangs @ Arizona Wildcats', 'Total', 'total_game_points', 180.5],
  ['Kings @ Lakers', 'Spread', 'spread', -4.5],
  ['Leafs @ Canadiens', 'Moneyline', 'money_line', null],
  ['Kings @ Lakers', 'Points', 'PLAYER_PROP_POINTS', 24.5],
];

/** Both sides of a book with ~4.5% vig around win probability p, nudged by `off` points. */
function twoSided(p, off = 0, vig = 0.045) {
  const q = Math.min(0.97, Math.max(0.03, p + off / 100));
  const a = q * (1 + vig / 2), b = (1 - q) * (1 + vig / 2);
  return { odds: decimalToAmerican(1 / a), oppOdds: decimalToAmerican(1 / b) };
}

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
        const [event, market, marketKey, line] = EVENTS[i % EVENTS.length];
        const side = i % 2 ? 'Under' : 'Over';
        const isProp = marketKey.startsWith('PLAYER_PROP');
        const fairOdds = [110, 131, -114, 150, 185][i % 5];
        const edge = Math.random() < 0.06 ? 25 + Math.random() * 60 : -Math.random() * 30;
        const odds = Math.round(fairOdds + edge);
        const book = cfg.books[i % cfg.books.length];
        const p = impliedProb(fairOdds);
        const isLive = i % 3 !== 0;
        const prices = {
          1014: twoSided(p, Math.random() < 0.7 ? (Math.random() - 0.5) : 0),
          200: twoSided(p, (Math.random() - 0.5) * 6),
          100: twoSided(p, (Math.random() - 0.5) * 6),
          300: twoSided(p, (Math.random() - 0.5) * 6),
        };
        if (Math.random() < 0.3) prices[194] = { ...twoSided(p, -1 - Math.random() * 4, 0.04), liq: 100, oppLiq: 120 };
        rows.push({
          id: `${book}|${event}|${market}|${side}|${line}|${n}|${i}`,
          book, event, league: 'MOCK', market, marketKey, isProp, isLive,
          startDate: isLive ? null : new Date(Date.now() + 2 * 3600e3).toISOString(),
          selection: market === 'Total' ? side : isProp ? `Trae Young ${side}` : 'Home', line,
          odds: Math.abs(odds) < 100 ? 100 : odds, fairOdds, fairProb: p, fairSource: 'PS3838', fairBooks: 8 + (i % 4),
          prices, sharpKey: `${event}|${market}|${side}|${line}`,
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
