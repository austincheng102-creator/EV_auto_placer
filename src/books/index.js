import { makeTemplateBook } from './template.js';
import { makeSimBook } from './sim.js';
import { makeBetRivers } from './betrivers.js';

export const BOOK_LABELS = { betrivers: 'BetRivers', fanduel: 'FanDuel' };

export function makeBooks(cfg, bridge, dryRun) {
  const out = {};
  for (const name of cfg.books) {
    const label = `${BOOK_LABELS[name] || name}${cfg.region ? ' ' + cfg.region : ''}`;
    if (dryRun) out[name] = makeSimBook(name, label);
    else if (name === 'betrivers' && !cfg.betrivers?.place) out[name] = makeBetRivers(name, label, cfg, bridge);  // built-in Kambi
    else out[name] = makeTemplateBook(name, label, cfg[name], bridge);
  }
  return out;
}
