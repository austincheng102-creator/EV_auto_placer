import { makeTemplateBook } from './template.js';
import { makeSimBook } from './sim.js';
import { makeBetRivers } from './betrivers.js';
import { makeHardRock } from './hardrock.js';

export const BOOK_LABELS = { betrivers: 'BetRivers', fanduel: 'FanDuel', hardrock: 'Hard Rock Bet' };

// Names people might type for each book (--book "hard rock", hrb, ...).
const ALIASES = {
  betrivers: 'betrivers', rivers: 'betrivers', br: 'betrivers',
  hardrock: 'hardrock', hardrockbet: 'hardrock', hrb: 'hardrock', hr: 'hardrock',
  fanduel: 'fanduel', fd: 'fanduel',
};

/** "BetRivers, Hard Rock" -> ['betrivers', 'hardrock']. Throws on a name we don't know. */
export function parseBooks(list) {
  const names = (Array.isArray(list) ? list : String(list).split(',')).map((s) => String(s).toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean);
  const out = [];
  for (const n of names) {
    const b = ALIASES[n];
    if (!b) throw new Error(`unknown book "${n}" (use ${Object.keys(BOOK_LABELS).join(', ')})`);
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

export function makeBooks(cfg, bridge, dryRun) {
  const out = {};
  for (const name of cfg.books) {
    const label = `${BOOK_LABELS[name] || name}${cfg.region ? ' ' + cfg.region : ''}`;
    if (dryRun) out[name] = makeSimBook(name, label);
    else if (cfg[name]?.place) out[name] = makeTemplateBook(name, label, cfg[name], bridge);  // request templates from config
    else if (name === 'betrivers') out[name] = makeBetRivers(name, label, cfg, bridge);       // built-in Kambi
    else if (name === 'hardrock') out[name] = makeHardRock(name, label, cfg, bridge);
    else out[name] = makeTemplateBook(name, label, cfg[name], bridge);
  }
  return out;
}
