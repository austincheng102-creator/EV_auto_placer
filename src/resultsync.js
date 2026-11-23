// Fills results.json from each book's settled bets (My Bets > Settled), through the Chrome
// extension. Used by the running placer and by Show bets (when it opens), so the P&L chart
// catches up even on days you don't bet, and after the app was off when the games ended.
import { makeHardRock } from './books/hardrock.js';
import { makeBetRivers } from './books/betrivers.js';
import { makeFanDuel } from './books/fanduel.js';
import { makeBetMGM } from './books/betmgm.js';
import { makeTheScore } from './books/thescore.js';
import { makeResults, betKey } from './results.js';
import { BOOK_LABELS } from './books/index.js';

const DAY = 864e5;

/**
 * Spans [from, to) in `days`-long pieces, newest first. A book that caps how many settled bets
 * one reply holds (Hard Rock's mybets/closed has no paging) still gives us every bet this way.
 */
export function windows(from, to, days = 2) {
  const out = [];
  for (let end = to; end > from; end -= days * DAY) out.push([Math.max(from, end - days * DAY), end]);
  return out;
}

/**
 * @param bets   () => the bet log's bets (read fresh each call)
 * @param books  the placer's book objects, if any (reused when they can read results)
 */
export function makeResultSync({ cfg, bridge, root, dryRun = false, log, bets, books = {}, now = Date.now, sources: srcOverride = null }) {
  const store = makeResults(root, { dryRun });
  const rc = cfg.results || {};
  // Bets older than this are left alone: a bet the book never lists (e.g. one it refused after
  // saying "pending") must not drag every read back to its day forever.
  const lookbackMs = (rc.lookbackDays ?? 14) * DAY;
  const everyMs = (rc.everyMinutes ?? 10) * 60e3;
  const retryMs = (rc.retrySeconds ?? 60) * 1e3;
  const sources = srcOverride || [
    { book: 'hardrock', idRe: /^hardrock:(\d+)/, chunkDays: rc.hardrockWindowDays ?? 2, api: books.hardrock?.settled ? books.hardrock : makeHardRock('hardrock', 'Hard Rock Bet', cfg, bridge) },
    { book: 'betrivers', idRe: /^coupon:(\d+)/, api: books.betrivers?.settled ? books.betrivers : makeBetRivers('betrivers', 'BetRivers', cfg, bridge) },
    { book: 'fanduel', idRe: /^fanduel:(us-[a-z]+:[0-9a-z]+)/, api: books.fanduel?.settled ? books.fanduel : makeFanDuel('fanduel', 'FanDuel', cfg, bridge) },
    { book: 'thescore', idRe: /^thescore:([^ ]+)$/, api: books.thescore?.settled ? books.thescore : makeTheScore('thescore', 'theScore', cfg, bridge) },
    { book: 'betmgm', idRe: /^betmgm:([0-9A-Z]{6,})(?: |$)/, api: books.betmgm?.settled ? books.betmgm : makeBetMGM('betmgm', 'BetMGM', cfg, bridge) },
  ];
  const warned = new Set();
  const lastTry = {}, lastOk = {}, toldOld = {};
  let running = false;

  /** Bets per book still waiting for a result (placed within the look-back window). */
  function waitingFor(book, idRe) {
    const have = store.read();
    const since = now() - lookbackMs;
    return bets().filter((b) => b.book === book && idRe.test(b.betId || '') && !have[betKey(b)] && Date.parse(b.placedAt) >= since);
  }
  const waitingBooks = () => sources.filter((s) => waitingFor(s.book, s.idRe).length).map((s) => s.book);

  /** Read one book's settled bets covering every bet in `byId`. */
  async function read({ api, chunkDays }, waiting, byId) {
    const from = Math.min(...waiting.map((b) => Date.parse(b.placedAt))) - DAY;
    if (!chunkDays) return api.settled(from);
    const found = new Map();
    for (const [a, b] of windows(from, now(), chunkDays)) {
      for (const r of await api.settled(a, b)) found.set(r.betId, r);
      if ([...byId.keys()].every((id) => found.has(id))) break;   // got them all, no need to go further back
    }
    return [...found.values()];
  }

  /**
   * One pass over every book whose tab is open and that has bets waiting. A book is read again
   * every `everyMinutes`; until its first good read since the app started (and after a failed
   * read) it is tried every `retrySeconds` instead, so results catch up within a minute or two
   * of starting the app, even when Chrome or the book tab comes up later. `force` reads now.
   * Returns how many results were saved.
   */
  async function sync({ force = false } = {}) {
    if (running) return 0;
    running = true;
    let total = 0;
    try {
      for (const src of sources) {
        const { book, idRe } = src;
        if (!bridge?.connected() || !bridge.hasTab(book)) continue;
        const waiting = waitingFor(book, idRe);
        if (!waiting.length) continue;
        const t = now();
        if (!force) {
          if (lastOk[book] && t - lastOk[book] < everyMs) continue;
          if (lastTry[book] && t - lastTry[book] < retryMs) continue;
        }
        lastTry[book] = t;
        const byId = new Map(waiting.map((b) => [idRe.exec(b.betId)[1], b]));
        const label = BOOK_LABELS[book] || book;
        try {
          const settled = (await read(src, waiting, byId)).filter((r) => byId.has(r.betId));
          lastOk[book] = now();
          warned.delete(book);
          const n = settled.length ? store.setMany(settled.map((r) => ({ key: betKey(byId.get(r.betId)), result: r.result, payout: r.payout, odds: r.odds, settledAt: r.settledAt }))) : 0;
          if (n) {
            total += n;
            const profit = settled.reduce((s, r) => s + r.payout - (r.stake ?? byId.get(r.betId).stake), 0);
            const won = settled.filter((r) => r.result === 'won').length, lost = settled.filter((r) => r.result === 'lost').length;
            const other = settled.length - won - lost;
            log?.info(`Results: ${n} ${label} bet${n === 1 ? '' : 's'} settled (${won} won, ${lost} lost${other ? `, ${other} other` : ''}), ${profit >= 0 ? '+' : '-'}$${Math.abs(profit).toFixed(2)}`);
          }
          // Say so (once per count) when bets placed over a day ago still aren't in the book's
          // settled list, so a lookup that keeps missing shows in the log.
          const got = new Set(settled.map((r) => r.betId));
          const old = waiting.filter((b) => !got.has(idRe.exec(b.betId)[1]) && t - Date.parse(b.placedAt) > DAY);
          if (old.length && old.length !== toldOld[book]) {
            log?.warn(`Results: ${old.length} ${label} bet${old.length === 1 ? '' : 's'} placed over a day ago still not in ${label}'s settled list (oldest ${old[0].placedAt}, ${old[0].betId})`);
          }
          toldOld[book] = old.length;
        } catch (e) {
          if (!warned.has(book)) log?.warn(`Couldn't read ${label}'s settled bets: ${e.message} (will keep trying)`);
          warned.add(book);
        }
      }
    } finally { running = false; }
    return total;
  }

  return { sync, waitingBooks };
}
