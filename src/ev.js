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

/**
 * EV % at `toOdds`, given the EV % at `fromOdds` against the same fair price (EV scales with the payout).
 * Used to show EV at the price the book accepted when the bet was checked at another price.
 */
export function evMovedTo(ev, fromOdds, toOdds) {
  const f = Number(fromOdds), t = Number(toOdds);
  if (!Number.isFinite(ev) || !Number.isFinite(f) || !Number.isFinite(t) || f === 0 || t === 0) return ev;
  if (f === t) return ev;
  return ((1 + ev / 100) * americanToDecimal(t) / americanToDecimal(f) - 1) * 100;
}
