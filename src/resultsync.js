// Fills results.json from each book's settled bets (My Bets > Settled), through the Chrome
// extension. Used by the running placer (every few minutes) and by Show bets (when it opens),
// so the P&L chart catches up even on days you don't bet.
import { makeHardRock } from './books/hardrock.js';
import { makeBetRivers } from './books/betrivers.js';
import { makeResults, betKey } from './results.js';
import { BOOK_LABELS } from './books/index.js';

/**
 * @param bets   () => the bet log's bets (read fresh each call)
 * @param books  the placer's book objects, if any (reused when they can read results)
 */
export function makeResultSync({ cfg, bridge, root, dryRun = false, log, bets, books = {} }) {
  const store = makeResults(root, { dryRun });
  const sources = [
    { book: 'hardrock', idRe: /^hardrock:(\d+)/, api: books.hardrock?.settled ? books.hardrock : makeHardRock('hardrock', 'Hard Rock Bet', cfg, bridge) },
    { book: 'betrivers', idRe: /^coupon:(\d+)/, api: books.betrivers?.settled ? books.betrivers : makeBetRivers('betrivers', 'BetRivers', cfg, bridge) },
  ];
  const warned = new Set();

  /** Bets per book still waiting for a result. */
  function waitingFor(book, idRe) {
    const have = store.read();
    return bets().filter((b) => b.book === book && idRe.test(b.betId || '') && !have[betKey(b)]);
  }
  const waitingBooks = () => sources.filter((s) => waitingFor(s.book, s.idRe).length).map((s) => s.book);

  /** One pass over every book whose tab is open. Returns how many results were saved. */
  async function sync() {
    let total = 0;
    for (const { book, idRe, api } of sources) {
      if (!bridge?.connected() || !bridge.hasTab(book)) continue;
      const waiting = waitingFor(book, idRe);
      if (!waiting.length) continue;
      const byId = new Map(waiting.map((b) => [idRe.exec(b.betId)[1], b]));
      const from = Math.min(...waiting.map((b) => Date.parse(b.placedAt))) - 864e5;
      const label = BOOK_LABELS[book];
      try {
        const settled = (await api.settled(from)).filter((r) => byId.has(r.betId));
        warned.delete(book);
        if (!settled.length) continue;
        const n = store.setMany(settled.map((r) => ({ key: betKey(byId.get(r.betId)), result: r.result, payout: r.payout, odds: r.odds, settledAt: r.settledAt })));
        if (!n) continue;
        total += n;
        const profit = settled.reduce((s, r) => s + r.payout - (r.stake ?? byId.get(r.betId).stake), 0);
        const won = settled.filter((r) => r.result === 'won').length, lost = settled.filter((r) => r.result === 'lost').length;
        const other = settled.length - won - lost;
        log?.info(`Results: ${n} ${label} bet${n === 1 ? '' : 's'} settled (${won} won, ${lost} lost${other ? `, ${other} other` : ''}), ${profit >= 0 ? '+' : '-'}$${Math.abs(profit).toFixed(2)}`);
      } catch (e) {
        if (!warned.has(book)) log?.warn(`Couldn't read ${label}'s settled bets: ${e.message} (will keep trying)`);
        warned.add(book);
      }
    }
    return total;
  }

  return { sync, waitingBooks };
}
