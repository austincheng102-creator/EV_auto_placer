#!/usr/bin/env node
// Auto +EV placer: poll Gambit -> filter by EV -> re-check live price at the book -> place.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { evPct, fmtAmerican, fmtPct } from './ev.js';
import { log } from './log.js';
import { makeGambitSource } from './sources/gambit.js';
import { arbStats } from './sources/gambit-arbs.js';
import { makeMockSource } from './sources/mock.js';
import { startBridge } from './books/bridge.js';
import { makeBooks, parseBooks, BOOK_LABELS } from './books/index.js';
import { makeResultSync } from './resultsync.js';
import { allBets } from './results.js';
import readline from 'node:readline/promises';
import { appDir } from './paths.js';
import { ensureConfig, writeExtension, extensionChanged } from './setup.js';
import { VERSION } from './version.js';
import embedded from './embedded.js';
import { checkForUpdate, cleanupOld } from './update.js';
import { makeNovig } from './novig.js';
import { makeSessionWatch } from './session.js';
import { seenBooks } from './sources/gambit-evs.js';
import { makeBetLog, parseTime } from './betlog.js';
import { makePriceLog, makeSpreadSkipLog } from './skiplog.js';
import { makePropFunnel } from './propfunnel.js';
import { writeSnapshot, serveReport, openInBrowser } from './report.js';
import { applyFilterDefaults, tooShort, evTooHigh, sharpSpread, liveSharpMissing, makeSharpClock, liveAgeLimit, groupKey, groupTotals, groupRoom, groupClash, isPropBet, playerStats, tooManyStats, playerKey, statKey } from './filters.js';

const root = appDir;
let args = process.argv.slice(2);
// `ev-placer dry` = fake Gambit feed + simulated book, nothing sent anywhere.
if (args[0] === 'dry') args = ['--dry-run', '--source', 'mock', ...args.slice(1)];
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

if (flag('--help') || flag('-h') || args[0] === 'help') {
  console.log(`ev-placer ${VERSION}

  ev-placer              run live (needs config.json filled in)
  ev-placer dry          demo run: fake Gambit feed, simulated book, nothing is sent
  ev-placer init         create config.json and the extension/ folder, then exit
  ev-placer update       check for a new version now, then exit
  ev-placer bets         bet log summary, then open the bets and P&L chart in your browser
                         (--no-open: just write bets.html)

  --min-ev 12            override minimum EV %
  --max-odds 250         skip bets with odds above this (default +250)
  --min-odds -300        skip favorites shorter than this (default -300)
  --max-ev 25            skip anything above this EV % (default 25)
  --pregame-hours 12     pre-game bets only if the game starts within this many hours
  --novig-min-ev 2       Novig must also show at least this EV % (default 2)
  --no-novig             don't require Novig to agree
  --book hardrock        which book to bet today: betrivers or hardrock
  --books betrivers,hardrock   more than one at once
  --config other.json    use a different config file
  --dry-run              simulate the book, never place
  --source mock          use the fake Gambit feed
  --no-update            skip the update check at startup

  Files live in: ${appDir}`);
  process.exit(0);
}
if (flag('--version') || flag('-v')) { console.log(VERSION); process.exit(0); }
// Show bets also fetches settled results from the books, through the Chrome extension,
// unless the placer is already running (it does that itself).
async function fetchResultsWhileOpen() {
  const dry = flag('--dry-run');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(appDir, opt('--config', 'config.json')), 'utf8')); } catch {}
  const every = (cfg.results?.everyMinutes ?? 10) * 60e3;
  if (dry || every <= 0) return;
  const port = cfg.bridgePort || 8765;
  const free = await new Promise((res) => {
    const srv = net.createServer().once('error', () => res(false)).once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '127.0.0.1');
  });
  if (!free) { console.log('The placer is running, so it fills in results itself.'); return; }
  const bridge = startBridge(port, { quiet: true });
  const rs = makeResultSync({ cfg, bridge, root: appDir, log, bets: () => allBets(appDir) });
  const waiting = rs.waitingBooks();
  if (!waiting.length) { await bridge.close(); return; }
  const names = waiting.map((b) => BOOK_LABELS[b]).join(' and ');
  console.log(`Checking ${names} for settled bets (needs Chrome open with the ${names} tab and the EV Placer extension)...`);
  const started = Date.now();
  let told = false;
  /** One check. False while Chrome (extension + book tab) isn't there yet. */
  const tick = async () => {
    if (!bridge.connected() || !waiting.some((b) => bridge.hasTab(b))) {
      if (!told && Date.now() - started > 45e3) { told = true; console.log(`Not connected to Chrome yet. Open Chrome with the ${names} tab; I'll keep trying for a minute, otherwise results fill in next time you run the placer or Show bets.`); }
      return false;
    }
    const n = await rs.sync();
    if (n) { try { writeSnapshot(appDir, {}); } catch {} console.log('Chart updated, it refreshes by itself in a few seconds.'); }
    else console.log('No newly settled bets yet.');
    return true;
  };
  // The extension reconnects within a few seconds (30 at most): check every 3s until it's
  // there (tabs arrive just after the connection). Then let go of the extension's port, so
  // starting the placer while this window is open still works.
  await new Promise((r) => setTimeout(r, 2000));
  while (!(await tick()) && Date.now() - started < 90e3) await new Promise((r) => setTimeout(r, 3000));
  await bridge.close();
}

if (args[0] === 'bets') {
  const bl = makeBetLog(appDir, { dryRun: flag('--dry-run'), log });
  const list = bl.bets();
  for (const b of list.slice(-25)) {
    const conf = b.confirmedOdds == null ? 'book did not report its price' : b.oddsMatch === 'yes' ? 'book confirmed same price' : `BOOK CONFIRMED ${fmtAmerican(b.confirmedOdds)}`;
    const close = b.clv != null ? `close ${fmtAmerican(b.closeFairOdds)} (${b.closeKind}) -> CLV ${fmtPct(b.clv)}` : b.closeKind || 'waiting for close';
    console.log(`${b.placedAt.slice(0, 16).replace('T', ' ')}  ${bl.describe(b)}  fair ${fmtAmerican(b.fairOdds)} ${fmtPct(b.ev)} EV, ${conf}, ${close}`);
  }
  if (list.length > 25) console.log(`(last 25 of ${list.length}, all of them are in ${bl.csvPath})`);
  console.log(bl.summaryLine());
  console.log(`Full log: ${bl.csvPath}`);
  // Chart page: bets over time and P&L, per book. Served locally so results can be marked on it.
  try {
    const snap = writeSnapshot(appDir, { dryRun: flag('--dry-run') });
    if (flag('--no-open')) process.exit(0);
    const { url } = await serveReport(appDir, { dryRun: flag('--dry-run'), port: Number(opt('--port', 8766)), log });
    openInBrowser(url);
    console.log(`\nChart: ${url}  (opened in your browser; mark results there)`);
    console.log(`Keep this window open while you mark results. A read-only copy is saved as ${snap}`);
    await fetchResultsWhileOpen();
    await new Promise(() => {});
  } catch (e) { log.err(`couldn't open the chart page: ${e.message}`); }
  process.exit(0);
}

// Always keep the extension folder and a config.json next to the app.
const extDir = writeExtension();
const { path: cfgPath, created } = ensureConfig(opt('--config', 'config.json'));
if (args[0] === 'init' || created) {
  console.log(`Config:    ${cfgPath}${created ? '  (created, fill in the gambit and betrivers sections)' : ''}`);
  console.log(`Extension: ${extDir}  (chrome://extensions > Developer mode > Load unpacked)`);
  if (args[0] === 'init') process.exit(0);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
// Sections still holding placeholders get the built-in defaults, so updates that add
// real defaults (e.g. the Gambit request) reach configs created by older versions.
{
  const example = JSON.parse(embedded['config.example.json']);
  if (!cfg.gambit || (!cfg.gambit.urls && String(cfg.gambit.url || '').startsWith('PASTE_'))) {
    cfg.gambit = example.gambit;
    cfg.region = example.region;   // early configs guessed Ontario; it's Colorado
  }
}
const dryRun = flag('--dry-run');
if (opt('--min-ev')) cfg.minEvPct = Number(opt('--min-ev'));
// Longest odds we'll bet: anything above this (e.g. +260 when it's 250) is skipped.
// Not set in config.json -> +250. "maxOdds": null turns the cap off.
if (opt('--max-odds')) cfg.maxOdds = Number(opt('--max-odds'));
if (cfg.maxOdds === undefined) cfg.maxOdds = 250;
const tooLong = (odds) => cfg.maxOdds != null && odds > cfg.maxOdds;
// Pre-game bets only when the game starts within this many hours (default 12; null = no limit).
// A pre-game row with no start time is skipped, since we can't tell.
if (opt('--pregame-hours')) cfg.pregameMaxHours = Number(opt('--pregame-hours'));
if (cfg.pregameMaxHours === undefined) cfg.pregameMaxHours = 12;
const tooEarly = (r) => {
  if (r.isLive || cfg.pregameMaxHours == null || r.isLive === undefined) return false;
  const start = parseTime(r.startDate);
  return !Number.isFinite(start) || start - Date.now() > cfg.pregameMaxHours * 3600e3;
};
// Odds floor, EV cap, sharp-book rules and bet groups (src/filters.js). Missing settings get
// the defaults: -300, 25%, sharp books within 3 points, sharp price changed within 5s (live),
// one bet and $1 per group.
if (opt('--min-odds')) cfg.minOdds = Number(opt('--min-odds'));
if (opt('--max-ev')) cfg.maxEvPct = Number(opt('--max-ev'));
applyFilterDefaults(cfg);
// The live timing rule can only see a change as recent as our polls are frequent, so poll at
// least every (limit - 2) seconds while it's on: 3s for the 5s rule.
const pollSeconds = cfg.sharp.liveMaxAgeSec != null
  ? Math.min(cfg.pollSeconds || 6, Math.max(1, cfg.sharp.liveMaxAgeSec - 2)) : (cfg.pollSeconds || 6);
const sharpClock = makeSharpClock(cfg);
if (!cfg.novig) cfg.novig = { required: true, minEvPct: 2, mode: 'gambit' };
if (flag('--no-novig')) cfg.novig.required = false;
if (opt('--novig-min-ev')) cfg.novig.minEvPct = Number(opt('--novig-min-ev'));

// Self-update (packaged app only). If a newer version was installed it is now running
// in this terminal, so this process just waits for it to finish.
cleanupOld();
if (process.env.EV_PLACER_JUST_UPDATED) log.info(`Now running ${process.env.EV_PLACER_JUST_UPDATED}`);
else if (args[0] === 'update' || !flag('--no-update')) {
  if (await checkForUpdate({ cfg, log, force: args[0] === 'update' })) await new Promise(() => {});
  if (args[0] === 'update') process.exit(0);
}

// Which book(s) this run bets: --book / --books win over config.json "books".
// "books": "ask" in config asks at startup.
async function askBook() {
  const names = Object.keys(BOOK_LABELS).filter((b) => b !== 'fanduel');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Which book today?');
  names.forEach((b, i) => console.log(`  ${i + 1}) ${BOOK_LABELS[b]}`));
  const a = (await rl.question('> ')).trim();
  rl.close();
  return names[Number(a) - 1] || a;
}
try {
  const pick = opt('--book') || opt('--books');
  cfg.books = parseBooks(pick || (cfg.books === 'ask' ? await askBook() : cfg.books || 'betrivers'));
  if (!cfg.books.length) throw new Error('no book picked');
} catch (e) { log.err(e.message); process.exit(1); }

const useMock = opt('--source', 'gambit') === 'mock';
// The extension is needed to place bets, and also to read Gambit through your logged-in tab.
const needBridge = !dryRun || (!useMock && (cfg.gambit?.via || 'extension') === 'extension');
const bridge = needBridge ? startBridge(cfg.bridgePort || 8765, { reloadExtension: extensionChanged }) : null;
const source = useMock ? makeMockSource(cfg) : makeGambitSource(cfg, bridge, { root, log });
const books = makeBooks(cfg, bridge, dryRun);
for (const b of Object.values(books)) {
  if (b.ready === false) { log.err(`${b.label}: ${b.notReadyReason}`); process.exit(1); }
}
const novig = makeNovig(cfg); // null = Novig check turned off
// Logged-out alarms and BetRivers keepalive (session.js). Live runs only.
const session = makeSessionWatch({ cfg, bridge: dryRun ? null : bridge, books: dryRun ? {} : books, log, labels: BOOK_LABELS });
const betLog = makeBetLog(root, { dryRun, log });

// Persistent state: what we've already bet and how much today.
const statePath = path.join(root, dryRun ? 'state.dry.json' : 'state.json');
const today = () => new Date().toISOString().slice(0, 10);
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { placed: [], day: today(), staked: 0 };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const cooldown = new Map(); // row.id -> retry-after ms
const COOLDOWN_MS = 5 * 60 * 1000;
// Bets being checked or placed right now, by group. Scanning keeps going while a book takes its
// time (Hard Rock ~10s, BetRivers' live delay), and up to maxInFlight bets run at once, each in a
// different group. Their stake counts toward the daily limit while they're out.
const inflight = new Map(); // book|groupKey -> row
let pendingStake = 0;
const maxInFlight = Math.max(1, Number(cfg.maxInFlight ?? 3));
// After a failed price check, a book whose price check is free (BetRivers: a public read, no bet
// is made) re-checks that bet on every scan for a few minutes, as long as Gambit still lists it
// and it passes every rule, instead of ignoring it for 5 minutes. "recheckWatchMinutes": 0 = off.
const WATCH_MS = Number(cfg.recheckWatchMinutes ?? 5) * 60e3;
const watch = new Map(); // row.id -> { since, sig }
const shown = new Map(); // row.id -> { odds, since }: when our polls first saw Gambit show this price
const priceLog = makePriceLog(root, { dryRun });
const spreadLog = makeSpreadSkipLog(root, { dryRun });
const spreadLogged = new Map(); // row.id -> { at, odds }: last sharp-skips.csv line for that bet
function logSpreadSkip(r, sp) {
  const now = Date.now(), last = spreadLogged.get(r.id);
  if (last && last.odds === r.odds && now - last.at < 5 * 60e3) return;
  spreadLogged.set(r.id, { at: now, odds: r.odds });
  if (spreadLogged.size > 5000) for (const [k, v] of spreadLogged) if (now - v.at > 5 * 60e3) spreadLogged.delete(k);
  const pct = (n) => (sp.probs[n] == null ? null : sp.probs[n] * 100);
  spreadLog.record({
    time: new Date(now).toISOString(), book: r.book, live: r.isLive ? 'live' : 'pre-game', league: r.league,
    event: r.event, market: r.market, selection: r.selection, line: r.line, odds: r.odds, evPct: r.ev,
    spreadPts: sp.spread, pinnacle: pct('pinnacle'), kalshi: pct('kalshi'), polymarket: pct('polymarket'),
    novig: pct('novig'), fanduel: pct('fanduel'), passAt4: sp.spread <= 4 ? 'yes' : 'no', passAt5: sp.spread <= 5 ? 'yes' : 'no',
  });
}
const directWarnAt = {};
const propFunnel = makePropFunnel(cfg, root, { dryRun, log });

// maxBetsPerEvent caps game lines (spreads, totals, moneylines) per game. Player props don't count
// toward it and aren't capped by it: each player + stat is still its own group (one bet, see group).
// "propsInEventCap": true puts props back under the cap.
// Player props: at most maxPropStatsPerPlayer different stats per player per game (default 2), e.g.
// points and rebounds, then steals is skipped. The same stat on both books counts once. null = no limit.
if (cfg.maxPropStatsPerPlayer === undefined) cfg.maxPropStatsPerPlayer = 2;
// Arbitrage-table props carry their own minimum (arbProps.minEvPct); everything else uses minEvPct.
const minEv = (r) => r.minEv ?? cfg.minEvPct;
const inEventCap = (p) => cfg.propsInEventCap === true || !isPropBet(p);
const overEventCap = (r, perEvent) => inEventCap(r) && (perEvent[r.event] || 0) >= (cfg.maxBetsPerEvent ?? Infinity);

/** First rule a prop row fails in this scan (same order as the scan filters in tick()). */
function propStage(r, { groups, perEvent, stats, now }) {
  if (r.direct === 'gone') return 'gone';
  if (!Number.isFinite(r.ev) || r.ev < minEv(r) - 3) return 'evLow';
  if (r.ev < minEv(r)) return 'evNear';
  if (tooLong(r.odds) || tooShort(cfg, r.odds)) return 'odds';
  if (evTooHigh(cfg, r.ev)) return 'evCap';
  if (tooEarly(r)) return 'pregameFar';
  if (liveSharpMissing(cfg, r)) return 'noSharp';
  if (!sharpSpread(cfg, r).ok) return 'sharpSpread';
  const lim = liveAgeLimit(cfg, r);
  if (r.isLive && lim != null && r.prices) { const a = sharpClock.ageSec(r); if (a == null || a > lim) return 'stale'; }
  if (groupRoom(cfg, groups, r) == null) return 'group';
  if ([...inflight.values()].some((f) => groupClash(cfg, r, f))) return 'groupInFlight';
  if ((cooldown.get(r.id) || 0) >= now) return 'cooldown';
  if (overEventCap(r, perEvent)) return 'perEvent';
  if (tooManyStats(cfg, stats, r)) return 'playerStats';
  if (!dryRun && !bridge.hasTab(r.book)) return 'noTab';
  if (novig && !novig.check(r, r.odds).ok) return 'novig';
  return 'dupInScan';
}
const warnedNoRows = new Set();

const selKey = (r) => `${r.book}|${r.event}|${r.market}|${r.selection}`;
const desc = (r) => `${BOOK_LABELS[r.book] || r.book} ${r.market} ${r.selection === r.market ? '' : r.selection + ' '}${r.line ?? ''}`.replace(/\s+/g, ' ').trim();

const fmtNovig = (nv) => `${fmtAmerican(nv.odds)}${nv.oppOdds != null ? `/${fmtAmerican(nv.oppOdds)}` : ''}`;

function stakeFor(quote) {
  let s = cfg.stake.amount;
  if (cfg.stake.capAtMaxStake && quote.maxStake) s = Math.min(s, quote.maxStake);
  return Math.floor(s * 100) / 100;
}

const loudLog = { ...log, quiet: false, flush() {} };
/** Logger for a repeat check of a watched bet that came back the same: kept back unless it gets placed. */
function quietLog() {
  const buf = [];
  const q = { ...log, quiet: true };
  for (const k of ['header', 'bet', 'warn', 'info']) q[k] = (m) => buf.push([k, m]);
  q.flush = () => { for (const [k, m] of buf.splice(0)) log[k](m); };
  return q;
}

const headerText = (row) => {
  const startIn = row.isLive === false ? (parseTime(row.startDate) - Date.now()) / 3600e3 : NaN;
  const was = row.gambitOdds != null && row.gambitOdds !== row.odds ? `, Gambit showed ${fmtAmerican(row.gambitOdds)}` : '';
  return `${desc(row)} ${fmtAmerican(row.odds)} (${fmtPct(row.ev)} EV${was}) — ${row.event}${row.isLive ? ' [live]' : Number.isFinite(startIn) ? ` [pre-game, starts in ${startIn < 1 ? `${Math.max(0, Math.round(startIn * 60))}m` : `${startIn.toFixed(1)}h`}]` : ''}${row.book === 'hardrock' && row.gambitBookId ? ` [Gambit book ${row.gambitBookId}]` : ''}`;
};

// ctx collects what happened, for the price log and for deciding whether to keep watching.
async function tryBet(row, ctx) {
  const book = books[row.book];
  const w = watch.get(row.id);
  let quote;
  try { quote = await book.recheck(row); }
  catch (e) {
    ctx.outcome = 'check error';
    session.bookError(row.book, e.message);
    if (w) log.debug(`${book.label} ${desc(row)}: re-check error: ${e.message}`);
    else { log.header(headerText(row)); log.warn(`${book.label}: re-check error: ${e.message}`); }
    return false;
  }
  ctx.quote = quote; ctx.checkedAt = Date.now();
  if (book.freePriceCheck) ctx.realOdds = quote.odds;
  // A watched bet whose price, line and fair odds haven't changed since its last check stays quiet.
  ctx.sig = `${quote.odds}|${quote.line}|${quote.suspended}|${row.fairOdds}|${row.novigOdds}|${row.novigOppOdds}`;
  ctx.changed = !w || w.sig !== ctx.sig;
  if (w) w.sig = ctx.sig;
  const lg = ctx.lg = ctx.changed ? loudLog : quietLog();
  lg.header(headerText(row) + (w ? ` (checking again, ${Math.round((Date.now() - w.since) / 1000)}s after it failed)` : ''));

  if (!Number.isFinite(quote.odds)) { ctx.outcome = 'no price'; lg.warn(`${book.label}: re-check returned no price — skipped`); return false; }
  if (quote.suspended) { ctx.outcome = 'suspended'; lg.warn(`${book.label}: market suspended — skipped`); return false; }
  if (row.line != null && quote.line != null && quote.line !== row.line) {
    ctx.outcome = 'line moved';
    lg.warn(`${BOOK_LABELS[row.book]}: line moved (Gambit priced ${row.line}, ${book.label} line is now ${quote.line}) — skipped, nothing placed`);
    return false;
  }
  // Price that only just jumped our way (Austin, 2026-11-20): when the book changed its price under
  // freshJump.sec before our scan and the real price shows freshJump.evPts+ more EV than Gambit's copy
  // of it, the jump is likely the game moving before the sharp prices behind "fair" caught up.
  const fj = freshJump(row, quote, ctx);
  if (fj) {
    ctx.outcome = 'fresh jump';
    lg.warn(`${book.label}: price jumped to ${fmtAmerican(quote.odds)} ${fj.sec.toFixed(1)}s ago (${fmtPct(fj.ev)} EV vs ${fmtPct(fj.gambitEv)} at Gambit's ${fmtAmerican(row.gambitOdds ?? row.odds)}), fair price may not have caught up — skipped, nothing placed`);
    return false;
  }
  return placeAt(row, book, quote, ctx);
}

// Config "freshJump": { books, sec, evPts }; false turns it off. Defaults: Hard Rock, 3s, 3 points.
function freshJump(row, quote, ctx) {
  const f = cfg.freshJump === false ? null : { books: ['hardrock'], sec: 3, evPts: 3, ...(cfg.freshJump || {}) };
  if (!f || !f.books.includes(row.book)) return null;
  const at = Date.parse(quote.changedAt);
  if (!Number.isFinite(at)) return null;
  const sec = ((ctx.scanAt ?? Date.now()) - at) / 1000;
  const gambitEv = row.gambitEv ?? row.ev;
  const ev = evPct(quote.odds, row.fairOdds);
  if (sec >= f.sec || !Number.isFinite(gambitEv) || ev - gambitEv < f.evPts) return null;
  return { sec: Math.max(0, sec), ev, gambitEv };
}

// EV, Novig, stake limits, then place. If the book says the price changed and tells us the new
// one, everything is checked again at that price and the bet is sent once more.
async function placeAt(row, book, quote, ctx, retried = false) {
  const lg = ctx.lg;
  if (tooLong(quote.odds)) { ctx.outcome = 'odds above max'; lg.warn(`${book.label}: ${fmtAmerican(quote.odds)} is above the ${fmtAmerican(cfg.maxOdds)} cap — skipped, nothing placed`); return false; }
  if (tooShort(cfg, quote.odds)) { ctx.outcome = 'odds below min'; lg.warn(`${book.label}: ${fmtAmerican(quote.odds)} is shorter than the ${fmtAmerican(cfg.minOdds)} limit — skipped, nothing placed`); return false; }
  const ev = evPct(quote.odds, row.fairOdds);
  ctx.bookEv = ev;
  if (evTooHigh(cfg, ev)) { ctx.outcome = 'EV above cap'; lg.warn(`${book.label}: ${fmtAmerican(quote.odds)} is ${fmtPct(ev)} EV, above the ${cfg.maxEvPct}% cap (likely a stale or wrong price) — skipped, nothing placed`); return false; }
  const tail = `${fmtAmerican(quote.odds)} vs fair ${fmtAmerican(row.fairOdds)} from ${row.fairBooks ?? '?'} book(s) -> ${fmtPct(ev)} EV` +
    (quote.maxStake ? ` (max stake $${quote.maxStake})` : '');
  if (ev < minEv(row)) { ctx.outcome = 'EV too low'; lg.warn(`${book.label}: re-check FAIL: ${tail}`); return false; }
  lg.bet(`${book.label}: re-check OK: ${tail}`);

  // Novig has to agree at the live price too.
  let novigEvPct = null, novigCheck = null;
  if (novig) {
    const nc = novig.check(row, quote.odds);
    if (!nc.ok) {
      ctx.outcome = 'Novig fail';
      lg.warn(nc.nv ? `Novig FAIL: ${fmtAmerican(quote.odds)} vs Novig ${fmtNovig(nc.nv)} -> ${fmtPct(nc.ev)} EV (need ${novig.minEvPct}%) — skipped, nothing placed`
        : 'Novig FAIL: Novig has no usable price for this selection (missing, or its two sides are from different lines) — skipped, nothing placed');
      return false;
    }
    novigEvPct = nc.ev; novigCheck = nc;
    lg.bet(`Novig OK: ${fmtAmerican(quote.odds)} vs Novig ${fmtNovig(nc.nv)} -> ${fmtPct(nc.ev)} EV`);
  }

  // Same game + market (both sides, unless group.bothSides) as earlier bets share the group's bet count and $ cap
  // (per book with group.perBook; the other side stays blocked on every book).
  const room = groupRoom(cfg, groupTotals(state.placed), row);
  if (room == null) { ctx.outcome = 'group full'; lg.warn(`group full: ${cfg.group.maxBets ?? 'any'} bets / $${cfg.group.maxStake ?? 'any'} already on (${row.event}, ${row.market}, ${row.selection}) — skipped`); return false; }
  const stake = Math.floor(Math.min(stakeFor(quote), room) * 100) / 100;
  if (stake <= 0) { ctx.outcome = 'stake 0'; lg.warn('stake is 0 — skipped'); return false; }
  if (cfg.dailyStakeLimit && state.staked + pendingStake + stake > cfg.dailyStakeLimit) {
    ctx.outcome = 'daily limit';
    lg.warn(`daily stake limit $${cfg.dailyStakeLimit} reached — skipped`); return false;
  }
  lg.flush();   // about to bet: show everything, even for a quiet repeat check
  ctx.sent = true; ctx.changed = true;
  pendingStake += stake;
  try {
    const { betId, confirmedOdds, detail } = await book.place(row, stake, quote);
    ctx.outcome = 'placed'; ctx.realOdds = confirmedOdds ?? quote.odds;
    if (detail) lg.debug(`${book.label} ${desc(row)} PLACED — ${detail}`);
    state.placed.push({ at: new Date().toISOString(), key: selKey(row), group: groupKey(row), event: row.event, book: row.book,
      market: row.market, isProp: !!row.isProp, gambitBookId: row.gambitBookId, selection: row.selection, line: row.line, odds: quote.odds, fair: row.fairOdds, ev, novigEv: novigEvPct, stake, betId });
    state.staked += stake; save();
    // Paper trail: what we checked vs what the book says it accepted, plus Gambit's fair odds.
    // Dry runs: the simulated book "confirms" the price we sent.
    betLog.record({ row, quote, stake, betId, confirmedOdds: dryRun ? quote.odds : confirmedOdds, ev, novig: novigCheck, sharp: sharpSpread(cfg, row) });
    lg.ok(`${BOOK_LABELS[row.book]} PLACED $${stake} @ ${fmtAmerican(quote.odds)} (${fmtPct(ev)} EV) bet_id=${betId}${dryRun ? ' [DRY RUN]' : ''}`);
    if (!dryRun) {
      if (confirmedOdds == null) lg.bet(`${book.label} didn't report the accepted price; check bet ${betId} in your bet history (raw reply in debug.log)`);
      else if (confirmedOdds === quote.odds) lg.bet(`${book.label} confirmed ${fmtAmerican(confirmedOdds)}, same as checked. Logged to bets.csv`);
      else lg.warn(`${book.label} CONFIRMED ${fmtAmerican(confirmedOdds)}, NOT the ${fmtAmerican(quote.odds)} we checked: ${fmtPct(evPct(confirmedOdds, row.fairOdds))} EV at that price. Logged to bets.csv`);
    }
    return true;
  } catch (e) {
    if (e.detail) lg.debug(`${book.label} ${desc(row)} — ${e.message}: ${e.detail}`);
    const hasNew = e.newOdds != null && Number.isFinite(e.newOdds);
    // Price moves and pulled markets are routine: one short line, details in debug.lg.
    if (e.priceMoved) {
      ctx.priceMoved = true; ctx.outcome = 'price moved';
      if (hasNew) ctx.realOdds = e.newOdds;
      if (hasNew && !retried) {
        lg.warn(`${book.label}: price moved ${fmtAmerican(quote.odds)} → ${fmtAmerican(e.newOdds)}, checking again`);
        return placeAt(row, book, { ...quote, ...(e.newQuote || {}), odds: e.newOdds }, ctx, true);
      }
      lg.warn(`${book.label}: price moved${hasNew ? ` to ${fmtAmerican(e.newOdds)}` : ''} — skipped, nothing placed`);
      return false;
    }
    if (e.gone) { ctx.outcome = 'no longer offered'; lg.warn(`${book.label}: bet no longer offered — skipped, nothing placed`); return false; }
    ctx.outcome = 'place failed';
    lg.err(`${book.label}: place failed: ${e.message}`);
    session.bookError(row.book, e.message);
    return false;
  } finally { pendingStake -= stake; }
}

/** Scan line part for the arbitrage table: props it listed for our books, and how many passed the reference-book rule. */
function arbText(rows) {
  const a = source.arb;
  if (!a) return '';
  if (a.state.error) return `, arbitrage table: fetch failed (${a.state.error})`;
  const s = arbStats, n = rows.filter((r) => r.arb).length;
  const fails = [s.refsMissing && `${s.refsMissing} fewer than ${a.cfg.minRefs} of DK/FD/CZR`, s.refSpread && `${s.refSpread} DK/FD/CZR more than ${a.cfg.maxSpreadPts} pts apart`].filter(Boolean).join(', ');
  return `, arbitrage table: ${s.ours} ${a.books.map((b) => BOOK_LABELS[b] || b).join('/')} props, ${n} priced off DK/FD/CZR${fails ? ` (${fails})` : ''}`;
}

async function tick() {
  if (state.day !== today()) { state.day = today(); state.staked = 0; save(); }
  let rows;
  try { rows = await source.fetchRows(); session.gambit(null); }
  catch (e) { log.err(`Gambit fetch failed: ${e.message}`); session.gambit(e); return; }
  // Closing line value: follow Gambit's fair price for bets already placed.
  if (source.fairIndex) {
    const closed = betLog.track(source.fairIndex());
    for (const b of closed) {
      if (b.clv == null) log.info(`CLV: ${betLog.describe(b)}: Gambit stopped listing it after we bet, no close to compare`);
      else log.info(`CLV: ${betLog.describe(b)} vs close ${fmtAmerican(b.closeFairOdds)} (${b.closeKind}) -> ${fmtPct(b.clv)}`);
    }
    if (closed.length) log.info(betLog.summaryLine());
  }
  if (novig) {
    try { await novig.refresh(); }
    catch (e) { log.err(`Novig fetch failed: ${e.message} — not placing`); return; }
  }

  rows = rows.filter((r) => books[r.book]);
  const scanAt = Date.now();
  sharpClock.update(rows);
  { const ids = new Set();
    for (const r of rows) { ids.add(r.id); const s = shown.get(r.id); if (!s || s.odds !== r.odds) shown.set(r.id, { odds: r.odds, since: scanAt }); }
    for (const id of shown.keys()) if (!ids.has(id)) shown.delete(id);
    for (const [id, w] of watch) if (scanAt - w.since > WATCH_MS + 60e3) watch.delete(id); }
  // Books that let us read their prices directly (BetRivers): use the real price, not Gambit's copy.
  const direct = {};
  for (const [n, b] of Object.entries(books)) {
    if (!b.livePrices) continue;
    try { direct[n] = await b.livePrices(rows, Math.min(cfg.minEvPct, source.arb?.cfg.minEvPct ?? Infinity)); }
    catch (e) {
      if (!(directWarnAt[n] > Date.now() - 60e3)) { directWarnAt[n] = Date.now(); log.warn(`${b.label}: couldn't read its prices directly (${e.message}), using Gambit's prices for now`); }
    }
  }
  // Gambit rows from other books only count once the book's own price was read.
  rows = rows.filter((r) => !r.shadow || r.direct === true);
  for (const b of Object.keys(books)) {
    if (!warnedNoRows.has(b) && !rows.some((r) => r.book === b)) {
      warnedNoRows.add(b);
      log.warn(`Gambit's feed has no ${BOOK_LABELS[b] || b} rows yet. If this stays, tick ${BOOK_LABELS[b] || b} in Gambit's sportsbook filter and copy the new evs.json link into config.json`);
      if (seenBooks.size) {
        const host = (l) => { try { return new URL(l).hostname; } catch { return String(l).slice(0, 40) || 'no link'; } };
        log.warn(`Gambit sportsbook ids in the feed: ${[...seenBooks].map(([id, l]) => `${id} (${host(l)})`).join(', ')}`);
      }
    }
  }
  const stats = playerStats([...state.placed, ...inflight.values()]);
  const perEvent = {};
  for (const p of [...state.placed, ...inflight.values()]) if (inEventCap(p)) perEvent[p.event] = (perEvent[p.event] || 0) + 1;
  const now = Date.now();
  let farOff = 0;
  const why = { odds: 0, evCap: 0, sharpSpread: 0, noSharp: 0, stale: 0, staleProp: 0, group: 0, playerStats: 0 };
  const drop = (k) => (why[k]++, false);
  const groups = groupTotals(state.placed);
  const ageMax = cfg.sharp.liveMaxAgeSec;
  let ev = rows
    .filter((r) => Number.isFinite(r.ev) && r.ev >= minEv(r))
    .filter((r) => (!tooLong(r.odds) && !tooShort(cfg, r.odds)) || drop('odds'))
    .filter((r) => !evTooHigh(cfg, r.ev) || drop('evCap'))
    .filter((r) => !tooEarly(r) || (farOff++, false))
    .filter((r) => !liveSharpMissing(cfg, r) || drop('noSharp'))
    .filter((r) => { const sp = sharpSpread(cfg, r); if (sp.ok) return true; logSpreadSkip(r, sp); return drop('sharpSpread'); })
    .filter((r) => { const lim = liveAgeLimit(cfg, r); if (!r.isLive || lim == null || !r.prices) return true; const a = sharpClock.ageSec(r); return (a != null && a <= lim) || drop(r.isProp ? 'staleProp' : 'stale'); })
    .filter((r) => groupRoom(cfg, groups, r) != null || drop('group'))
    .filter((r) => ![...inflight.values()].some((f) => groupClash(cfg, r, f)))
    .filter((r) => (cooldown.get(r.id) || 0) < now)   // repeats on one side are capped by the group rule
    .filter((r) => !overEventCap(r, perEvent))
    .filter((r) => !tooManyStats(cfg, stats, r) || drop('playerStats'))
    .filter((r) => dryRun || bridge.hasTab(r.book))
    // New bets first, then ones being watched after a failed price check.
    .sort((a, b) => (watch.has(a.id) - watch.has(b.id)) || b.ev - a.ev);
  const gambitCount = ev.length;
  if (novig) ev = ev.filter((r) => novig.check(r, r.odds).ok);
  const novigDropped = gambitCount - ev.length;
  // One bet per group per scan: keep the first (best-EV new) row of each group. Later scans can add more, up to group.maxBets.
  // Also counts each kept prop's stat, so one scan can't send a player past maxPropStatsPerPlayer.
  { const kept = [];
    ev = ev.filter((r) => {
      if (kept.some((k) => groupClash(cfg, r, k)) || tooManyStats(cfg, stats, r)) return false;
      kept.push(r);
      if (isPropBet(r)) { const k = playerKey(r); if (!stats.has(k)) stats.set(k, new Set()); stats.get(k).add(statKey(r)); }
      return true;
    }); }
  if (propFunnel) {
    const sent = new Set(ev.map((r) => r.id));
    for (const r of rows) if (r.isProp) propFunnel.note(r, sent.has(r.id) ? 'sent' : propStage(r, { groups, perEvent, stats, now }));
    propFunnel.tick();
  }
  const whyText = [
    why.odds && `${why.odds} outside ${cfg.minOdds == null ? 'any' : fmtAmerican(cfg.minOdds)} to ${cfg.maxOdds == null ? 'any' : fmtAmerican(cfg.maxOdds)}`,
    why.evCap && `${why.evCap} above ${cfg.maxEvPct}% EV`,
    why.noSharp && `${why.noSharp} live without the needed sharp book`,
    why.sharpSpread && `${why.sharpSpread} sharp books more than ${cfg.sharp.maxSpreadPts} pts apart`,
    why.stale && `${why.stale} live with no sharp move in the last ${ageMax}s`,
    why.staleProp && `${why.staleProp} live props with no FanDuel move in the last ${cfg.sharp.livePropMaxAgeSec}s`,
    why.group && `${why.group} group already bet`,
    why.playerStats && `${why.playerStats} player already has ${cfg.maxPropStatsPerPlayer} stats bet`,
  ].filter(Boolean).join(', ');

  const nBooks = new Set(rows.map((r) => r.book)).size;
  const directText = Object.entries(direct).filter(([, d]) => d && (d.read || d.gone))
    .map(([n, d]) => `, ${BOOK_LABELS[n]} prices read directly: ${d.read} (${d.moved} moved since Gambit${d.gone ? `, ${d.gone} gone or line changed` : ''}${d.shadowNew ? `, ${d.shadowNew} +EV not listed for ${BOOK_LABELS[n]} on Gambit` : ''})`).join('');
  log.scan(`${ev.length} +EV bets from ${rows.length} rows (${nBooks} book${nBooks === 1 ? '' : 's'})` +
    (novig ? `, ${novigDropped} dropped because Novig doesn't show ${novig.minEvPct}%+` : '') +
    (farOff ? `, ${farOff} pre-game skipped (starts more than ${cfg.pregameMaxHours}h away)` : '') +
    (whyText ? `, skipped: ${whyText}` : '') + directText + arbText(rows), ev.length === 0);
  if (!ev.length) return;
  if (!dryRun && !bridge.connected()) { log.warn('Chrome extension not connected — not placing'); return; }

  // Bets run in the background so the next Gambit poll isn't held up by a slow book.
  const batch = ev.slice(0, Math.max(0, maxInFlight - inflight.size));
  const fresh = batch.filter((r) => !watch.has(r.id));
  if (fresh.length) log.autoev(`Next ${fresh.length}: ${fresh.map((r) => `${desc(r)} ${fmtAmerican(r.odds)} (${fmtPct(r.ev)} EV)`).join(', ')}`);
  for (const r of batch) startBet(r, scanAt);
}

function startBet(row, scanAt) {
  const k = `${row.book}|${groupKey(row)}`;
  const book = books[row.book];
  const ctx = { scanAt };
  inflight.set(k, row);
  tryBet(row, ctx)
    .catch((e) => { ctx.outcome = 'error'; log.err(`${book.label}: ${e.message}`); return false; })
    .then((ok) => {
      inflight.delete(k);
      if (row.isProp) propFunnel?.outcome(row, ctx.outcome);
      const now = Date.now();
      const w = watch.get(row.id);
      if (ok) watch.delete(row.id);
      else if (book.freePriceCheck && WATCH_MS > 0 && ctx.quote && (!ctx.sent || ctx.priceMoved) && (!w || now - w.since < WATCH_MS)) {
        if (!w) watch.set(row.id, { since: now, sig: ctx.sig });
        cooldown.delete(row.id);   // check it again next scan
      } else {
        if (w && !ctx.sent && now - w.since >= WATCH_MS) log.info(`stopped re-checking ${desc(row)} (${row.event}) after ${Math.round(WATCH_MS / 60e3)} min, last ${books[row.book].label} price ${fmtAmerican(ctx.quote?.odds)}`);
        watch.delete(row.id);
        cooldown.set(row.id, now + COOLDOWN_MS);
      }
      if (ctx.changed && ctx.quote) {
        const s = shown.get(row.id);
        const at = parseTime(row.priceAt);
        priceLog.record({
          time: new Date(now).toISOString(), book: row.book, live: row.isLive ? 'live' : 'pre-game', event: row.event,
          market: row.market, selection: row.selection, line: row.line, gambitOdds: row.gambitOdds ?? row.odds, gambitEvPct: row.gambitEv ?? row.ev,
          gambitShownSec: s && s.odds === (row.gambitOdds ?? row.odds) ? (scanAt - s.since) / 1000 : null,
          gambitPriceAgeSec: Number.isFinite(at) ? (scanAt - at) / 1000 : null,
          bookOdds: ctx.realOdds, bookLine: ctx.quote.line,
          bookEvPct: ctx.realOdds != null ? evPct(ctx.realOdds, row.fairOdds) : null, fairOdds: row.fairOdds,
          msScanToCheck: ctx.checkedAt - scanAt,
          bookChangedSec: Number.isFinite(Date.parse(ctx.quote.changedAt)) ? (scanAt - Date.parse(ctx.quote.changedAt)) / 1000 : null,
          source: row.direct === true ? (row.shadow ? `${row.book} (Gambit row from another book)` : row.book) : 'gambit',
          watching: w ? Math.round((now - w.since) / 1000) + 's' : '',
          outcome: ctx.outcome || '',
        });
      }
    });
}

log.info(`${dryRun ? 'DRY RUN — nothing is sent to a sportsbook. ' : ''}books=${cfg.books.join(',')} minEV=${cfg.minEvPct}% novig=${novig ? `>=${novig.minEvPct}% (${novig.mode})` : 'off'} odds=${cfg.minOdds == null ? 'any' : fmtAmerican(cfg.minOdds)}..${cfg.maxOdds == null ? 'any' : fmtAmerican(cfg.maxOdds)} maxEV=${cfg.maxEvPct ?? 'off'}% sharpSpread<=${cfg.sharp.maxSpreadPts ?? 'off'}pts liveSharpAge<=${cfg.sharp.liveMaxAgeSec ?? 'off'}s (props ${cfg.sharp.livePropMaxAgeSec ?? 'off'}s) group=${cfg.group.maxBets ?? 'any'} bet/$${cfg.group.maxStake ?? 'any'} pregame<=${cfg.pregameMaxHours == null ? 'any' : cfg.pregameMaxHours + 'h'} stake=$${cfg.stake.amount} poll=${pollSeconds}s atOnce=${maxInFlight} recheckWatch=${WATCH_MS / 60e3}min`);
if (source.arb) {
  const a = source.arb.cfg;
  log.info(source.arb.books.length
    ? `arbitrage table: player props on ${source.arb.books.map((b) => BOOK_LABELS[b] || b).join(', ')}, fair from ${Object.keys(a.refBooks).join('/')} (${a.minRefs}+ within ${a.maxSpreadPts} pts, ${a.fair}), min EV ${a.minEvPct}%`
    : `arbitrage table: off (none of ${a.books.join(', ')} is in books)`);
}
// Results for the P&L chart: read each book's settled bets (My Bets > Settled) every few
// minutes while a logged bet from that book has no result yet. Works whichever book is being
// bet today, as long as that book's tab is open. "results": {"everyMinutes": 0} turns it off.
const resultsEvery = (cfg.results?.everyMinutes ?? 10) * 60e3;
if (!dryRun && bridge && resultsEvery > 0) {
  const rs = makeResultSync({ cfg, bridge, root, dryRun, log, bets: () => allBets(root, { dryRun }), books });
  setTimeout(rs.sync, 15e3); setInterval(rs.sync, resultsEvery);
}

log.info(`${betLog.summaryLine()} (ev-placer bets for details, file ${path.basename(betLog.csvPath)})`);
// Give the Chrome extension a few seconds to connect before the first scan.
if (bridge) for (let i = 0; i < 20 && !bridge.connected(); i++) await new Promise((r) => setTimeout(r, 250));
if (bridge && !bridge.connected()) log.warn('Chrome extension not connected yet: is Chrome open with the EV Placer extension loaded?');
session.start();
const loop = async () => { await tick(); setTimeout(loop, pollSeconds * 1000); };
loop();
process.on('SIGINT', () => { save(); try { propFunnel?.flush(); } catch {} console.log(); process.exit(0); });
