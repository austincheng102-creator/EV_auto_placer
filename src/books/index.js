import { makeTemplateBook } from './template.js';
import { makeSimBook } from './sim.js';

export const BOOK_LABELS = { betrivers: 'BetRivers', fanduel: 'FanDuel' };

export function makeBooks(cfg, bridge, dryRun) {
  const out = {};
  for (const name of cfg.books) {
    const label = `${BOOK_LABELS[name] || name}${cfg.region ? ' ' + cfg.region : ''}`;
    out[name] = dryRun ? makeSimBook(name, label) : makeTemplateBook(name, label, cfg[name], bridge);
  }
  return out;
}
