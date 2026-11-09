// Odds conversions and EV math. American odds throughout the UI.
export const americanToDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
export const decimalToAmerican = (d) =>
  d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
export const impliedProb = (a) => 1 / americanToDecimal(a);

/** EV % of betting `odds` when the true (no-vig) price is `fairOdds`. */
export function evPct(odds, fairOdds) {
  return (impliedProb(fairOdds) * americanToDecimal(odds) - 1) * 100;
}

export const fmtAmerican = (a) => (a > 0 ? `+${a}` : `${a}`);
export const fmtPct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
