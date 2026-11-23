// Turns Gambit's /api/evs.json response into the app's rows.
// Shape: { evs: [ { event_name, isLive, startDate, league, evOpportunities: [
//   { marketName, source, devig: [{method, winProbability}], bet: { id, odds, sportsbook_id,
//     selection, selection_line, points, player_name, comparableBets[], opposingBets[] } } ] } ] }
import { americanToDecimal, decimalToAmerican } from '../ev.js';
import { fairKey } from '../betlog.js';
import { betmgmRef } from '../books/betmgm.js';

// Gambit sportsbook ids -> our book names.
// Hard Rock: Gambit lists it as 850, 851, 1008 and 1016. 851 is Colorado (its bets were accepted
// in CO; 850/1008 came back UNAVAILABLE), so that's the default.
// BetMGM: Gambit has 400 (BetMGM) and 1001 (BetMGM MI); 400 is the default.
export const DEFAULT_BOOK_IDS = { betrivers: 1004, fanduel: 100, hardrock: 851, betmgm: 400 };
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
  for (const [n, set] of Object.entries(detectedIds)) if (g.bookIds?.[n] == null && DEFAULT_BOOK_IDS[n] == null) add(n, [...set]);
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

/** BetMGM link: fixture, market and option ids (bookRef = option id, so rows can be told apart). */
function betmgmRefs(link) {
  const r = betmgmRef(link);
  return r.optionId ? { ...r, bookRef: r.optionId } : {};
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

/**
 * `fairOut` (optional Map) collects Gambit's fair price for every selection in the response,
 * from any book, keyed by fairKey (event|market|selection|line). Used for closing line value.
 */
export function evsToRows(json, g = {}, fairOut = null, { shadow = [] } = {}) {
  detectBookIds(json);
  const nameById = {};
  const idLists = bookIdLists(g);
  for (const [n, list] of Object.entries(idLists)) for (const id of list) nameById[id] = n;
  const rows = [];
  // "Shadow" rows: a selection Gambit lists for another book, where a book we bet (BetRivers)
  // also has a price. Gambit's copy of that price may be old, so these only count once the
  // book's real price has been read (books/betrivers.js livePrices); Gambit gives the fair price.
  const shadows = [];
  const shadowIds = new Map(shadow.flatMap((n) => (idLists[n] || []).map((id) => [id, n])));
  for (const ev of json?.evs || []) {
    for (const op of ev.evOpportunities || []) {
      const b = op.bet || {};
      const book = nameById[b.sportsbook_id];
      if (!book && !fairOut) continue;                    // a book we don't bet
      const p = fairProb(op.devig, g.devigMethod || 'worst');
      if (p == null || p >= 1) continue;
      const own = (b.comparableBets || []).find((c) => c.sportsbook_id === b.sportsbook_id);
      const link = own?.desktop_link || own?.mobile_link || '';
      const refs = book === 'betrivers' ? kambiRef(link) : book === 'fanduel' ? fanduelRef(link) : book === 'hardrock' ? hardrockRef(link) : book === 'betmgm' ? betmgmRefs(link) : {};
      const novig = (b.comparableBets || []).find((c) => c.sportsbook_id === NOVIG_ID);
      const novigOpp = (b.opposingBets || []).find((c) => c.sportsbook_id === NOVIG_ID);
      const isTotal = /total|PLAYER_PROP/i.test(op.marketName);
      const side = cap(b.selection_line || (isTotal ? b.selection : ''));
      const selection = b.player_name ? `${b.player_name} ${side}`.trim() : isTotal ? side : b.selection;
      const line = /money_line/.test(op.marketName) ? null : Number(b.points ?? b.selection_points);
      if (fairOut) {
        // Same selection listed under several books: prefer the row for a book we bet, else the
        // lowest fair probability (the less flattering close).
        const k = fairKey({ event: ev.event_name, marketKey: op.marketName, selection, line });
        const had = fairOut.get(k), own = !!book;
        if (!had || (own && !had.own) || (own === had.own && p < had.prob)) fairOut.set(k, { prob: p, isLive: !!ev.isLive, own });
      }
      if (!book && !shadowIds.size) continue;
      const fairOdds = decimalToAmerican(1 / p);
      // Every book's price for this selection (odds) and the other side (oppOdds), by Gambit id.
      // Used by the sharp-book rules in filters.js.
      const prices = {};
      for (const c of b.comparableBets || []) if (prices[c.sportsbook_id]?.odds == null) (prices[c.sportsbook_id] ||= {}).odds = Number(c.odds);
      for (const c of b.opposingBets || []) if (prices[c.sportsbook_id]?.oppOdds == null) (prices[c.sportsbook_id] ||= {}).oppOdds = Number(c.odds);
      const base = {
        event: ev.event_name, league: ev.league, isLive: !!ev.isLive, startDate: ev.startDate,
        market: prettyMarket(op.marketName), marketKey: op.marketName, selection, line,
        odds: Number(b.odds), fairOdds, fairProb: p,
        devig: Object.fromEntries((op.devig || []).filter((d) => d.method).map((d) => [d.method, d.winProbability])), ev: (p * americanToDecimal(Number(b.odds)) - 1) * 100,
        fairBooks: (b.comparableBets || []).length + (b.opposingBets || []).length,
        fairSource: SOURCE_NAMES[op.source] ?? String(op.source),
        novigOdds: novig?.odds ?? null, novigOppOdds: novigOpp?.odds ?? null,
        isProp: /^PLAYER_PROP/i.test(op.marketName), prices,
        // When Gambit says it got this book price (for measuring how far behind it is), if it says.
        priceAt: b.updated_at ?? b.created_at ?? own?.updated_at ?? own?.created_at ?? null,
        sharpKey: fairKey({ event: ev.event_name, marketKey: op.marketName, selection, line }),
      };
      if (book) rows.push({ ...base, id: b.id, book, gambitBookId: b.sportsbook_id, link, ...refs });
      for (const c of b.comparableBets || []) {
        const sb = shadowIds.get(c.sportsbook_id);
        if (!sb || sb === book || !Number.isFinite(Number(c.odds))) continue;
        const l = c.desktop_link || c.mobile_link || '';
        const r = sb === 'betrivers' ? kambiRef(l) : sb === 'hardrock' ? hardrockRef(l) : sb === 'betmgm' ? betmgmRefs(l) : {};
        if (!r.bookRef) continue;
        const odds = Number(c.odds);
        shadows.push({ ...base, id: `${sb}:${r.bookRef}`, book: sb, gambitBookId: c.sportsbook_id, shadow: true,
          odds, ev: (p * americanToDecimal(odds) - 1) * 100, priceAt: c.updated_at ?? c.created_at ?? null, link: l, ...r });
      }
    }
  }
  // A selection Gambit already lists for that book keeps its own row.
  const have = new Set(rows.map((r) => `${r.book}|${r.bookRef}`));
  for (const r of shadows) { const k = `${r.book}|${r.bookRef}`; if (!have.has(k)) { have.add(k); rows.push(r); } }
  return rows;
}

/** The row fields that come from the event and the bet itself (used for arbs.json rows). */
export function rowParts(ev, op, b, book) {
  const own = (b.comparableBets || []).find((c) => c.sportsbook_id === b.sportsbook_id);
  const link = b.desktop_link || b.mobile_link || own?.desktop_link || own?.mobile_link || '';
  const refs = book === 'betrivers' ? kambiRef(link) : book === 'fanduel' ? fanduelRef(link) : book === 'hardrock' ? hardrockRef(link) : book === 'betmgm' ? betmgmRefs(link) : {};
  const isTotal = /total|PLAYER_PROP/i.test(op.marketName);
  const side = cap(b.selection_line || (isTotal ? b.selection : ''));
  const selection = b.player_name ? `${b.player_name} ${side}`.trim() : isTotal ? side : b.selection;
  const line = /money_line/.test(op.marketName) ? null : Number(b.points ?? b.selection_points);
  const novig = (b.comparableBets || []).find((c) => c.sportsbook_id === NOVIG_ID);
  const novigOpp = (b.opposingBets || []).find((c) => c.sportsbook_id === NOVIG_ID);
  return {
    event: ev.event_name, league: ev.league, isLive: !!ev.isLive, startDate: ev.startDate,
    market: prettyMarket(op.marketName), marketKey: op.marketName, selection, line,
    novigOdds: novig?.odds ?? null, novigOppOdds: novigOpp?.odds ?? null,
    priceAt: b.updated_at ?? b.created_at ?? own?.updated_at ?? own?.created_at ?? null,
    link, ...refs,
  };
}
