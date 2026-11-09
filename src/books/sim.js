// Simulated book for --dry-run: random small line moves, never sends anything.
export function makeSimBook(name, label) {
  return {
    name, label,
    async recheck(row) {
      await new Promise((r) => setTimeout(r, 300));
      const roll = Math.random();
      if (roll < 0.15 && row.line != null) return { odds: row.odds, line: row.line - 1, maxStake: 100 };
      const drift = roll < 0.35 ? -Math.round(40 + Math.random() * 80) : -Math.round(Math.random() * 5);
      let odds = row.odds + drift;
      if (odds < 100 && odds > -100) odds = odds >= 0 ? -105 : -110;
      return { odds, line: row.line, maxStake: Math.round(50 + Math.random() * 200) };
    },
    async place() {
      return { betId: `dry-run:${Math.random().toString(36).slice(2, 22)}` };
    },
  };
}
