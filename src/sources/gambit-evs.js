// Turns Gambit's /api/evs.json response into the app's rows.
// Shape: { evs: [ { event_name, isLive, startDate, league, evOpportunities: [
//   { marketName, source, devig: [{method, winProbability}], bet: { id, odds, sportsbook_id,
//     selection, selection_line, points, player_name, comparableBets[], opposingBets[] } } ] } ] }
import { americanToDecimal, decimalToAmerican } from '../ev.js';

// Gambit sportsbook ids -> our book names.
export const DEFAULT_BOOK_IDS = { betrivers: 1004, fanduel: 100 };
// Books whose Gambit id we don't know yet: found from their bet links' web address
// (gambit.bookIds in config.json overrides this).
// Gambit's Hard Rock links may be app redirect links (AppsFlyer, ...deep_link_value=betslip/<id>),
// so match "hardrock" anywhere in the link, not just the app.hardrock.bet host.
const LINK_HOSTS = { hardrock: /hard\W?rock|deep_link_value=betslip/i };

/** Every sportsbook id seen in the last Gambit response, with a sample link (for the log). */
export const seenBooks = new Map();

/** Gambit sportsbook ids for LINK_HOSTS books, read from the links in this response.
 *  Gambit lists Hard Rock under several ids (850, 851, 1008, 1016 seen), so collect them all. */
export const detectedIds = {};   // name -> Set of ids, kept across responses
export function detectBookIds(json) {
  for (const ev of json?.evs || []) for (const op of ev.evOpportunities || []) {
    const b = op.bet || {};
    for (const c of [b, ...(b.comparableBets || []), ...(b.opposingBets || [])]) {
      const link = c.desktop_link || c.mobile_link || '';
      if (c.sportsbook_id != null && !seenBooks.get(c.sportsbook_id)) seenBooks.set(c.sportsbook_id, link);
      for (const [name, re] of Object.entries(LINK_HOSTS)) {
        if (c.sportsbook_id != null && re.test(link)) (detectedIds[name] ||= new Set()).add(c.sportsbook_id);
      }
    }
  }
  return Object.fromEntries(Object.entries(detectedIds).map(([n, set]) => [n, [...set]]));
}

/** All Gambit ids for each book: defaults, then detected, then config (number or list). */
export function bookIdLists(g = {}) {
  const out = {};
  const add = (n, v) => { if (v == null) return; out[n] = [...new Set([...(out[n] || []), ...[].concat(v)])]; };
  for (const [n, v] of Object.entries(DEFAULT_BOOK_IDS)) add(n, v);
  for (const [n, set] of Object.entries(detectedIds)) if (g.bookIds?.[n] == null) add(n, [...set]);
  for (const [n, v] of Object.entries(g.bookIds || {})) { if (v != null) out[n] = [].concat(v); }
  return out;
}

const NOVIG_ID = 192;
const SOURCE_NAMES = { 0: 'market', 1014: 'PS3838' };

const MARKETS = {
  money_line: 'Moneyline', money_line_first_half: '1H Moneyline', spread: 'Spread',
  total_game_points: 'Total',
};
const prettyMarket = (m) => MARKETS[m] || String(m).replace(/^PLAYER_PROP_/, '').toLowerCase()
  .replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Kambi (BetRivers) link: ...#event/<eventId>?coupon=single|<outcomeId>|... */
function kambiRef(link) {
  const m = /event\/(\d+)\?coupon=single\|(\d+)/.exec(link || '');
  return m ? { eventRef: m[1], bookRef: m[2] } : {};
}
/** FanDuel link: addToBetslip?marketId=<m>&selectionId=<s> */
function fanduelRef(link) {
  const m = /marketId=([\d.]+)&selectionId=(\d+)/.exec(link || '');
  return m ? { marketRef: m[1], bookRef: m[2] } : {};
}

/** Hard Rock link: app.hardrock.bet/?deep_link_value=betslip/<selectionId> */
function hardrockRef(link) {
  const m = /betslip\/(\d+)/.exec(decodeURIComponent(link || ''));
  return m ? { bookRef: m[1] } : {};
}

/**
 * Fair win probability from Gambit's de-vig methods. "worst" (default) takes the lowest,
 * so a bet only counts as +EV if every method agrees; or name one: Power, Multiplicative,
 * Additive, Shin.
 */
export function fairProb(devig, method = 'worst') {
  const ps = (devig || []).filter((d) => Number.isFinite(d.winProbability) && d.winProbability > 0);
  if (!ps.length) return null;
  if (method === 'worst') return Math.min(...ps.map((d) => d.winProbability));
  const hit = ps.find((d) => d.method.toLowerCase() === String(method).toLowerCase());
  return hit ? hit.winProbability : null;
}

export function evsToRows(json, g = {}) {
  detectBookIds(json);
  const nameById = {};
  for (const [n, list] of Object.entries(bookIdLists(g))) for (const id of list) nameById[id] = n;
  const rows = [];
  for (const ev of json?.evs || []) {
    for (const op of ev.evOpportunities || []) {
      const b = op.bet || {};
      const book = nameById[b.sportsbook_id];
      if (!book) continue;                                // a book we don't bet
      const p = fairProb(op.devig, g.devigMethod || 'worst');
      if (p == null || p >= 1) continue;
      const fairOdds = decimalToAmerican(1 / p);
      const own = (b.comparableBets || []).find((c) => c.sportsbook_id === b.sportsbook_id);
      const link = own?.desktop_link || own?.mobile_link || '';
      const refs = book === 'betrivers' ? kambiRef(link) : book === 'fanduel' ? fanduelRef(link) : book === 'hardrock' ? hardrockRef(link) : {};
      const novig = (b.comparableBets || []).find((c) => c.sportsbook_id === NOVIG_ID);
      const novigOpp = (b.opposingBets || []).find((c) => c.sportsbook_id === NOVIG_ID);
      const isTotal = /total|PLAYER_PROP/i.test(op.marketName);
      const side = cap(b.selection_line || (isTotal ? b.selection : ''));
      const selection = b.player_name ? `${b.player_name} ${side}`.trim() : isTotal ? side : b.selection;
      const line = /money_line/.test(op.marketName) ? null : Number(b.points ?? b.selection_points);
      rows.push({
        id: b.id, book, gambitBookId: b.sportsbook_id, event: ev.event_name, league: ev.league, isLive: !!ev.isLive, startDate: ev.startDate,
        market: prettyMarket(op.marketName), marketKey: op.marketName, selection, line,
        odds: Number(b.odds), fairOdds, fairProb: p, ev: (p * americanToDecimal(Number(b.odds)) - 1) * 100,
        fairBooks: (b.comparableBets || []).length + (b.opposingBets || []).length,
        fairSource: SOURCE_NAMES[op.source] ?? String(op.source),
        novigOdds: novig?.odds ?? null, novigOppOdds: novigOpp?.odds ?? null,
        link, ...refs,
      });
    }
  }
  return rows;
}
