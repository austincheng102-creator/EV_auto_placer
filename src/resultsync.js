// Fills results.json from each book's settled bets (My Bets > Settled), through the Chrome
// extension. Used by the running placer and by Show bets (when it opens), so the P&L chart
// catches up even on days you don't bet, and after the app was off when the games ended.
import { makeHardRock } from './books/hardrock.js';
import { makeBetRivers } from './books/betrivers.js';
import { makeFanDuel } from './books/fanduel.js';
import { makeBetMGM } from './books/betmgm.js';
import { makeTheScore } from './books/thescore.js';
import { makeDraftKings } from './books/draftkings.js';
import { makeResults, betKey } from './results.js';
import { BOOK_LABELS } from './books/index.js';

const DAY = 864e5;

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.\s]/g, ' ').split(/\s+/).filter(Boolean);
const STOP = new Set(['the', 'and', 'over', 'under', 'total', 'points', 'game', 'moneyline', 'spread', 'state']);

/**
 * Does a book's settled bet `r` look like our bet `b`? With the book's selection id on both, only
 * an exact id match counts. Without it (bets logged before the id was kept), the side and line must
 * agree: Over/Under the same way and the same number, or a team/player name word in common.
 */
export function sameSelection(b, r) {
  if (b.bookRef && r.selectionId) return String(b.bookRef) === String(r.selectionId);
  const have = words(r.label);
  if (!have.length) return false;
  const mine = words(b.selection);
  const ou = mine.find((w) => w === 'over' || w === 'under');
  if (ou && !have.includes(ou)) return false;
  if (!ou && (have.includes('over') || have.includes('under')) && !/total|over|under/i.test(b.market || '')) return false;
  const nums = have.filter((w) => /^\d+(\.\d+)?$/.test(w)).map(Number);
  if (b.line != null && Number.isFinite(Number(b.line)) && nums.length && !nums.includes(Math.abs(Number(b.line)))) return false;
  const names = mine.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d/.test(w));
  if (!names.length) return !!ou && b.line != null && nums.includes(Math.abs(Number(b.line)));
  return names.some((w) => have.includes(w));
}

/**
 * Our bets logged without the book's bet id (DraftKings: the live-delay decision wasn't seen), matched
 * to the book's settled bets: the same selection (sameSelection), the same stake, placed within 90s.
 * The closest in time wins, and each book bet goes to one of our bets only (`taken` holds the ones
 * already used). A bet with no such match stays unsettled rather than taking another bet's result.
 * @param waiting [[ourId, bet]]   @param all the book's settled bets   @returns results with betId = ourId
 */
export function looseMatch(waiting, all, taken = new Set()) {
  const out = [];
  for (const [id, b] of waiting) {
    const t0 = Date.parse(b.placedAt);
    let best = null, bestGap = Infinity;
    for (const r of all) {
      if (taken.has(String(r.betId)) || !r.placedAt) continue;
      const gap = Math.abs(Date.parse(r.placedAt) - t0);
      if (!(gap < 90e3) || gap >= bestGap) continue;
      if (r.stake != null && Math.abs(r.stake - Number(b.stake)) >= 0.005) continue;
      if (!sameSelection(b, r)) continue;
      best = r; bestGap = gap;
    }
    if (best) { taken.add(String(best.betId)); out.push({ ...best, bookBetId: best.betId, betId: id }); }
  }
  return out;
}

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
    // Live DraftKings bets whose decision wasn't seen are logged as draftkings:waiting-<id>: those are
    // matched by placement time (within 90s) and stake instead (loose).
    { book: 'draftkings', idRe: /^draftkings:(?:waiting-)?([0-9A-Za-z-]+)$/, loose: true, api: books.draftkings?.settled ? books.draftkings : makeDraftKings('draftkings', 'DraftKings', cfg, bridge) },
    { book: 'betmgm', idRe: /^betmgm:([0-9A-Z]{6,})(?: |$)/, api: books.betmgm?.settled ? books.betmgm : makeBetMGM('betmgm', 'BetMGM', cfg, bridge) },
  ];
  const warned = new Set();
  const lastTry = {}, lastOk = {}, toldOld = {}, lastWhere = {};
  let running = false;

  /** Bets per book still waiting for a result (placed within the look-back window). */
  function waitingFor(book, idRe) {
    const have = store.read();
    const since = now() - lookbackMs;
    return bets().filter((b) => b.book === book && idRe.test(b.betId || '') && !have[betKey(b)] && Date.parse(b.placedAt) >= since);
  }
  /** Bets marked by hand that the book's own record hasn't been checked against yet (look-back window). */
  function handMarked(book, idRe) {
    const have = store.read();
    const since = now() - lookbackMs;
    return bets().filter((b) => { const r = have[betKey(b)]; return b.book === book && idRe.test(b.betId || '') && r?.source === 'manual' && !r.bookChecked && Date.parse(b.placedAt) >= since; });
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
        const hand = handMarked(book, idRe);
        if (!waiting.length && !hand.length) continue;
        const t = now();
        if (!force) {
          if (lastOk[book] && t - lastOk[book] < everyMs) continue;
          if (lastTry[book] && t - lastTry[book] < retryMs) continue;
        }
        lastTry[book] = t;
        const byId = new Map(waiting.map((b) => [idRe.exec(b.betId)[1], b]));
        const handById = new Map(hand.map((b) => [idRe.exec(b.betId)[1], b]));
        const label = BOOK_LABELS[book] || book;
        try {
          const all = await read(src, [...waiting, ...hand], new Map([...byId, ...handById]));
          // Results marked by hand, checked against the book's own record: by the book's bet id (the book's
          // result wins), or for bets logged without one by selection, stake and time (flagged if different).
          if (hand.length) {
            const checks = [];
            const taken = new Set();
            for (const r of Object.values(store.read())) if (r?.bookBetId && r.source !== 'manual') taken.add(String(r.bookBetId));
            for (const b of bets()) { const m = b.book === book && idRe.exec(b.betId || ''); if (m && !/waiting-/.test(b.betId)) taken.add(m[1]); }
            for (const r of all) if (handById.has(r.betId) && !/waiting-/.test(handById.get(r.betId).betId)) checks.push({ ...r, key: betKey(handById.get(r.betId)), exact: true, bookBetId: r.betId });
            if (src.loose) {
              const loose = [...handById].filter(([, b]) => /waiting-/.test(b.betId));
              const found = looseMatch(loose, all, taken);
              for (const m of found) checks.push({ ...m, key: betKey(handById.get(m.betId)), exact: false });
              // A day on, still no bet on that selection, stake and time in the book's list: the book has no such bet.
              const oldestRead = Math.min(...all.filter((r) => r.placedAt).map((r) => Date.parse(r.placedAt)));
              for (const [id, b] of loose) {
                if (found.some((m) => m.betId === id) || now() - Date.parse(b.placedAt) <= DAY || !(oldestRead < Date.parse(b.placedAt) - 3600e3)) continue;
                checks.push({ key: betKey(b), exact: false, result: 'not found' });
              }
            }
            if (checks.length) {
              const { replaced, flagged } = store.checkManual(checks);
              if (replaced) log?.warn(`Results: ${replaced} ${label} result${replaced === 1 ? '' : 's'} marked by hand didn't match the book's own record of that bet; the book's result is used now`);
              if (flagged) log?.warn(`Results: ${flagged} ${label} result${flagged === 1 ? '' : 's'} marked by hand differ from the book's matching settled bet; flagged on Show bets`);
            }
          }
          if (!waiting.length) { lastOk[book] = now(); continue; }
          const settled = all.filter((r) => byId.has(r.betId));
          if (src.loose) {
            // Bets with no matching id: find the bet in the book's list by what was bet on (see looseMatch).
            // A book bet already given to another of our bets (now or on an earlier read) is never reused.
            const taken = new Set(settled.map((r) => r.betId));
            for (const r of Object.values(store.read())) if (r?.bookBetId) taken.add(String(r.bookBetId));
            for (const b of bets()) { const m = b.book === book && idRe.exec(b.betId || ''); if (m && !/waiting-/.test(b.betId)) taken.add(m[1]); }
            settled.push(...looseMatch([...byId].filter(([id]) => !settled.some((r) => r.betId === id)), all, taken));
          }
          lastOk[book] = now();
          warned.delete(book);
          const n = settled.length ? store.setMany(settled.map((r) => ({ key: betKey(byId.get(r.betId)), result: r.result, payout: r.payout, odds: r.odds, settledAt: r.settledAt, stake: r.stake ?? null, bookBetId: r.bookBetId ?? r.betId }))) : 0;
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
          // Bets still missing 8h after they were placed: ask the book where they are (once an hour), into debug.log.
          const late = waiting.filter((b) => !got.has(idRe.exec(b.betId)[1]) && t - Date.parse(b.placedAt) > 8 * 3600e3);
          if (late.length && src.api.whereAre && !(lastWhere[book] > t - 3600e3)) {
            lastWhere[book] = t;
            try {
              const lines = await src.api.whereAre(late.slice(0, 30).map((b) => idRe.exec(b.betId)[1]));
              log?.warn(`Results: ${late.length} ${label} bet${late.length === 1 ? '' : 's'} still unsettled 8h+ after placing; where ${label} has them is in debug.log`);
              log?.debug?.(`Results: ${label} unsettled bets: ${lines.join('; ')}`);
            } catch (e) { log?.debug?.(`Results: couldn't look up ${label}'s unsettled bets: ${e.message}`); }
          }
          // DraftKings bets logged as waiting (decision not seen) with no DraftKings bet at all on that
          // selection, stake and time a day later: DraftKings never took them (it declined), so they're
          // marked "not placed" (no profit, no expected profit) instead of staying open forever.
          if (src.loose) {
            const read = all.filter((r) => r.placedAt);
            const oldestRead = Math.min(...read.map((r) => Date.parse(r.placedAt)));
            const gone = waiting.filter((b) => /waiting-/.test(b.betId) && !got.has(idRe.exec(b.betId)[1]) && t - Date.parse(b.placedAt) > DAY
              && oldestRead < Date.parse(b.placedAt) - 3600e3
              && !read.some((r) => Math.abs(Date.parse(r.placedAt) - Date.parse(b.placedAt)) < 90e3 && (r.stake == null || Math.abs(r.stake - Number(b.stake)) < 0.005) && sameSelection(b, r)));
            if (gone.length) {
              const n2 = store.setMany(gone.map((b) => ({ key: betKey(b), result: 'not placed', payout: null, odds: null, settledAt: null })));
              if (n2) log?.info(`Results: ${n2} ${label} bet${n2 === 1 ? '' : 's'} marked not placed (${label} has no such bet; it declined after the live delay)`);
            }
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
