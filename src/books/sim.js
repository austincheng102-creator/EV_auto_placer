import { evPct } from '../ev.js';

// Simulated book for --dry-run: random small line moves, never sends anything.
export function makeSimBook(name, label) {
  return {
    name, label, freePriceCheck: name === 'betrivers',
    async recheck(row) {
      await new Promise((r) => setTimeout(r, 300));
      const roll = Math.random();
      if (roll < 0.15 && row.line != null) return { odds: row.odds, line: row.line - 1, maxStake: 100 };
      const drift = roll < 0.35 ? -Math.round(40 + Math.random() * 80) : -Math.round(Math.random() * 5);
      let odds = row.odds + drift;
      if (odds < 100 && odds > -100) odds = odds >= 0 ? -105 : -110;
      return { odds, line: row.line, maxStake: Math.round(50 + Math.random() * 200) };
    },
    // Testing the fast price check: EV_SIM_LIVE_PRICES=1 makes the simulated book "read" its own
    // prices (Gambit's price with a small random move), like the real books' livePrices().
    ...(process.env.EV_SIM_LIVE_PRICES ? { async livePrices(rows) {
      const st = { read: 0, moved: 0, gone: 0 };
      for (const r of rows) {
        if (r.book !== name) continue;
        const move = Math.random() < 0.3 ? Math.round(Math.random() * 30) : 0;
        r.gambitOdds = r.odds; r.gambitEv = r.ev; r.direct = true; st.read++;
        if (move) { st.moved++; r.odds = r.odds > 0 ? r.odds + move : Math.min(-101, r.odds + move); }
        r.ev = evPct(r.odds, r.fairOdds);
      }
      return st;
    } } : {}),
    async place() {
      await new Promise((r) => setTimeout(r, 200));
      return { betId: `dry-run:${Math.random().toString(36).slice(2, 22)}` };
    },
  };
}
