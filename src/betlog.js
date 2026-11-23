// Bet log + closing line value (CLV).
//
// Every placed bet is written to bets.json (the record) and bets.csv (same data, opens in
// Excel/Sheets) next to the app, with the price we checked, the price the book confirmed,
// Gambit's fair odds (all four no-vig methods), Novig, and the stake. That lets you check
// any bet against what Gambit showed.
//
// CLV: after placing, the app keeps watching Gambit for the same selection and records the
// last fair price before the game starts (the "close"). CLV % = how much better our price
// was than that closing fair price. Beating the close on average is the standard sign that
// the edge was real. Live bets have no real close, so they use the last fair price Gambit
// showed while the bet was still listed (marked "live, last seen").
import fs from 'node:fs';
import path from 'node:path';
import { americanToDecimal, decimalToAmerican, fmtAmerican, fmtPct } from './ev.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9.+-]/g, '');
/** Same selection across books: event | market | selection | line. */
export const fairKey = (r) => `${norm(r.event)}|${norm(r.marketKey || r.market)}|${norm(r.selection)}|${r.line ?? ''}`;

const toOdds = (p) => (p > 0 && p < 1 ? decimalToAmerican(1 / p) : null);
/** CLV % of a bet at `odds` against a closing fair win probability. */
export const clvPct = (odds, closeProb) => (closeProb * americanToDecimal(odds) - 1) * 100;

// Gambit's startDate may be an ISO string or epoch seconds/ms.
export const parseTime = (t) => {
  if (t == null || t === '') return NaN;
  const n = Number(t);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  return Date.parse(t);
};

// Gambit sportsbook ids -> names, for the "other books' odds" column. Unknown ids show as "book <id>".
export const GAMBIT_BOOK_NAMES = {
  1014: 'Pinnacle', 194: 'Kalshi', 193: 'Polymarket', 1011: 'Polymarket', 192: 'Novig', 100: 'FanDuel',
  200: 'DraftKings', 400: 'BetMGM', 1001: 'BetMGM MI', 365: 'bet365', 300: 'Caesars', 1004: 'BetRivers', 500: 'Kambi',
  850: 'Hard Rock', 851: 'Hard Rock', 1008: 'Hard Rock', 1016: 'Hard Rock', 700: 'theScore', 1005: 'BetParx',
  191: 'ProphetX', 1006: 'Bovada', 800: 'Fliff', 613: 'BetOnline', 385: 'PrizePicks',
};
const SHARP_FIRST = [1014, 194, 193, 1011, 192, 100];
const am = (o) => (Number.isFinite(o) ? fmtAmerican(o) : '?');
const usd = (v) => (Number.isFinite(v) ? `$${Math.round(v)}` : '$?');
/** "Pinnacle -120/+100; Kalshi -125/+105 [$950/$420]; ..." = each book's price on our side / the other side.
 *  [..] = Gambit's $ liquidity on our side / the other side, for books that show one (prediction markets). */
export function otherBooksText(prices, ownId) {
  const ids = Object.keys(prices || {}).map(Number).filter((id) => id !== Number(ownId));
  ids.sort((a, b) => ((SHARP_FIRST.indexOf(a) + 1 || 99) - (SHARP_FIRST.indexOf(b) + 1 || 99)) || a - b);
  return ids.map((id) => {
    const pr = prices[id];
    const liq = pr.liq > 0 || pr.oppLiq > 0 ? ` [${usd(pr.liq)}/${usd(pr.oppLiq)}]` : '';
    return `${GAMBIT_BOOK_NAMES[id] || `book ${id}`} ${am(pr.odds)}/${am(pr.oppOdds)}${liq}`;
  }).join('; ') || null;
}

const LIVE_UNSEEN_MS = 15 * 60 * 1000;      // live bet gone from Gambit this long -> close it
const MAX_TRACK_MS = 36 * 60 * 60 * 1000;    // give up on a close after this long

const COLUMNS = [
  ['placedAt', 'placed at (UTC)'], ['betId', 'bet id'], ['book', 'book'], ['gambitBookId', 'Gambit book id'],
  ['sourceLabel', 'Gambit table'],
  ['league', 'league'], ['event', 'event'], ['live', 'live'], ['startDate', 'game start'],
  ['market', 'market'], ['selection', 'selection'], ['line', 'line'],
  ['gambitOdds', 'Gambit listed odds'], ['sentOdds', 'odds we checked and sent'], ['confirmedOdds', 'book confirmed odds'],
  ['oddsMatch', 'confirmed = sent'], ['fairOdds', 'fair odds used (lowest method)'],
  ['fairPower', 'fair Power'], ['fairMultiplicative', 'fair Multiplicative'], ['fairAdditive', 'fair Additive'], ['fairShin', 'fair Shin'],
  ['fairBooks', 'books behind fair'], ['fairSource', 'fair source'],
  ['otherBooks', "other books' odds (our side/other side) [$ liquidity our side/other side]"], ['sharpNoVig', 'sharp books no-vig win % (arb: reference books)'], ['sharpSpreadPts', 'sharp spread pts (arb: reference books)'],
  ['gambitEv', 'EV at Gambit price %'], ['ev', 'EV at placed price %'],
  ['novigOdds', 'Novig odds'], ['novigOppOdds', 'Novig other side'], ['novigEv', 'Novig EV %'],
  ['stake', 'stake $'], ['maxStake', 'book max stake $'],
  ['closeFairOdds', 'closing fair odds'], ['closeKind', 'close type'], ['closeAt', 'close seen at (UTC)'], ['clv', 'CLV %'],
];
/** Which Gambit table a bet came from: 'arb' (arbitrage table) or 'ev' (+EV table). Bets logged
 *  before this was recorded are all from the +EV table unless they carry the arb flag. */
export const betSource = (b) => (b?.source === 'arb' || b?.source === 'ev' ? b.source : b?.arb ? 'arb' : 'ev');
export const SOURCE_LABELS = { ev: '+EV', arb: 'Arb' };
const cellOf = (b, k) => (k === 'sourceLabel' ? SOURCE_LABELS[betSource(b)] : b[k]);
const csvCell = (v) => {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function makeBetLog(dir, { dryRun = false, log } = {}) {
  const jsonPath = path.join(dir, dryRun ? 'bets.dry.json' : 'bets.json');
  const csvPath = path.join(dir, dryRun ? 'bets.dry.csv' : 'bets.csv');
  let bets = [];
  try { if (fs.existsSync(jsonPath)) bets = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) {
    log?.err(`bets.json unreadable (${e.message}); starting a new one and keeping the old as bets.bad.json`);
    try { fs.renameSync(jsonPath, path.join(dir, 'bets.bad.json')); } catch {}
  }

  function save() {
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(bets, null, 2));
      const lines = [COLUMNS.map(([, h]) => csvCell(h)).join(',')];
      for (const b of bets) lines.push(COLUMNS.map(([k]) => csvCell(cellOf(b, k))).join(','));
      fs.writeFileSync(csvPath, lines.join('\n') + '\n');
    } catch (e) {
      // bets.csv open in Excel on Windows locks it: the JSON still has everything.
      log?.warn(`couldn't write ${path.basename(csvPath)} (${e.code || e.message}); is it open in Excel? It'll be rewritten on the next bet`);
    }
  }

  /** Record a placed bet. Returns the record. */
  function record({ row, quote, stake, betId, confirmedOdds, ev, novig, sharp }) {
    const dv = row.devig || {};
    // Arbitrage-table bets: the books that set the fair price are the reference books (DK/FD/Caesars).
    if (row.arb && row.refProbs) sharp = { probs: row.refProbs, spread: row.refSpread ?? null };
    const b = {
      placedAt: new Date().toISOString(), betId, book: row.book, gambitBookId: row.gambitBookId ?? null,
      // Which Gambit table the bet came from (also shown on the Show bets page).
      source: row.arb ? 'arb' : 'ev',
      league: row.league ?? null, event: row.event, live: !!row.isLive, startDate: row.startDate ?? null,
      market: row.market, marketKey: row.marketKey ?? null, selection: row.selection, line: row.line ?? null,
      gambitOdds: row.odds, sentOdds: quote.odds, confirmedOdds: confirmedOdds ?? null,
      oddsMatch: confirmedOdds == null ? 'not reported' : confirmedOdds === quote.odds ? 'yes' : 'NO',
      fairOdds: row.fairOdds, fairProb: row.fairProb ?? null,
      fairPower: toOdds(dv.Power), fairMultiplicative: toOdds(dv.Multiplicative), fairAdditive: toOdds(dv.Additive), fairShin: toOdds(dv.Shin),
      fairBooks: row.fairBooks ?? null, fairSource: row.fairSource ?? null,
      otherBooks: otherBooksText(row.prices, row.gambitBookId),
      sharpNoVig: sharp?.probs ? Object.entries(sharp.probs).map(([n, p]) => `${n[0].toUpperCase()}${n.slice(1)} ${(p * 100).toFixed(1)}`).join('; ') || null : null,
      sharpSpreadPts: sharp?.spread ?? null,
      gambitEv: row.ev, ev,
      novigOdds: novig?.nv?.odds ?? null, novigOppOdds: novig?.nv?.oppOdds ?? null, novigEv: novig?.ev ?? null,
      stake, maxStake: quote.maxStake ?? null,
      key: fairKey(row),
      // Bets from the arbitrage table close against the same DK/FD/Caesars fair price they were placed on.
      arb: !!row.arb,
      lastFairProb: row.fairProb ?? null, lastSeenAt: new Date().toISOString(), seenAgain: false,
      closeFairOdds: null, closeKind: null, closeAt: null, clv: null,
    };
    bets.push(b);
    save();
    return b;
  }

  const priceOf = (b) => b.confirmedOdds ?? b.sentOdds;
  function close(b, kind) {
    // Never seen again after placing: no close to compare with (don't reuse the price we bet at).
    if (!b.seenAgain) { b.closeKind = 'not seen after placing'; return b; }
    b.closeKind = kind;
    if (b.lastFairProb > 0 && b.lastFairProb < 1) {
      b.closeFairOdds = toOdds(b.lastFairProb);
      b.closeAt = b.lastSeenAt;
      b.clv = clvPct(priceOf(b), b.lastFairProb);
    }
    return b;
  }

  /**
   * Called every poll with Gambit's fair prices for every selection in the feed
   * (fairKey -> {prob, isLive}). Updates open bets and records closes. Bets placed from the
   * arbitrage table follow `arbIndex` instead (its DK/FD/Caesars fair prices).
   * Returns the bets that closed this poll.
   */
  function track(fairIndex, now = Date.now(), arbIndex = null) {
    const closed = [];
    for (const b of bets) {
      if (b.closeKind) continue;
      const start = parseTime(b.startDate);
      const preGame = !b.live && Number.isFinite(start);
      const seen = (b.arb ? arbIndex : fairIndex)?.get(b.key);
      // Pre-game: only prices from before the start count; live: anything while it's listed.
      if (seen && (!preGame || now < start) && (preGame ? !seen.isLive : true)) {
        b.lastFairProb = seen.prob;
        b.lastSeenAt = new Date(now).toISOString();
        b.seenAgain = true;
      }
      const lastSeen = Date.parse(b.lastSeenAt);
      if (preGame && now >= start) closed.push(close(b, 'pre-game close'));
      else if (!preGame && now - lastSeen > LIVE_UNSEEN_MS) closed.push(close(b, b.live ? 'live, last seen' : 'last seen'));
      else if (now - Date.parse(b.placedAt) > MAX_TRACK_MS) closed.push(close(b, 'last seen'));
    }
    if (closed.length) save();
    return closed;
  }

  /** Running CLV average over bets that have a close. */
  function summary() {
    const done = bets.filter((b) => b.clv != null);
    const avg = (xs) => xs.reduce((s, b) => s + b.clv, 0) / xs.length;
    const pre = done.filter((b) => b.closeKind === 'pre-game close');
    return {
      total: bets.length, open: bets.filter((b) => !b.closeKind).length, withClose: done.length,
      avgClv: done.length ? avg(done) : null, beat: done.filter((b) => b.clv > 0).length,
      preGame: pre.length, avgPreGameClv: pre.length ? avg(pre) : null,
      avgEv: bets.length ? bets.reduce((s, b) => s + (b.ev ?? 0), 0) / bets.length : null,
      mismatched: bets.filter((b) => b.oddsMatch === 'NO').length,
    };
  }

  function summaryLine() {
    const s = summary();
    if (!s.total) return 'Bet log: no bets yet';
    let out = `Bet log: ${s.total} bet${s.total === 1 ? '' : 's'}, avg EV at placement ${fmtPct(s.avgEv)}`;
    out += s.withClose
      ? `. CLV ${fmtPct(s.avgClv)} avg over ${s.withClose} (${s.beat} beat the close)` +
        (s.preGame && s.preGame !== s.withClose ? `, pre-game only ${fmtPct(s.avgPreGameClv)} over ${s.preGame}` : '')
      : '. No closing lines yet';
    if (s.open) out += `, ${s.open} waiting for a close`;
    if (s.mismatched) out += `. ${s.mismatched} confirmed at a different price than sent, see bets.csv`;
    return out;
  }

  const describe = (b) => `${b.event}: ${b.market} ${b.selection}${b.line != null ? ` ${b.line}` : ''} @ ${fmtAmerican(priceOf(b))}`;

  return { jsonPath, csvPath, bets: () => bets, record, track, summary, summaryLine, describe, save };
}
