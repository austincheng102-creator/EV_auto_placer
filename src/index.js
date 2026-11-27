#!/usr/bin/env node
// Auto +EV placer: poll Gambit -> filter by EV -> re-check live price at the book -> place.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { evPct, fmtAmerican, fmtPct, decimalToAmerican, americanToDecimal, impliedProb } from './ev.js';
import { log } from './log.js';
import { makeGambitSource } from './sources/gambit.js';
import { arbStats } from './sources/gambit-arbs.js';
import { makeMockSource } from './sources/mock.js';
import { makePropProfessorSource } from './sources/propprofessor.js';
import { startBridge } from './books/bridge.js';
import { makeBooks, parseBooks, BOOK_LABELS, propsOff } from './books/index.js';
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
import { makePriceLog, makeSpreadSkipLog, makeTimingLog, makeSkippedLog, makeShadowLog } from './skiplog.js';
import { makePropFunnel, stageLabels } from './propfunnel.js';
import { writeSnapshot, serveReport, openInBrowser } from './report.js';
import { applyFilterDefaults, tooShort, evTooHigh, maxEvFor, sharpSpread, liveSharpMissing, makeSharpClock, liveAgeLimit, groupKey, groupTotals, groupRoom, groupClash, groupCoolingDown, groupMaxBets, sameEvRepeat, isPropBet, playerStats, tooManyStats, playerKey, statKey, minEvFor, longPropRule, longPropConsensus, fmtLongConsensus, softCheck, fmtSoft, marketCheck, fmtMarket, sharpFair, fairBreakdown, liveEvPropOff, pinnacleOnlyTotal, pmBelowFair, fmtPmBelow, pregamePinnacle, fmtPregamePin, marketKind, pmListed, bookFairProb } from './filters.js';

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
    const n = await rs.sync({ force: true });
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
// longOddsProps (in filters.js) lets player props past the cap (to +400) at a higher min EV (18%),
// when DraftKings or Caesars agree within 5 pts (longPropConsensus).
const tooLong = (odds, row) => cfg.maxOdds != null && odds > cfg.maxOdds && !longPropRule(cfg, row, odds);
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
// up to 3 bets and $3 per group (per book), 60s apart.
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
  const names = Object.keys(BOOK_LABELS);
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

// Where the +EV rows come from: "source" in config.json (or --source): "gambit" (default),
// or "propprofessor". One source per run: the two never share rows, names or prices.
// "mock" is the fake feed for dry runs.
const sourceName = String(opt('--source', cfg.source || 'gambit')).toLowerCase().replace(/[^a-z]/g, '');
const useMock = sourceName === 'mock';
const usePP = sourceName === 'propprofessor';
const useGambit = sourceName === 'gambit';
if (sourceName === 'both') { log.err('"source": "both" was removed: Gambit and PropProfessor now run separately. Use "gambit" or "propprofessor".'); process.exit(1); }
if (!useMock && !['gambit', 'propprofessor'].includes(sourceName)) { log.err(`"source": "${sourceName}" isn't known: use "gambit" or "propprofessor"`); process.exit(1); }
// The extension is needed to place bets, and also to read Gambit / PropProfessor through your logged-in tabs.
const needBridge = !dryRun || usePP || (useGambit && (cfg.gambit?.via || 'extension') === 'extension');
const bridge = needBridge ? startBridge(cfg.bridgePort || 8765, { reloadExtension: extensionChanged,
  hello: { type: 'settings', settings: { gambitAutoLogin: cfg.session?.gambitAutoLogin !== false, fanduelGeoRenew: cfg.session?.fanduelGeoRenew !== false,
    betriversGeoRenew: cfg.session?.betriversGeoRenew !== false, betmgmGeoRenew: cfg.session?.betmgmGeoRenew !== false, betmgmGeoClick: cfg.session?.betmgmGeoClick !== false, betmgmAutoLogin: cfg.session?.betmgmAutoLogin !== false,
    thescoreGeoRenew: cfg.session?.thescoreGeoRenew !== false, thescoreAutoLogin: cfg.session?.thescoreAutoLogin !== false, caesarsGeoRenew: cfg.session?.caesarsGeoRenew !== false, caesarsAutoLogin: cfg.session?.caesarsAutoLogin !== false, draftkingsPlaySpan: cfg.session?.draftkingsPlaySpan !== false, draftkingsGeoRenew: cfg.session?.draftkingsGeoRenew !== false, hardrockGeoRenew: cfg.session?.hardrockGeoRenew !== false } } }) : null;
const gambitSource = useGambit ? makeGambitSource(cfg, bridge, { root, log }) : null;
if (gambitSource) Object.assign(gambitSource, { name: 'gambit', label: 'Gambit' });
const ppSource = usePP ? makePropProfessorSource(cfg, bridge, { root, log }) : null;
const sourceError = (n, e) => (n === 'propprofessor' ? session.propprofessor(e) : session.gambit(e));
const source = useMock ? Object.assign(makeMockSource(cfg), { label: 'mock feed' })
  : gambitSource || ppSource;
// The odds source's name for log lines ("PropProfessor priced 2.5", "Gambit still shows +120").
const feedName = ppSource ? 'PropProfessor' : 'Gambit';
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
// After a failed price check, a book whose price check is free (every book: the check makes no
// bet) re-checks that bet on every scan for a few minutes, as long as Gambit still lists it
// and it passes every rule, instead of ignoring it for 5 minutes. "recheckWatchMinutes": 0 = off.
const WATCH_MS = Number(cfg.recheckWatchMinutes ?? 5) * 60e3;
const watch = new Map(); // row.id -> { since, sig }
const geoSaid = new Map(); // row.id -> when we last said FanDuel's location check is being renewed
const shown = new Map(); // row.id -> { odds, since }: when our polls first saw Gambit show this price
// Prop hold (Austin, 2026-11-26): a player prop (+EV or arb table, Gambit or PropProfessor) above
// propHold.evPct EV (30) that passes every rule isn't bet yet. It has to stay listed for propHold.sec (40)
// seconds; after that, each scan runs every rule again on that scan's fresh row (fair price, sharp
// timing, groups, caps), and one that passes goes to the book re-check and its checks, as usual.
// Once held it waits the full time, even if its EV drops under 30% meanwhile. Dropped when the feed
// stops listing it. Keyed by book + game + market + selection + line, so a new line starts a new hold.
// "propHold": false turns it off.
const holdCfg = cfg.propHold && cfg.propHold.evPct != null ? cfg.propHold : null;
const holdMs = holdCfg ? Math.max(0, Number(holdCfg.sec) || 0) * 1000 : 0;
const held = new Map(); // holdKey -> { since, ev, odds, desc, event, book, result: null | 'passed' | 'failed' }
const holdKey = (r) => `${selKey(r)}|${r.line ?? ''}`;
const overHoldEv = (r, ev = r.ev) => !!holdCfg && isPropBet(r) && Number.isFinite(ev) && ev > Number(holdCfg.evPct);
// Props over the hold EV skip the live timing rule (FanDuel's price changed within livePropMaxAgeSec)
// (Austin, 2026-11-26): the 40s hold and the second check stand in for it. "propHold": {"liveTiming": true}
// puts the rule back for them.
const noLiveTiming = (r) => holdCfg?.liveTiming !== true && overHoldEv(r);
const heldSec = (h, now = Date.now()) => Math.round((now - h.since) / 1000);
/** Starts a hold for a row that just passed every rule above the hold EV. */
function startHold(r, ev = r.ev, odds = r.odds, why = 'passed every rule') {
  const h = { since: Date.now(), ev, odds, desc: desc(r), event: r.event, book: r.book, result: null };
  held.set(holdKey(r), h);
  log.info(`HOLD: ${h.desc} ${fmtAmerican(odds)} (${fmtPct(ev)} EV) — ${r.event}: player prop over ${holdCfg.evPct}% EV, ${why}. Waiting ${holdMs / 1000}s, then every rule and check runs again before it's bet`);
  return h;
}
/**
 * true = this row may go ahead (no hold needed, or its hold is over). false = it's waiting out its hold.
 * Called only for rows that passed every scan rule, so the first call is the "passed the first time" check.
 */
function holdDone(r, now = Date.now()) {
  if (!holdCfg) return true;
  const h = held.get(holdKey(r));
  if (!h) { if (overHoldEv(r)) { startHold(r); return false; } return true; }
  return now - h.since >= holdMs;
}
/** Said when a row whose hold is over is sent to the book (once, again only after it failed in between). */
function holdPassed(r, now = Date.now()) {
  const h = held.get(holdKey(r));
  if (!h || now - h.since < holdMs || h.result === 'passed') return;
  h.result = 'passed';
  log.info(`HOLD over: ${h.desc} ${fmtAmerican(r.odds)} (${fmtPct(r.ev)} EV, was ${fmtPct(h.ev)}) — ${r.event}: listed ${heldSec(h, now)}s, second check PASSED every rule, now checking at ${books[r.book]?.label || r.book}`);
}
/** A held row whose hold is over but that failed the scan rules: said once (again only after it passes in between). */
function holdFailed(h, why, now = Date.now(), r = null) {
  if (h.result === 'failed') return;
  h.result = 'failed';
  log.warn(`HOLD over: ${h.desc}${r ? ` now ${fmtAmerican(r.odds)} (${fmtPct(r.ev)} EV, was ${fmtPct(h.ev)})` : ''} — ${h.event}: listed ${heldSec(h, now)}s, second check FAILED (${why}) — not bet; checked again each scan while it's listed`);
}

const priceLog = makePriceLog(root, { dryRun });
const timingLog = makeTimingLog(root, { dryRun });
// Bets waiting for the first Gambit prices fetched after the book accepted them (bets.json atAccept).
const afterAccept = [];
function checkAfterAccept(rows, tickAt, scanAt) {
  let changed = false;
  for (let i = afterAccept.length - 1; i >= 0; i--) {
    const a = afterAccept[i];
    if (tickAt < a.acceptedAt) {
      if (scanAt - a.acceptedAt > 120e3) { a.rec.atAccept = { none: 'no Gambit prices fetched within 2 min' }; afterAccept.splice(i, 1); changed = true; }
      continue;   // this poll started before the bet was accepted
    }
    const r = rows.find((x) => x.id === a.id);
    a.rec.atAccept = r && r.fairProb > 0 && r.fairProb < 1
      ? { gambitAt: new Date(scanAt).toISOString(), fairProb: r.fairProb, fairOdds: r.fairOdds, ev: evPct(a.odds, r.fairOdds),
          setBy: fairBreakdown(cfg, r).books.filter((b) => b.role === 'fair').map((b) => b.name) }
      : { gambitAt: new Date(scanAt).toISOString(), gone: true };
    afterAccept.splice(i, 1); changed = true;
  }
  if (changed) betLog.save();
}
let lastScan = null;   // the last Gambit scan's rows, for the fast price check
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
// Pinnacle-vs-market skips: one log line per selection and price, at most every 5 minutes.
const marketLogged = new Map();
function logMarketSkip(r, mc) {
  const now = Date.now(), last = marketLogged.get(r.id);
  if (last && last.odds === r.odds && now - last.at < 5 * 60e3) return;
  marketLogged.set(r.id, { at: now, odds: r.odds });
  if (marketLogged.size > 5000) for (const [k, v] of marketLogged) if (now - v.at > 5 * 60e3) marketLogged.delete(k);
  const books = Object.entries(mc.probs).map(([n, p]) => `${n} ${(p * 100).toFixed(1)}`).join(', ');
  log.warn(`Pinnacle off the market — skipped: ${r.book} ${r.event} | ${r.market} | ${r.selection}${r.line != null ? ` ${r.line}` : ''} ${fmtAmerican(r.odds)} (${fmtPct(r.ev)} EV): ${fmtMarket(mc)}, max ${cfg.marketCheck.maxPts} pts [${books}]`);
}
const directWarnAt = {};
const propFunnel = makePropFunnel(cfg, root, { dryRun, log });

// Skipped-bets log (skipped.csv) and loosened-rules data log (shadow-bets.csv), Austin 2026-11-26.
// Both are written after a scan's bets have been sent off (setImmediate), never change what's bet, and a
// problem in them only goes to debug.log. "skippedLog": false / "shadowLog": false turn them off.
const skippedLog = cfg.skippedLog === false ? null : makeSkippedLog(root, { dryRun });
const skippedSeen = new Map(); // row id | reason -> { at, odds }
const shadowCfg = cfg.shadowLog === false ? null : { minEvPct: 3, closeSec: 120, maxListedHours: 6, ...(cfg.shadowLog || {}) };
const shadowLog = shadowCfg ? makeShadowLog(root, { dryRun }) : null;
const shadowOpen = new Map(); // holdKey -> open shadow entry
const tableOf = (r) => (r.arb ? 'arb' : '+EV');
const feedOf = (r) => r.src || (ppSource ? 'propprofessor' : 'gambit');
const fairSetBy = (r) => { try { return fairBreakdown(cfg, r).books.filter((b) => b.role === 'fair').map((b) => b.name).join('/'); } catch { return ''; } };
const pct1 = (p) => (p == null || !Number.isFinite(p) ? null : p * 100);
/** Plain no-vig win % for our side at the first of these Gambit ids with both sides listed. */
const noVigAt = (r, idv) => { for (const id of [].concat(idv ?? []).map(Number)) { const pr = r.prices?.[id]; const p = pr && bookFairProb(pr.odds, pr.oppOdds); if (p != null) return p; } return null; };

function noteSkip(r, where, reason, detail, bookOdds, buf) {
  if (!skippedLog) return;
  const now = Date.now(), k = `${r.id}|${reason}`, last = skippedSeen.get(k), odds = bookOdds ?? r.odds;
  if (last && last.odds === odds && now - last.at < 5 * 60e3) return;
  skippedSeen.set(k, { at: now, odds });
  if (skippedSeen.size > 20000) for (const [kk, v] of skippedSeen) if (now - v.at > 5 * 60e3) skippedSeen.delete(kk);
  const line = {
    time: new Date(now).toISOString(), book: r.book, live: r.isLive ? 'live' : 'pre-game', feed: feedOf(r), table: tableOf(r),
    league: r.league, event: r.event, startDate: r.startDate, market: r.market, selection: r.selection, line: r.line,
    odds: r.odds, tableOdds: r.gambitOdds ?? r.odds, bookOdds: bookOdds ?? null, evPct: r.ev, fairOdds: r.fairOdds, fairSetBy: fairSetBy(r),
    where, reason, detail,
  };
  if (buf) buf.push(line); else skippedLog.record(line);
}

/** What a scan rule saw, for the skipped-bets log. */
function skipDetail(r, st, labels) {
  const base = labels[st] || st;
  try {
    if (st === 'sharpSpread') { const sp = sharpSpread(cfg, r); return `${base}: ${Object.entries(sp.probs).map(([n, p]) => `${n} ${(p * 100).toFixed(1)}`).join(', ')}`; }
    if (st === 'softBooks') return `${base}: ${fmtSoft(softCheck(cfg, r))}`;
    if (st === 'pinnacleOff') return `${base}: ${fmtMarket(marketCheck(cfg, r))}`;
    if (st === 'pmBelow') return `${base}: ${fmtPmBelow(pmBelowFair(cfg, r))}`;
    if (st === 'pregamePinnacle') return `${base}: ${fmtPregamePin(pregamePinnacle(cfg, r))}`;
    if (st === 'longConsensus') return `${base}: ${fmtLongConsensus(longPropConsensus(cfg, r))}`;
    if (st === 'stale') { const a = sharpClock.ageSec(r); return `${base}: ${a == null ? 'no move seen yet' : `last move ${a.toFixed(0)}s ago`}`; }
  } catch { /* the label alone */ }
  return base;
}

/** Every rule a row fails when checked on its own (not just the first), for shadow-bets.csv. */
function failedRules(r) {
  const out = [];
  const t = (k, ok) => { if (!ok) out.push(k); };
  t('minEv', Number.isFinite(r.ev) && r.ev >= minEv(r));
  t('noProps', !(r.isProp && propsOff(cfg, r.book)));
  t('liveEvProps', !liveEvPropOff(cfg, r));
  t('odds', !tooLong(r.odds, r) && !tooShort(cfg, r.odds));
  t('evCap', !evTooHigh(cfg, r.ev, r));
  t('pregameFar', !tooEarly(r));
  t('noSharp', freeLive(r) || r.ppFairFallback || !liveSharpMissing(cfg, r));
  t('sharpSpread', freeLive(r) || sharpSpread(cfg, r).ok);
  t('softBooks', softCheck(cfg, r).ok);
  t('longConsensus', longPropConsensus(cfg, r).ok);
  t('pinnacleOff', marketCheck(cfg, r).ok);
  t('pinnacleOnlyTotal', !pinnacleOnlyTotal(cfg, r));
  t('pmBelow', pmBelowFair(cfg, r).ok);
  t('pregamePinnacle', pregamePinnacle(cfg, r).ok);
  t('stale', !sharpTooOld(r));
  return out;
}

function shadowEntry(r, firstSkip, now) {
  const sp = sharpSpread(cfg, r), sc = softCheck(cfg, r), mc = marketCheck(cfg, r), pm = pmListed(cfg, r);
  const pmc = pmBelowFair(cfg, r);
  const pin = noVigAt(r, cfg.sharp.ids.pinnacle), dk = noVigAt(r, 200), fd = noVigAt(r, 100);
  const worstPm = Object.values(pm).length ? Math.min(...Object.values(pm)) : null;
  const start = parseTime(r.startDate);
  return {
    first: now, lastSeen: now, odds: r.odds, maxEv: r.ev, closeFair: r.fairOdds, closeOdds: r.gambitOdds ?? r.odds, fair60: null, outcome: '',
    line: {
      firstSeen: new Date(now).toISOString(), book: r.book, live: r.isLive ? 'live' : 'pre-game', feed: feedOf(r), table: tableOf(r),
      league: r.league, event: r.event, startDate: r.startDate, minToStart: r.isLive === false && Number.isFinite(start) ? (start - now) / 60e3 : null,
      kind: marketKind(r), market: r.market, selection: r.selection, line: r.line, odds: r.odds, tableOdds: r.gambitOdds ?? r.odds,
      evPct: r.ev, minEvPct: minEv(r), fairOdds: r.fairOdds, fairSetBy: fairSetBy(r), sharpAgeSec: r.isLive ? sharpClock.ageSec(r, now) : null,
      sharpSpreadPts: sp.spread, pinnacle: pct1(pin), kalshi: pct1(pm.kalshi), polymarket: pct1(pm.polymarket), novig: pct1(pm.novig), prophetx: pct1(pm.prophetx),
      pmGapPts: worstPm != null && Number.isFinite(r.fairProb) ? (r.fairProb - worstPm) * 100 : null,
      softDraftkings: sc.evs?.draftkings, softCaesars: sc.evs?.caesars, softFanduel: sc.evs?.fanduel, softFanatics: sc.evs?.fanatics, softPassing: sc.off ? null : sc.pass,
      pinVsMedianPts: mc.gap, pinVsDraftkingsPts: pin != null && dk != null ? (pin - dk) * 100 : null, pinVsFanduelPts: pin != null && fd != null ? (pin - fd) * 100 : null,
      failedRules: failedRules(r).join(';'), firstSkip,
    },
    pmc,
  };
}

function shadowClose(e, out) {
  out.push({ ...e.line, lastSeen: new Date(e.lastSeen).toISOString(), listedSec: Math.round((e.lastSeen - e.first) / 1000),
    maxEvPct: e.maxEv, outcome: e.outcome, fair60sOdds: e.fair60, ev60sPct: e.fair60 != null ? evPct(e.odds, e.fair60) : null,
    closeFairOdds: e.closeFair, closeEvPct: e.closeFair != null ? evPct(e.odds, e.closeFair) : null, closeOdds: e.closeOdds });
}

function shadowScan(rows, sentIds, pk, labels, now) {
  const out = [];
  const byKey = new Map(rows.map((r) => [holdKey(r), r]));
  for (const [k, e] of shadowOpen) {
    const r = byKey.get(k);
    if (r) {
      e.lastSeen = now;
      if (Number.isFinite(r.fairOdds)) e.closeFair = r.fairOdds;
      e.closeOdds = r.gambitOdds ?? r.odds;
      if (Number.isFinite(r.ev) && r.ev > e.maxEv) e.maxEv = r.ev;
      if (e.fair60 == null && now - e.first >= 60e3 && Number.isFinite(r.fairOdds)) e.fair60 = r.fairOdds;
    }
    if ((!r && now - e.lastSeen > shadowCfg.closeSec * 1000) || now - e.first > shadowCfg.maxListedHours * 3600e3) { shadowClose(e, out); shadowOpen.delete(k); }
  }
  for (const r of rows) {
    if (!Number.isFinite(r.ev) || r.ev < shadowCfg.minEvPct) continue;
    const k = holdKey(r);
    if (shadowOpen.has(k)) continue;
    let first = 'sent';
    if (!sentIds.has(r.id)) { const st = Number.isFinite(r.ev) && r.ev >= minEv(r) ? propStage(r, pk) : 'evLow'; first = st === 'evNear' ? 'evLow' : st; }
    shadowOpen.set(k, shadowEntry(r, first, now));
  }
  // Too many open (a very busy board): the oldest are written now.
  if (shadowOpen.size > 20000) for (const [k, e] of shadowOpen) { if (shadowOpen.size <= 15000) break; shadowClose(e, out); shadowOpen.delete(k); }
  if (out.length) shadowLog.recordMany(out);
}
function shadowFlushAll() {
  if (!shadowLog || !shadowOpen.size) return;
  const out = [];
  for (const e of shadowOpen.values()) shadowClose(e, out);
  shadowOpen.clear();
  shadowLog.recordMany(out);
}

/** After a scan's bets are sent: the skipped-bets log and the loosened-rules data log. */
function afterScan(rows, ev, batch, pk, noFairRows) {
  const now = Date.now();
  const sentIds = new Set(batch.map((r) => r.id));
  const labels = stageLabels(cfg);
  if (skippedLog) {
    const buf = [];
    const picked = new Set(ev.map((r) => r.id));
    for (const r of noFairRows) if (Number.isFinite(r.ev) && r.ev >= minEv(r)) noteSkip(r, 'scan', 'noSharpFair', 'no sharp price for the fair (Pinnacle, or a counted Kalshi/Polymarket/Novig/ProphetX price)', null, buf);
    for (const r of rows) {
      if (sentIds.has(r.id) || !Number.isFinite(r.ev) || r.ev < minEv(r)) continue;
      if (picked.has(r.id)) { noteSkip(r, 'scan', 'notSent', `passed every rule, not sent this scan (${maxInFlight} bets at once already, or Chrome not connected)`, null, buf); continue; }
      const st = propStage(r, pk);
      if (st === 'evLow' || st === 'evNear' || st === 'gone') continue;
      noteSkip(r, 'scan', st, skipDetail(r, st, labels), null, buf);
    }
    if (buf.length) skippedLog.recordMany(buf);
  }
  if (shadowLog) shadowScan(rows, sentIds, pk, labels, now);
}

// maxBetsPerEvent caps game lines (spreads, totals, moneylines) per game. Player props don't count
// toward it and aren't capped by it: each player + stat is still its own group (one bet, see group).
// "propsInEventCap": true puts props back under the cap.
// Player props: at most maxPropStatsPerPlayer different stats per player per game (default 2), e.g.
// points and rebounds, then steals is skipped. The same stat on both books counts once. null = no limit.
if (cfg.maxPropStatsPerPlayer === undefined) cfg.maxPropStatsPerPlayer = 2;
// Live player props: at most liveMaxPropsPerEvent per game across all books (Austin 2026-11-25: 6).
// Props after the 6th in one live game went 87 W vs 112 expected (-$36 vs +$26); the first 6 were on model.
// Pre-game props don't count toward it. null = no limit.
if (cfg.liveMaxPropsPerEvent === undefined) cfg.liveMaxPropsPerEvent = 6;
// Arbitrage-table props carry their own minimum (arbProps.minEvPct); everything else uses minEvPct.
// Pre-game bets (+EV and arb table, any source) use pregameMinEvPct instead (Austin 2026-11-25: 6%,
// live stays minEvPct). null = pre-game uses the same minimum as live.
// Long odds can need more (minEvByOdds: +201 to +250 needs 12%), checked at the price being bet.
if (cfg.pregameMinEvPct === undefined) cfg.pregameMinEvPct = 6;
const pregameMinEv = cfg.pregameMinEvPct == null || !Number.isFinite(Number(cfg.pregameMinEvPct)) ? null : Number(cfg.pregameMinEvPct);
const minEv = (r, odds = r.odds) => minEvFor(cfg, r.isLive === false && pregameMinEv != null ? pregameMinEv : (r.minEv ?? cfg.minEvPct), odds, r);
// "fanduel": {"sharpRules": false}: that book skips the sharp-book rules (sharp book needed live,
// sharp move in the last few seconds, sharp books within N points). Price re-check, odds range,
// max EV, groups and the daily limit still apply.
const freeLive = (r) => cfg[r.book]?.sharpRules === false;
// A PropProfessor game line with no Pinnacle and no valid prediction-market price: priced off
// PropProfessor's own fair (Austin, 2026-11-24). Not props (they need FanDuel) and not arb-table rows.
const ppFallbackOk = (r) => r.src === 'propprofessor' && cfg.propprofessor?.fairFallback !== false
  && !r.isProp && !r.arb && Number.isFinite(r.fairProb) && r.fairProb > 0 && r.fairProb < 1;
const inEventCap = (p) => cfg.propsInEventCap === true || !isPropBet(p);
const overEventCap = (r, perEvent) => inEventCap(r) && (perEvent[r.event] || 0) >= (cfg.maxBetsPerEvent ?? Infinity);
// Placed bets from before this rule have no isLive: counted as live (safe side).
const isLiveProp = (p) => isPropBet(p) && p.isLive !== false;
const livePropCounts = (list) => { const n = {}; for (const p of list) if (isLiveProp(p)) n[p.event] = (n[p.event] || 0) + 1; return n; };
const overLivePropCap = (r, liveProps) => r.isLive === true && isPropBet(r) && cfg.liveMaxPropsPerEvent != null
  && (liveProps[r.event] || 0) >= Number(cfg.liveMaxPropsPerEvent);

/** First rule a row fails in this scan (same order as the scan filters in pickBets()). Used for props and the skipped-bets log. */
function propStage(r, { groups, perEvent, liveProps, stats, now }) {
  if (r.direct === 'gone') return 'gone';
  if (!Number.isFinite(r.ev) || r.ev < minEv(r) - 3) return 'evLow';
  if (r.ev < minEv(r)) return 'evNear';
  if (r.isProp && propsOff(cfg, r.book)) return 'noProps';
  if (liveEvPropOff(cfg, r)) return 'liveEvProps';
  if (tooLong(r.odds, r) || tooShort(cfg, r.odds)) return 'odds';
  if (evTooHigh(cfg, r.ev, r)) return 'evCap';
  if (tooEarly(r)) return 'pregameFar';
  if (!freeLive(r) && !r.ppFairFallback && liveSharpMissing(cfg, r)) return 'noSharp';
  if (!freeLive(r) && !sharpSpread(cfg, r).ok) return 'sharpSpread';
  if (!softCheck(cfg, r).ok) return 'softBooks';
  if (!longPropConsensus(cfg, r).ok) return 'longConsensus';
  if (!marketCheck(cfg, r).ok) return 'pinnacleOff';
  if (pinnacleOnlyTotal(cfg, r)) return 'pinnacleOnlyTotal';
  if (!pmBelowFair(cfg, r).ok) return 'pmBelow';
  if (!pregamePinnacle(cfg, r).ok) return 'pregamePinnacle';
  const lim = noLiveTiming(r) ? null : liveAgeLimit(cfg, r);
  if (!freeLive(r) && r.isLive && lim != null && r.prices) { const a = sharpClock.ageSec(r); if (a == null || a > lim) return 'stale'; }
  if (groupRoom(cfg, groups, r) == null) return groupCoolingDown(cfg, groups, r) ? 'groupCooldown' : 'group';
  if (sameEvRepeat(cfg, groups, r) != null) return 'sameEv';
  if ([...inflight.values()].some((f) => groupClash(cfg, r, f))) return 'groupInFlight';
  if ((cooldown.get(r.id) || 0) >= now) return 'cooldown';
  if (overEventCap(r, perEvent)) return 'perEvent';
  if (overLivePropCap(r, liveProps)) return 'livePropCap';
  if (tooManyStats(cfg, stats, r)) return 'playerStats';
  if (!dryRun && !bridge.hasTab(r.book)) return 'noTab';
  if (novig && !novig.check(r, r.odds).ok) return 'novig';
  { const h = held.get(holdKey(r)); if (h && now - h.since < holdMs) return 'held'; }
  return 'dupInScan';
}
const warnedNoRows = new Set();

const selKey = (r) => `${r.book}|${r.event}|${r.market}|${r.selection}`;
const desc = (r) => `${BOOK_LABELS[r.book] || r.book} ${r.market} ${r.selection === r.market ? '' : r.selection + ' '}${r.line ?? ''}`.replace(/\s+/g, ' ').trim();

const fmtNovig = (nv) => `${fmtAmerican(nv.odds)}${nv.oppOdds != null ? `/${fmtAmerican(nv.oppOdds)}` : ''}`;

// Per-book stakes (Austin 2026-11-26): "stake": {"byBook": {"hardrock": {"pregame": 10, "fallback": 5}}}.
// pregame / live / amount: that book's stake for pre-game / live / any bet (missing = stake.amount).
// fallback: if the book refuses the stake as too big, the bet goes again at the book's max (it says it),
// or at this amount when it doesn't say. "byBook": {} = flat stake.amount everywhere.
if (cfg.stake.byBook === undefined) cfg.stake.byBook = { hardrock: { pregame: 10, fallback: 5 } };
function stakeAmount(row) {
  const b = cfg.stake.byBook?.[row.book];
  const v = b ? (row.isLive === false ? b.pregame : row.isLive === true ? b.live : undefined) ?? b.amount : undefined;
  return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : cfg.stake.amount;
}
function stakeFor(quote, row) {
  let s = row ? stakeAmount(row) : cfg.stake.amount;
  if (cfg.stake.capAtMaxStake && quote.maxStake) s = Math.min(s, quote.maxStake);
  return Math.floor(s * 100 + 1e-6) / 100;
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
  const was = row.gambitOdds != null && row.gambitOdds !== row.odds ? `, ${feedName} showed ${fmtAmerican(row.gambitOdds)}` : '';
  return `${desc(row)} ${fmtAmerican(row.odds)} (${fmtPct(row.ev)} EV${was}) — ${row.event}${row.isLive ? ' [live]' : Number.isFinite(startIn) ? ` [pre-game, starts in ${startIn < 1 ? `${Math.max(0, Math.round(startIn * 60))}m` : `${startIn.toFixed(1)}h`}]` : ''}${row.book === 'hardrock' && row.gambitBookId ? ` [Gambit book ${row.gambitBookId}]` : ''}`;
};

// ctx collects what happened, for the price log and for deciding whether to keep watching.
async function tryBet(row, ctx) {
  const book = books[row.book];
  const w = watch.get(row.id);
  let quote;
  ctx.checkStartAt = Date.now();
  try { quote = await book.recheck(row); }
  catch (e) {
    ctx.outcome = 'check error';
    session.bookError(row.book, e.message);
    // The book has paused its price checks (DraftKings after an HTTP 403 from its bot filter): it said
    // so once; this bet waits for the pause to end instead of the usual 5 minutes.
    if (e.paused) { ctx.outcome = 'paused'; ctx.pausedUntil = e.until; log.debug(`${book.label} ${desc(row)}: ${e.message}`); return false; }
    if (w) log.debug(`${book.label} ${desc(row)}: re-check error: ${e.message}`);
    else { log.header(headerText(row)); log.warn(`${book.label}: re-check error: ${e.message}`); }
    return false;
  }
  ctx.quote = quote; ctx.checkedAt = Date.now();
  if (quote.debug) log.debug(`${desc(row)}: ${quote.debug}`);   // e.g. theScore: each step's price
  if (quote.loginOk) session.bookOk(row.book);
  if (book.freePriceCheck) ctx.realOdds = quote.odds;
  // A watched bet whose price, line and fair odds haven't changed since its last check stays quiet.
  ctx.sig = `${quote.odds}|${quote.line}|${quote.suspended}|${row.fairOdds}|${row.novigOdds}|${row.novigOppOdds}`;
  ctx.changed = !w || w.sig !== ctx.sig;
  if (w) w.sig = ctx.sig;
  const lg = ctx.lg = ctx.changed ? loudLog : quietLog();
  const hh = held.get(holdKey(row));
  lg.header(headerText(row) + (w ? ` (checking again, ${Math.round((Date.now() - w.since) / 1000)}s after it failed)` : '') + (hh && Date.now() - hh.since >= holdMs ? ` (second check after a ${heldSec(hh)}s hold)` : ''));

  if (!Number.isFinite(quote.odds)) { ctx.outcome = 'no price'; lg.warn(`${book.label}: re-check returned no price — skipped`); return false; }
  if (quote.suspended) { ctx.outcome = 'suspended'; lg.warn(`${book.label}: market suspended — skipped`); return false; }
  if (row.line != null && quote.line != null && quote.line !== row.line) {
    ctx.outcome = 'line moved';
    lg.warn(`${BOOK_LABELS[row.book]}: line moved (${feedName} priced ${row.line}, ${book.label} line is now ${quote.line}) — skipped, nothing placed`);
    return false;
  }
  // Price that only just jumped our way (Austin, 2026-11-20): when the book changed its price under
  // freshJump.sec before our scan and the real price shows freshJump.evPts+ more EV than Gambit's copy
  // of it, the jump is likely the game moving before the sharp prices behind "fair" caught up.
  const fj = freshJump(row, quote, ctx);
  if (fj) {
    ctx.outcome = 'fresh jump';
    lg.warn(`${book.label}: price jumped to ${fmtAmerican(quote.odds)} ${fj.sec.toFixed(1)}s ago (${fmtPct(fj.ev)} EV vs ${fmtPct(fj.gambitEv)} at ${feedName}'s ${fmtAmerican(row.gambitOdds ?? row.odds)}), fair price may not have caught up — skipped, nothing placed`);
    return false;
  }
  // Gambit behind the book (Austin, 2026-11-24): on a live bet, when the book's real price is no longer
  // the price Gambit showed for it, the game has moved since Gambit's snapshot, and Gambit's sharp prices
  // (the "fair") are from that same old snapshot. 873 settled bets: those won 41 of 64.3 expected
  // (-$34.75 vs +$17.29 expected); the rest were on model. Skipped and checked again on later scans:
  // once Gambit shows the book's new price, its fair has caught up too and the bet goes ahead.
  const gb = gambitBehind(row, quote);
  if (gb) {
    ctx.outcome = 'Gambit behind';
    lg.warn(`${book.label}: price is ${fmtAmerican(quote.odds)} but ${feedName} still shows ${fmtAmerican(gb.gambitOdds)}, so its fair ${fmtAmerican(row.fairOdds)} is from before the move — skipped, checking again once ${feedName} catches up`);
    return false;
  }
  return placeAt(row, book, quote, ctx);
}

// Config "gambitBehind": { books, maxPts }; false turns it off. Defaults: every book except Hard Rock
// (its moves away from Gambit's copy were on model: 330 bets), any change (0 points of win chance).
// livePriceMatch (Austin 2026-11-26, on by default): any change at all, on every book (Hard Rock too), wins over
// gambitBehind's books / exceptBooks / maxPts. "livePriceMatch": {"books": [...]} limits it to those books.
function behindCfg(book) {
  const lpm = cfg.livePriceMatch && cfg.livePriceMatch.enabled !== false ? cfg.livePriceMatch : null;
  if (lpm && (!Array.isArray(lpm.books) || lpm.books.includes(book))) return { maxPts: 0, exact: true };
  const g = cfg.gambitBehind === false ? null : { exceptBooks: ['hardrock'], maxPts: 0, ...(cfg.gambitBehind || {}) };
  if (!g || (Array.isArray(g.books) ? !g.books.includes(book) : (g.exceptBooks || []).includes(book))) return null;
  return g;
}
function gambitBehind(row, quote) {
  const g = behindCfg(row.book);
  if (!g || !row.isLive) return null;
  const gambitOdds = row.gambitOdds ?? row.odds;
  if (!Number.isFinite(gambitOdds) || !Number.isFinite(quote.odds) || gambitOdds === quote.odds) return null;
  const pts = Math.abs(impliedProb(gambitOdds) - impliedProb(quote.odds)) * 100;
  return pts > Number(g.maxPts || 0) ? { gambitOdds, pts } : null;
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
async function placeAt(row, book, quote, ctx, retries = 0) {
  const lg = ctx.lg;
  if (tooLong(quote.odds, row)) { ctx.outcome = 'odds above max'; lg.warn(`${book.label}: ${fmtAmerican(quote.odds)} is above the ${fmtAmerican(cfg.maxOdds)} cap — skipped, nothing placed`); return false; }
  if (tooShort(cfg, quote.odds)) { ctx.outcome = 'odds below min'; lg.warn(`${book.label}: ${fmtAmerican(quote.odds)} is shorter than the ${fmtAmerican(cfg.minOdds)} limit — skipped, nothing placed`); return false; }
  const ev = evPct(quote.odds, row.fairOdds);
  ctx.bookEv = ev;
  // A prop that's over propHold.evPct at the book's real price (also after a price move) is held too,
  // unless it has already been listed propHold.sec and passed the rules again.
  if (holdCfg && overHoldEv(row, ev)) {
    const h = held.get(holdKey(row));
    if (!h || Date.now() - h.since < holdMs) {
      ctx.outcome = 'held';
      if (!h) startHold(row, ev, quote.odds, `${book.label}'s price is over it`);
      else lg.info(`${book.label}: ${fmtAmerican(quote.odds)} is ${fmtPct(ev)} EV, still in its ${holdMs / 1000}s hold (${heldSec(h)}s so far) — not bet yet`);
      return false;
    }
  }
  if (evTooHigh(cfg, ev, row)) { ctx.outcome = 'EV above cap'; lg.warn(`${book.label}: ${fmtAmerican(quote.odds)} is ${fmtPct(ev)} EV, above the ${maxEvFor(cfg, row)}% cap (likely a stale or wrong price) — skipped, nothing placed`); return false; }
  const tail = `${fmtAmerican(quote.odds)} vs fair ${fmtAmerican(row.fairOdds)} from ${row.fairBooks ?? '?'} book(s) -> ${fmtPct(ev)} EV` +
    (quote.maxStake ? ` (max stake $${quote.maxStake})` : '');
  if (ev < minEv(row, quote.odds)) { ctx.outcome = 'EV too low'; lg.warn(`${book.label}: re-check FAIL: ${tail}`); return false; }
  lg.bet(`${book.label}: re-check OK: ${tail}`);

  // At least 2 of the softCheck books (DraftKings/Caesars/FanDuel/Fanatics) must also show this price above 0% EV (softCheck).
  const sc = softCheck(cfg, row, quote.odds);
  if (!sc.ok) {
    ctx.outcome = 'soft books fail';
    lg.warn(`soft-book check FAIL: ${fmtAmerican(quote.odds)} is above ${cfg.softCheck.minEvPct}% EV on ${sc.pass} of ${sc.n} priced (need ${sc.need}): ${fmtSoft(sc)} — skipped, nothing placed`);
    return false;
  }
  if (!sc.off) lg.bet(`soft-book check OK: ${fmtSoft(sc)}`);

  // Props over +250: DraftKings or Caesars must have a no-vig win % within 5 pts of our fair.
  const lc = longPropConsensus(cfg, row, quote.odds);
  if (!lc.ok) {
    ctx.outcome = 'long-odds consensus fail';
    lg.warn(`long-odds prop check FAIL: ${fmtAmerican(quote.odds)} needs ${lc.need}+ of ${Object.keys(cfg.longPropConsensus.books).join('/')} within ${cfg.longPropConsensus.maxPts} pts (${fmtLongConsensus(lc)}) — skipped, nothing placed`);
    return false;
  }
  if (!lc.off) lg.bet(`long-odds prop check OK: ${fmtLongConsensus(lc)}`);

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
  if (room == null && groupCoolingDown(cfg, groupTotals(state.placed), row)) { ctx.outcome = 'group cooldown'; lg.warn(`group cooldown: bet on (${row.event}, ${row.market}) on ${BOOK_LABELS[row.book]} less than ${cfg.group.cooldownSec}s ago — skipped`); return false; }
  if (room == null) { ctx.outcome = 'group full'; lg.warn(`group full: ${groupMaxBets(cfg, row) ?? 'any'}${row.isLive === false ? ' pre-game' : ''} bets / $${cfg.group.maxStake ?? 'any'} already on (${row.event}, ${row.market}, ${row.selection}) — skipped`); return false; }
  const sameAt = sameEvRepeat(cfg, groupTotals(state.placed), row, ev);
  if (sameAt != null) { ctx.outcome = 'same EV'; lg.warn(`same bet already placed on ${BOOK_LABELS[row.book]} at ${fmtPct(sameAt)} EV; ${fmtPct(ev)} is within ${cfg.group.repeatMinEvPts} pts — skipped`); return false; }
  // The group's $ cap counts in base-stake units: a $10 Hard Rock pre-game bet (base $1) uses $1 of it.
  const unit = stakeAmount(row) / (Number(cfg.stake.amount) || 1);
  let stake = Math.floor(Math.min(stakeFor(quote, row), room * unit) * 100 + 1e-6) / 100;
  if (ctx.stakeCap != null) stake = Math.min(stake, ctx.stakeCap);
  if (stake <= 0) { ctx.outcome = 'stake 0'; lg.warn('stake is 0 — skipped'); return false; }
  if (cfg.dailyStakeLimit && state.staked + pendingStake + stake > cfg.dailyStakeLimit) {
    ctx.outcome = 'daily limit';
    lg.warn(`daily stake limit $${cfg.dailyStakeLimit} reached — skipped`); return false;
  }
  lg.flush();   // about to bet: show everything, even for a quiet repeat check
  ctx.sent = true; ctx.changed = true;
  pendingStake += stake;
  const attempt = { sentAt: Date.now(), odds: quote.odds };
  ctx.attempts.push(attempt);
  try {
    const { betId, confirmedOdds, detail } = await book.place(row, stake, quote).finally(() => { attempt.answeredAt = Date.now(); });
    ctx.outcome = 'placed'; ctx.realOdds = confirmedOdds ?? quote.odds;
    if (detail) lg.debug(`${book.label} ${desc(row)} PLACED — ${detail}`);
    state.placed.push({ at: new Date().toISOString(), key: selKey(row), group: groupKey(row), event: row.event, book: row.book,
      market: row.market, isProp: !!row.isProp, isLive: row.isLive, gambitBookId: row.gambitBookId, selection: row.selection, line: row.line, odds: quote.odds, fair: row.fairOdds, ev, novigEv: novigEvPct, stake,
      ...(unit !== 1 ? { groupStake: Math.round(stake / unit * 100) / 100 } : {}), betId });
    state.staked += stake; save();
    // Paper trail: what we checked vs what the book says it accepted, plus Gambit's fair odds.
    // Dry runs: the simulated book "confirms" the price we sent.
    // ref: the exact reference prices and fair behind this EV, and when Gambit showed them (Show bets popup).
    const rec = betLog.record({ row, quote, stake, betId, confirmedOdds: dryRun ? quote.odds : confirmedOdds, ev, novig: novigCheck, sharp: sharpSpread(cfg, row),
      ref: fairBreakdown(cfg, row), timing: { checkedAt: ctx.checkedAt, sentAt: attempt.sentAt, acceptedAt: attempt.answeredAt } });
    // Then the first Gambit prices fetched after the book accepted it: did the fair hold during the book's hold?
    afterAccept.push({ rec, id: row.id, acceptedAt: attempt.answeredAt ?? Date.now(), odds: rec.confirmedOdds ?? quote.odds });
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
      // Re-check at the book's new price (every rule again) up to priceMoveRetries times
      // (default 2): a live price can move again during the book's delay on the retry.
      const maxRetries = Number.isFinite(Number(cfg.priceMoveRetries)) ? Math.max(0, Number(cfg.priceMoveRetries)) : 2;
      // Live price match (Austin 2026-11-26): the new price has to be the one the table shows now, or it's skipped.
      if (hasNew && retries < maxRetries && row.isLive === true && cfg.livePriceMatch?.onRetry !== false && behindCfg(row.book)?.exact) {
        let tableNow = row.gambitOdds ?? row.odds, fresh = null;
        if (lastScan && lastScan.scanAt > (ctx.scanAt ?? 0)) {
          fresh = lastScan.rows.find((r) => r.id === row.id) || null;
          tableNow = lastScan.gambitRows.get(row.id)?.odds ?? (fresh ? fresh.gambitOdds ?? fresh.odds : null);
        }
        if (tableNow !== e.newOdds) {
          ctx.outcome = 'Gambit behind';
          lg.warn(`${book.label}: price moved ${fmtAmerican(quote.odds)} → ${fmtAmerican(e.newOdds)} while placing, but ${feedName} ${tableNow == null ? 'no longer lists it' : `shows ${fmtAmerican(tableNow)}`} — skipped (live price must match the table), checking again once ${feedName} shows it`);
          return false;
        }
        if (fresh && !book.freshFairOnRetry) {
          if (sharpTooOld(fresh)) { lg.warn(`${book.label}: price moved ${fmtAmerican(quote.odds)} → ${fmtAmerican(e.newOdds)}; no fresh sharp price to check it against — skipped, nothing placed`); return false; }
          lg.warn(`${book.label}: price moved ${fmtAmerican(quote.odds)} → ${fmtAmerican(e.newOdds)}, ${feedName} shows it too, checking again with its newest fair ${fmtAmerican(fresh.fairOdds)}`);
          return placeAt({ ...fresh }, book, { ...quote, ...(e.newQuote || {}), odds: e.newOdds }, ctx, retries + 1);
        }
      }
      if (hasNew && retries < maxRetries) {
        // Books that hold a live bet for a long time (theScore ~9-12s): the fair price from before the
        // hold may be stale, so the re-check uses the newest scan's row (fair price, other books'
        // prices, sharp timing). Gone from Gambit's table, or its sharp price too old: not sent again.
        let next = row;
        if (book.freshFairOnRetry && lastScan && lastScan.scanAt > (ctx.scanAt ?? 0)) {
          const fresh = lastScan.rows.find((r) => r.id === row.id);
          if (!fresh) { lg.warn(`${book.label}: price moved ${fmtAmerican(quote.odds)} → ${fmtAmerican(e.newOdds)}; ${feedName} no longer lists this bet — skipped, nothing placed`); return false; }
          if (sharpTooOld(fresh)) { ctx.outcome = 'price moved'; lg.warn(`${book.label}: price moved ${fmtAmerican(quote.odds)} → ${fmtAmerican(e.newOdds)}; no fresh sharp price to check it against — skipped, nothing placed`); return false; }
          next = { ...fresh };
          if (next.fairOdds !== row.fairOdds) lg.info(`${book.label}: fair price is now ${fmtAmerican(next.fairOdds)} (was ${fmtAmerican(row.fairOdds)} before ${book.label}'s hold)`);
        }
        lg.warn(`${book.label}: price moved ${fmtAmerican(quote.odds)} → ${fmtAmerican(e.newOdds)}, checking again${retries ? ` (retry ${retries + 1} of ${maxRetries})` : ''}`);
        return placeAt(next, book, { ...quote, ...(e.newQuote || {}), odds: e.newOdds }, ctx, retries + 1);
      }
      lg.warn(`${book.label}: price moved${hasNew ? ` to ${fmtAmerican(e.newOdds)}` : ''} — skipped, nothing placed`);
      return false;
    }
    // The book paused its price checks before anything was sent (DraftKings: its bot filter answered
    // the bet slip's price check HTTP 403): the bet waits for the pause to end, then is checked again.
    if (e.paused && e.notSent) {
      ctx.sent = false; ctx.outcome = 'paused'; ctx.pausedUntil = e.until;
      lg.warn(`${book.label}: ${e.message} — nothing placed, checked again after the pause`);
      return false;
    }
    // Stake too big for the book (Hard Rock's $10 pre-game stake, Austin 2026-11-26): once more at the book's max.
    if (e.stakeTooHigh && ctx.stakeCap == null) {
      const fb = Number(cfg.stake.byBook?.[row.book]?.fallback ?? cfg.stake.amount);
      const max = Number.isFinite(e.maxStake) && e.maxStake > 0 ? e.maxStake : fb;
      const next = Math.floor(Math.min(max, stake - 0.01) * 100 + 1e-6) / 100;
      if (next > 0) {
        ctx.stakeCap = next;
        lg.warn(`${book.label}: $${stake} refused as too big (${e.message}), betting its max $${next} instead`);
        return placeAt(row, book, quote, ctx, retries);
      }
    }
    if (e.gone) { ctx.outcome = 'no longer offered'; lg.warn(`${book.label}: bet no longer offered — skipped, nothing placed`); return false; }
    // Nothing reached the book / nothing was placed (FanDuel's location check had run out, or
    // BetRivers refused it with ACCOUNT_BLOCKED because its location check had). Once it's renewed, the
    // bet is checked again from the start on the next scan: price, every rule, then placed.
    if (e.notSent && (e.geoRenewing || e.geoRenewed)) {
      ctx.sent = false; ctx.outcome = e.geoRenewing ? 'location renewing' : 'location renewed';
      // Said once a minute per bet: it's checked again every scan until the renewal is done.
      const said = geoSaid.get(row.id) || 0;
      if (Date.now() - said > 60e3) { geoSaid.set(row.id, Date.now()); lg.warn(`${book.label}: ${e.message}`); }
      return false;
    }
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

const directBusy = {}, directMs = {}, directSlowAt = {};
let slowWarnAt = 0;
function directSlow(n, b) {
  if (directSlowAt[n] > Date.now() - 5 * 60e3) return;
  directSlowAt[n] = Date.now();
  log.warn(`${b.label}: reading its prices directly takes longer than the scan waits (${cfg.directWaitSec ?? 1.5}s${directMs[n] ? `, last read ${(directMs[n] / 1000).toFixed(1)}s` : ''}), so some scans use ${feedName}'s ${b.label} prices; every bet is still checked at ${b.label} first`);
}

/**
 * Every rule a row must pass before its price is re-checked at the book, best bet first, one per
 * group. Used by each Gambit scan and by the fast price check (quiet: no skip logs there).
 */
function pickBets(rows, { quiet = false } = {}) {
  const stats = playerStats([...state.placed, ...inflight.values()]);
  // Per-game caps (maxBetsPerEvent, liveMaxPropsPerEvent) count the last 24 hours only, like the group
  // rules: event names repeat (the same two teams meet again), so older bets must not count. Bets in
  // flight have no time yet and always count.
  const dayAgo = Date.now() - 24 * 3600e3;
  const recent = [...state.placed.filter((p) => !p.at || Date.parse(p.at) >= dayAgo), ...inflight.values()];
  const perEvent = {};
  for (const p of recent) if (inEventCap(p)) perEvent[p.event] = (perEvent[p.event] || 0) + 1;
  const liveProps = livePropCounts(recent);
  const now = Date.now();
  let farOff = 0;
  const why = { noProps: 0, liveEvProps: 0, pinnacleOnlyTotal: 0, pmBelow: 0, pregamePinnacle: 0, odds: 0, evCap: 0, sharpSpread: 0, softBooks: 0, longConsensus: 0, pinnacleOff: 0, noSharp: 0, stale: 0, staleProp: 0, livePropCap: 0, group: 0, groupCooldown: 0, sameEv: 0, playerStats: 0 };
  const drop = (k) => (why[k]++, false);
  const groups = groupTotals(state.placed);
  let ev = rows
    .filter((r) => Number.isFinite(r.ev) && r.ev >= minEv(r))
    .filter((r) => !(r.isProp && propsOff(cfg, r.book)) || drop('noProps'))
    // Hard Rock live player props from the +EV table: off (Austin 2026-11-26); its arb-table props still go.
    .filter((r) => !liveEvPropOff(cfg, r) || drop('liveEvProps'))
    .filter((r) => (!tooLong(r.odds, r) && !tooShort(cfg, r.odds)) || drop('odds'))
    .filter((r) => !evTooHigh(cfg, r.ev, r) || drop('evCap'))
    .filter((r) => !tooEarly(r) || (farOff++, false))
    .filter((r) => freeLive(r) || r.ppFairFallback || !liveSharpMissing(cfg, r) || drop('noSharp'))
    .filter((r) => { if (freeLive(r)) return true; const sp = sharpSpread(cfg, r); if (sp.ok) return true; if (!quiet) logSpreadSkip(r, sp); return drop('sharpSpread'); })
    .filter((r) => softCheck(cfg, r).ok || drop('softBooks'))
    .filter((r) => longPropConsensus(cfg, r).ok || drop('longConsensus'))
    .filter((r) => { const mc = marketCheck(cfg, r); if (mc.ok) return true; if (!quiet) logMarketSkip(r, mc); return drop('pinnacleOff'); })
    // Austin 2026-11-26: live totals on Hard Rock/BetRivers need more than Pinnacle behind the fair; on
    // moneylines and props no prediction market may sit 2+ pts below our fair; pre-game, Pinnacle within 2 pts
    // of DraftKings and FanDuel.
    .filter((r) => !pinnacleOnlyTotal(cfg, r) || drop('pinnacleOnlyTotal'))
    .filter((r) => pmBelowFair(cfg, r).ok || drop('pmBelow'))
    .filter((r) => pregamePinnacle(cfg, r).ok || drop('pregamePinnacle'))
    .filter((r) => !sharpTooOld(r) || drop(r.isProp ? 'staleProp' : 'stale'))
    .filter((r) => groupRoom(cfg, groups, r) != null || drop(groupCoolingDown(cfg, groups, r) ? 'groupCooldown' : 'group'))
    .filter((r) => sameEvRepeat(cfg, groups, r) == null || drop('sameEv'))
    .filter((r) => ![...inflight.values()].some((f) => groupClash(cfg, r, f)))
    .filter((r) => (cooldown.get(r.id) || 0) < now)   // repeats on one side are capped by the group rule
    .filter((r) => !overEventCap(r, perEvent))
    .filter((r) => !overLivePropCap(r, liveProps) || drop('livePropCap'))
    .filter((r) => !tooManyStats(cfg, stats, r) || drop('playerStats'))
    .filter((r) => dryRun || bridge.hasTab(r.book))
    // Props over propHold.evPct: held propHold.sec before they can go (they passed every rule above).
    .filter((r) => holdDone(r, now))
    // New bets first, then ones being watched after a failed price check.
    .sort((a, b) => (watch.has(a.id) - watch.has(b.id)) || b.ev - a.ev);
  const gambitCount = ev.length;
  if (novig) ev = ev.filter((r) => novig.check(r, r.odds).ok);
  const novigDropped = gambitCount - ev.length;
  // One bet per group per scan: keep the first (best-EV new) row of each group. Later scans can add more, up to group.maxBets.
  // Also counts each kept prop's stat, so one scan can't send a player past maxPropStatsPerPlayer.
  { const kept = [];
    ev = ev.filter((r) => {
      if (kept.some((k) => groupClash(cfg, r, k)) || tooManyStats(cfg, stats, r) || overLivePropCap(r, liveProps)) return false;
      kept.push(r);
      if (r.isLive === true && isPropBet(r)) liveProps[r.event] = (liveProps[r.event] || 0) + 1;
      if (isPropBet(r)) { const k = playerKey(r); if (!stats.has(k)) stats.set(k, new Set()); stats.get(k).add(statKey(r)); }
      return true;
    }); }
  return { ev, why, farOff, novigDropped, groups, perEvent, liveProps, stats, now };
}
// Live bet whose sharp price hasn't moved within the live timing rule (5s, props 30s; props over the
// propHold EV skip it).
const sharpTooOld = (r) => {
  const lim = noLiveTiming(r) ? null : liveAgeLimit(cfg, r);
  if (freeLive(r) || !r.isLive || lim == null || !r.prices) return false;
  const a = sharpClock.ageSec(r);
  return !(a != null && a <= lim);
};

async function tick() {
  if (state.day !== today()) { state.day = today(); state.staked = 0; save(); }
  let rows;
  const tickAt = Date.now();
  try {
    rows = await source.fetchRows();
    sourceError(source.name, null);
  } catch (e) {
    log.err(`${source.label || 'Gambit'} fetch failed: ${e.message}`);
    sourceError(source.name, e);
    return;
  }
  // Closing line value: follow Gambit's fair price for bets already placed.
  if (source.fairIndex) {
    const closed = betLog.track(source.fairIndex(), Date.now(), source.arbFairIndex?.());
    for (const b of closed) {
      if (b.clv == null) log.info(`CLV: ${betLog.describe(b)}: ${feedName} stopped listing it after we bet, no close to compare`);
      else log.info(`CLV: ${betLog.describe(b)} vs close ${fmtAmerican(b.closeFairOdds)} (${b.closeKind}) -> ${fmtPct(b.clv)}`);
    }
    if (closed.length) log.info(betLog.summaryLine());
  }
  if (novig) {
    try { await novig.refresh(); }
    catch (e) { log.err(`Novig fetch failed: ${e.message} — not placing`); return; }
  }

  rows = rows.filter((r) => books[r.book]);
  // What the feed lists, before any rule: a held prop missing from here has left the board.
  const listed = new Set(held.size ? rows.map(holdKey) : []);
  // Per-book de-vig method ("fanduel": {"devigMethod": "power"}): that book's EV from Gambit's
  // Power / Multiplicative / Additive / Shin number, or "best" (highest), instead of the lowest.
  for (const r of rows) {
    const m = String(cfg[r.book]?.devigMethod || '').toLowerCase();
    if (!m || m === 'worst' || !r.devig) continue;
    const ps = Object.entries(r.devig).filter(([, v]) => Number.isFinite(v) && v > 0 && v < 1);
    const p = m === 'best' ? Math.max(...ps.map(([, v]) => v)) : ps.find(([k]) => k.toLowerCase() === m)?.[1];
    if (!Number.isFinite(p)) continue;
    r.fairProb = p; r.fairOdds = decimalToAmerican(1 / p); r.ev = (p * americanToDecimal(r.odds) - 1) * 100;
  }
  // Fair price from the sharp books only (Pinnacle + Kalshi/Polymarket with $500+ liquidity), lowest wins.
  // Gambit's "market" fair is replaced (it can include thin prediction-market prices); rows with no
  // sharp book priced are dropped.
  let noSharpFair = 0, ppFallback = 0;
  const noFairRows = [];
  rows = rows.filter((r) => {
    const sf = sharpFair(cfg, r);
    if (!sf) return true;
    if (sf.prob == null || !(sf.prob > 0 && sf.prob < 1)) {
      // PropProfessor sends no Pinnacle (2026-11-24), so its game lines would all land here. Austin's
      // choice: those use PropProfessor's own no-vig fair instead ("propprofessor": {"fairFallback": false}
      // turns it off). Props still need FanDuel, as always.
      if (!ppFallbackOk(r)) { noSharpFair++; if (skippedLog) noFairRows.push(r); return false; }
      r.ppFairFallback = true; ppFallback++;
      r.fairCalc = { probs: {}, books: [], ppFallback: true };
      r.fairSource = 'PropProfessor (no Pinnacle/prediction market)';
      return true;
    }
    // Kept for the bet log: each sharp book's win % as the fair calculation saw it (fairBreakdown).
    r.fairCalc = { probs: sf.probs, books: sf.books.length ? sf.books : sf.gambitPinnacle ? ['pinnacle'] : [], gambitPinnacle: sf.gambitPinnacle };
    if (sf.changed) {
      r.gambitFairProb ??= r.fairProb;
      r.fairProb = sf.prob; r.fairOdds = decimalToAmerican(1 / sf.prob); r.ev = (sf.prob * americanToDecimal(r.odds) - 1) * 100;
      r.fairSource = `sharp: ${sf.books.join('/')}`;
    }
    return true;
  });
  const scanAt = Date.now();
  sharpClock.update(rows);
  // When these Gambit prices were fetched, and (live) how long ago the watched sharp price last
  // moved: saved with a bet so Show bets can say how old the reference prices were when it was placed.
  for (const r of rows) { r.gambitAt = scanAt; if (r.isLive) r.sharpAgeSec = sharpClock.ageSec(r, scanAt); }
  { const ids = new Set();
    for (const r of rows) { ids.add(r.id); const s = shown.get(r.id); if (!s || s.odds !== r.odds) shown.set(r.id, { odds: r.odds, since: scanAt }); }
    for (const id of shown.keys()) if (!ids.has(id)) shown.delete(id);
    for (const [id, w] of watch) if (scanAt - w.since > WATCH_MS + 60e3) watch.delete(id); }
  // Books that let us read their prices directly (BetRivers): use the real price, not Gambit's copy.
  // All books are read at the same time, and the scan waits at most directWaitSec (default 1.5)
  // for them: a book that takes longer (slow tab, slow line) keeps Gambit's prices this scan,
  // its read finishes in the background, and it is read again on a later scan. Each read works
  // on copies of the rows, so a late answer never changes rows a scan already used.
  const direct = {};
  const t0 = Date.now();
  // Gambit's own numbers for every row (before the books' prices replace them), for the fast price check.
  const gambitRows = new Map(rows.map((r) => [r.id, { ...r }]));
  const minDirectEv = Math.min(cfg.minEvPct, source.arb?.cfg.minEvPct ?? Infinity, pregameMinEv ?? Infinity);
  const waitMs = Math.max(0, Number(cfg.directWaitSec ?? 1.5) * 1000);
  await Promise.all(Object.entries(books).map(async ([n, b]) => {
    if (!b.livePrices) return;
    if (directBusy[n]) { directSlow(n, b); return; }   // the last read hasn't finished yet
    const mine = rows.filter((r) => r.book === n);
    const copies = mine.map((r) => ({ ...r }));
    const started = Date.now();
    const job = b.livePrices(copies, minDirectEv).then((st) => ({ st }), (e) => ({ e }));
    directBusy[n] = job;
    job.then(() => { directBusy[n] = null; directMs[n] = Date.now() - started; });
    let timer;
    const res = await Promise.race([job, new Promise((r) => { timer = setTimeout(() => r(null), waitMs); })]);
    clearTimeout(timer);
    if (!res) { directSlow(n, b); return; }
    if (res.e) {
      if (!(directWarnAt[n] > Date.now() - 60e3)) { directWarnAt[n] = Date.now(); log.warn(`${b.label}: couldn't read its prices directly (${res.e.message}), using ${feedName}'s prices for now`); }
      return;
    }
    mine.forEach((r, i) => Object.assign(r, copies[i]));
    direct[n] = res.st;
  }));
  const directTook = Date.now() - t0;
  // Gambit rows from other books only count once the book's own price was read.
  rows = rows.filter((r) => !r.shadow || r.direct === true);
  for (const b of Object.keys(books)) {
    if (!warnedNoRows.has(b) && !rows.some((r) => r.book === b)) {
      warnedNoRows.add(b);
      if (source.name === 'propprofessor') log.warn(`PropProfessor shows no ${BOOK_LABELS[b] || b} rows yet. If this stays, tick ${BOOK_LABELS[b] || b} in your PropProfessor sportsbooks settings`);
      else log.warn(`Gambit's feed has no ${BOOK_LABELS[b] || b} rows yet. If this stays, tick ${BOOK_LABELS[b] || b} in Gambit's sportsbook filter and copy the new evs.json link into config.json`);
      if (seenBooks.size && source.name !== 'propprofessor') {
        const host = (l) => { try { return new URL(l).hostname; } catch { return String(l).slice(0, 40) || 'no link'; } };
        log.warn(`Gambit sportsbook ids in the feed: ${[...seenBooks].map(([id, l]) => `${id} (${host(l)})`).join(', ')}`);
      }
    }
  }
  const pk = pickBets(rows);
  const { ev, why, farOff, novigDropped, groups, perEvent, liveProps, stats, now } = pk;
  // The logs run once this scan's bets are on their way (nothing below awaits before they're sent).
  let batch = [];
  if (skippedLog || shadowLog) setImmediate(() => { try { afterScan(rows, ev, batch, pk, noFairRows); } catch (e) { log.debug(`skipped/shadow log: ${e.message}`); } });
  // Holds: dropped once the feed stops listing the prop; a hold that's over but whose prop failed
  // the rules this scan says why (the first scan rule it failed).
  if (held.size) {
    const byKey = new Map(rows.map((r) => [holdKey(r), r]));
    const sent = new Set(ev.map(holdKey));
    const labels = stageLabels(cfg);
    for (const [k, h] of held) {
      const r = byKey.get(k);
      if (!r && !listed.has(k)) {
        log.info(`HOLD dropped: ${h.desc} — ${h.event}: no longer listed after ${heldSec(h, now)}s${h.result === 'passed' ? '' : ', not bet'}`);
        held.delete(k); continue;
      }
      if (now - h.since < holdMs || sent.has(k)) continue;
      if (!r) { holdFailed(h, `no sharp price for the fair, or ${feedName}'s row isn't confirmed at the book`, now); continue; }
      const st = propStage(r, { groups, perEvent, liveProps, stats, now });
      // 'dupInScan' = passed every rule, another row of its group went this scan.
      if (st !== 'dupInScan') holdFailed(h, labels[st] || st, now, r);
    }
  }
  const ageMax = cfg.sharp.liveMaxAgeSec;
  if (propFunnel) {
    const sent = new Set(ev.map((r) => r.id));
    for (const r of rows) if (r.isProp) propFunnel.note(r, sent.has(r.id) ? 'sent' : propStage(r, { groups, perEvent, liveProps, stats, now }));
    propFunnel.tick();
  }
  const holding = [...held.values()].filter((h) => now - h.since < holdMs).length;
  const whyText = [
    noSharpFair && `${noSharpFair} with no sharp price for the fair (Pinnacle, or a valid Kalshi/Polymarket/Novig/ProphetX price)`,
    ppFallback && `${ppFallback} game lines priced off PropProfessor's fair (no Pinnacle/prediction market)`,
    why.noProps && `${why.noProps} props on a book with props off`,
    why.odds && `${why.odds} outside ${cfg.minOdds == null ? 'any' : fmtAmerican(cfg.minOdds)} to ${cfg.maxOdds == null ? 'any' : fmtAmerican(cfg.maxOdds)}`,
    why.evCap && `${why.evCap} above ${cfg.maxEvPct}% EV (props ${cfg.maxPropEvPct ?? 'no cap'}${cfg.maxPropEvPct != null ? '%' : ''})`,
    holding && `${holding} props over ${holdCfg.evPct}% EV in their ${holdMs / 1000}s hold`,
    why.noSharp && `${why.noSharp} without the needed sharp book (live, or pre-game props without ${(cfg.sharp.pregamePropNeeds || []).join('/') || 'any'})`,
    why.sharpSpread && `${why.sharpSpread} sharp books more than ${cfg.sharp.maxSpreadPts} pts apart`,
    why.softBooks && `${why.softBooks} not above ${cfg.softCheck.minEvPct}% EV on ${cfg.softCheck.minBooks}+ of ${Object.keys(cfg.softCheck.books).join('/')}`,
    why.longConsensus && `${why.longConsensus} props over ${fmtAmerican(cfg.maxOdds)} without ${Object.keys(cfg.longPropConsensus.books).join('/')} within ${cfg.longPropConsensus.maxPts} pts of fair`,
    why.pinnacleOff && `${why.pinnacleOff} Pinnacle more than ${cfg.marketCheck.maxPts} pts above the soft-book median`,
    why.liveEvProps && `${why.liveEvProps} live +EV-table props on ${Object.keys(books).filter((b) => liveEvPropOff(cfg, { book: b, isLive: true, isProp: true })).map((b) => BOOK_LABELS[b] || b).join('/') || 'a book'} (off; arb-table props still bet)`,
    why.pinnacleOnlyTotal && `${why.pinnacleOnlyTotal} totals on ${cfg.pinnacleOnlyTotals.books.map((b) => BOOK_LABELS[b] || b).join('/')} with a Pinnacle-only fair`,
    why.pmBelow && `${why.pmBelow} with a prediction market ${cfg.pmBelowFair.pts}+ pts below fair`,
    why.pregamePinnacle && `${why.pregamePinnacle} pre-game with Pinnacle not within ${cfg.pregamePinnacleCheck.maxPts} pts of ${Object.keys(cfg.pregamePinnacleCheck.books).join('/')}${cfg.pregamePinnacleCheck.missing === 'pass' ? '' : ' (or not priced)'}`,
    why.stale && `${why.stale} live with no sharp move in the last ${ageMax}s`,
    why.staleProp && `${why.staleProp} live props with no FanDuel move in the last ${cfg.sharp.livePropMaxAgeSec}s`,
    why.group && `${why.group} group already bet`,
    why.groupCooldown && `${why.groupCooldown} group bet <${cfg.group.cooldownSec}s ago`,
    why.sameEv && `${why.sameEv} same bet already placed at EV within ${cfg.group.repeatMinEvPts} pts`,
    why.playerStats && `${why.playerStats} player already has ${cfg.maxPropStatsPerPlayer} stats bet`,
    why.livePropCap && `${why.livePropCap} live game already has ${cfg.liveMaxPropsPerEvent} props`,
  ].filter(Boolean).join(', ');

  const nBooks = new Set(rows.map((r) => r.book)).size;
  // Per book: rows in Gambit's feed and how many reach minEvPct at our fair price (worst of Gambit's
  // no-vig methods), before any other rule. Answers "why no bets on <book>?" at a glance.
  const perBook = Object.keys(books).map((b) => {
    const mine = rows.filter((r) => r.book === b);
    return `${BOOK_LABELS[b] || b} ${mine.length}/${mine.filter((r) => Number.isFinite(r.ev) && r.ev >= cfg.minEvPct).length}`;
  }).join(', ');
  const directText = Object.entries(direct).filter(([, d]) => d && (d.read || d.gone || d.unmatched))
    .map(([n, d]) => `, ${BOOK_LABELS[n]} prices read directly: ${d.read} (${d.moved} moved since Gambit${d.gone ? `, ${d.gone} gone or line changed` : ''}${d.shadowNew ? `, ${d.shadowNew} +EV not listed for ${BOOK_LABELS[n]} on Gambit` : ''}${d.unmatched ? `, ${d.unmatched} not found on ${BOOK_LABELS[n]} CO, e.g. ${d.why.slice(0, 900)}` : ''})`).join('');
  log.scan(`${ev.length} +EV bets from ${rows.length} rows (${nBooks} book${nBooks === 1 ? '' : 's'})` +
    (novig ? `, ${novigDropped} dropped because Novig doesn't show ${novig.minEvPct}%+` : '') +
    (farOff ? `, ${farOff} pre-game skipped (starts more than ${cfg.pregameMaxHours}h away)` : '') +
    (whyText ? `, skipped: ${whyText}` : '') + directText + arbText(rows) + `; rows/${cfg.minEvPct}%+ by book: ${perBook}`, ev.length === 0);
  // A scan that took much longer than pollSeconds: say where the time went (at most every 5 min).
  const tookMs = Date.now() - tickAt;
  if (tookMs > Math.max(5000, 2 * pollSeconds * 1000) && !(slowWarnAt > Date.now() - 5 * 60e3)) {
    slowWarnAt = Date.now();
    log.warn(`scan took ${(tookMs / 1000).toFixed(1)}s (${feedName} ${((scanAt - tickAt) / 1000).toFixed(1)}s, book prices ${(directTook / 1000).toFixed(1)}s)`);
  }
  lastScan = { rows, gambitRows, tickAt, scanAt, doneAt: Date.now() };
  checkAfterAccept(rows, tickAt, scanAt);
  if (!ev.length) return;
  if (!dryRun && !bridge.connected()) { log.warn('Chrome extension not connected — not placing'); return; }

  // Bets run in the background so the next Gambit poll isn't held up by a slow book.
  batch = ev.slice(0, Math.max(0, maxInFlight - inflight.size));
  const fresh = batch.filter((r) => !watch.has(r.id));
  if (fresh.length) log.autoev(`Next ${fresh.length}: ${fresh.map((r) => `${desc(r)} ${fmtAmerican(r.odds)} (${fmtPct(r.ev)} EV)`).join(', ')}`);
  for (const r of batch) startBet(r, scanAt, { pollAt: tickAt, via: 'scan' });
}

const bookQueue = new Map();   // book -> promise of its last queued bet (books with oneAtATime)
const bookWaiting = new Map(); // book -> bets started or waiting (books with oneAtATime)
function startBet(row, scanAt, t = {}) {
  const k = `${row.book}|${groupKey(row)}`;
  const book = books[row.book];
  // At most 2 bets queued per one-at-a-time book, so they don't fill every in-flight slot; the
  // rest come back next scan with a fresh price.
  if (book.oneAtATime && (bookWaiting.get(row.book) || 0) >= 2) return;
  holdPassed(row);
  const ctx = { scanAt, pollAt: t.pollAt ?? scanAt, via: t.via || 'scan', startAt: Date.now(), attempts: [] };
  inflight.set(k, row);
  // A book with one shared bet slip (theScore) takes one bet at a time: with two picks on its slip
  // it refused bets ("You cannot parlay selections from related markets", Austin's log 2026-11-23).
  // Each waits for the one before it, including taking its pick off the slip.
  const run = async () => {
    if (!book.oneAtATime) return tryBet(row, ctx);
    bookWaiting.set(row.book, (bookWaiting.get(row.book) || 0) + 1);
    const prev = bookQueue.get(row.book) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    bookQueue.set(row.book, prev.then(() => mine));
    await prev;
    ctx.startAt = Date.now();
    try {
      const ok = await tryBet(row, ctx).catch((e) => { ctx.outcome = 'error'; log.err(`${book.label}: ${e.message}`); return false; });
      await book.done?.(row, ctx.quote, ok)?.catch?.(() => {});
      ctx.doneCalled = true;
      return ok;
    } finally { release(); bookWaiting.set(row.book, bookWaiting.get(row.book) - 1); }
  };
  run()
    .catch((e) => { ctx.outcome = 'error'; log.err(`${book.label}: ${e.message}`); return false; })
    .then((ok) => {
      inflight.delete(k);
      if (!ctx.doneCalled) book.done?.(row, ctx.quote, ok)?.catch?.(() => {});   // e.g. theScore: take the pick off its bet slip
      if (row.isProp) propFunnel?.outcome(row, ctx.outcome);
      try {
        const sh = shadowOpen.get(holdKey(row));
        if (sh && ctx.outcome && sh.outcome !== 'placed') sh.outcome = ok ? 'placed' : ctx.outcome;
        if (!ok && ctx.outcome && ctx.outcome !== 'EV too low') {
          const bo = ctx.realOdds ?? ctx.quote?.odds;
          noteSkip(row, 'book', ctx.outcome, `${books[row.book]?.label || row.book}: ${ctx.outcome}${bo != null ? `, book price ${fmtAmerican(bo)}` : ''}${row.gambitOdds != null || bo != null ? `, ${feedName} showed ${fmtAmerican(row.gambitOdds ?? row.odds)}` : ''}`, bo);
        }
      } catch (e) { log.debug(`skipped log: ${e.message}`); }
      if (ctx.attempts.length) logTiming(row, book, ctx);
      const now = Date.now();
      const w = watch.get(row.id);
      if (ok) { watch.delete(row.id); held.delete(holdKey(row)); }
      // Held at the book's price: no cooldown, later scans run it again once the hold is over.
      else if (ctx.outcome === 'held') { watch.delete(row.id); cooldown.delete(row.id); }
      else if (ctx.pausedUntil) cooldown.set(row.id, ctx.pausedUntil);
      // A fresh-jump or Gambit-behind skip only waits for Gambit to catch up, so it's watched on every book.
      else if ((book.freePriceCheck || ctx.outcome === 'fresh jump' || ctx.outcome === 'Gambit behind') && WATCH_MS > 0 && ctx.quote && (!ctx.sent || ctx.priceMoved) && (!w || now - w.since < WATCH_MS)) {
        if (!w) watch.set(row.id, { since: now, sig: ctx.sig });
        // Check it again next scan, or after the book's recheckWatchSec (DraftKings: 5s).
        const gap = Number(cfg[row.book]?.recheckWatchSec ?? book.recheckWatchSec ?? 0);
        if (gap > 0) cooldown.set(row.id, now + gap * 1000); else cooldown.delete(row.id);
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
          source: row.direct === true ? (row.shadow ? `${row.book} (Gambit row from another book)` : row.book) : (row.src || 'gambit'),
          watching: w ? Math.round((now - w.since) / 1000) + 's' : '',
          outcome: ctx.outcome || '',
        });
      }
    });
}

// Where the seconds went for a bet that was sent: one log line and a bet-timing.csv line.
const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '?');
function logTiming(row, book, ctx) {
  const a0 = ctx.attempts[0], aN = ctx.attempts.at(-1);
  const fast = ctx.via === 'fast';
  const t = {
    findMs: ctx.checkStartAt - ctx.pollAt,
    gambitMs: fast ? null : ctx.scanAt - ctx.pollAt,
    bookPricesMs: fast ? ctx.checkStartAt - ctx.pollAt : ctx.checkStartAt - ctx.scanAt,
    checkMs: ctx.checkedAt - ctx.checkStartAt,
    rulesMs: a0.sentAt - ctx.checkedAt,
    answerMs: a0.answeredAt - a0.sentAt,
    totalMs: aN.answeredAt - ctx.pollAt,
  };
  const delay = Number(ctx.quote?.betDelaySec);
  const bookDelaySec = Number.isFinite(delay) && delay > 0 ? delay : null;
  log.info(`timing: ${desc(row)} (${ctx.outcome || '?'}): found ${secs(t.findMs)} after ${fast ? 'the fast price check started' : `the ${feedName} poll (${feedName} ${secs(t.gambitMs)}, book prices ${secs(t.bookPricesMs)})`}, re-check ${secs(t.checkMs)}, our rules ${secs(t.rulesMs)}, ${book.label} answered ${secs(t.answerMs)} after we sent it${bookDelaySec ? ` (its live bet delay is ${bookDelaySec}s)` : ''}${ctx.attempts.length > 1 ? `, ${ctx.attempts.length - 1} price-moved re-tr${ctx.attempts.length > 2 ? 'ies' : 'y'}` : ''}, total ${secs(t.totalMs)}`);
  timingLog.record({
    time: new Date().toISOString(), book: row.book, live: row.isLive ? 'live' : 'pre-game', event: row.event, market: row.market,
    selection: row.selection, line: row.line, odds: a0.odds, outcome: ctx.outcome || '', foundBy: ctx.via,
    ...t, bookDelaySec, retries: ctx.attempts.length - 1,
  });
}

// Fast price check (Austin, 2026-11-23): between Gambit polls, every fastPrices.everySec (default
// 1s) read the books' own prices again for the rows of the last scan that are close to min EV
// (within fastPrices.marginPts, default 3) and pass the rules that don't depend on the price. A
// row that now clears min EV at the book's real price goes through every rule (pickBets) and is
// re-checked at the book before it's bet, exactly like a bet found by a scan. The fair price is
// still the last Gambit poll's, and the live sharp-move rule still counts from Gambit's polls.
// "fastPrices": {"everySec": 0} turns it off. Books plug in through their livePrices().
const fastCfg = { everySec: 1, marginPts: 3, max: 20, ...(cfg.fastPrices || {}) };
const fastBusy = {};
let fastRunning = false;
async function fastTick() {
  if (fastRunning || !lastScan || inflight.size >= maxInFlight) return;
  if (!dryRun && !bridge.connected()) return;
  // Only off a recent scan: the fair prices and sharp-move times come from it.
  if (Date.now() - lastScan.doneAt > Math.max(10e3, 3 * pollSeconds * 1000)) return;
  fastRunning = true;
  const startedAt = Date.now();
  try {
    const now = Date.now(), groups = groupTotals(state.placed);
    const found = [];
    await Promise.all(Object.entries(books).map(async ([n, b]) => {
      if (!b.livePrices || directBusy[n] || fastBusy[n]) return;
      const hot = lastScan.rows.filter((r) => r.book === n && r.direct !== 'gone' && Number.isFinite(r.ev)
          && r.ev >= minEv(r) - fastCfg.marginPts && !(r.isProp && propsOff(cfg, r.book)) && !tooEarly(r) && !sharpTooOld(r)
          && groupRoom(cfg, groups, r) != null && sameEvRepeat(cfg, groups, r) == null && (cooldown.get(r.id) || 0) < now
          && ![...inflight.values()].some((f) => groupClash(cfg, r, f)))
        .sort((x, y) => y.ev - x.ev).slice(0, fastCfg.max);
      if (!hot.length) return;
      const copies = hot.map((r) => ({ ...(lastScan.gambitRows.get(r.id) || r) }));
      fastBusy[n] = true;
      try { await b.livePrices(copies, -Infinity); }
      catch { return; }   // the next scan says if a book's prices can't be read
      finally { fastBusy[n] = false; }
      found.push(...copies.filter((r) => r.direct === true));
    }));
    if (!found.length) return;
    // A watched bet (its last check failed) only goes again once the book's price is different.
    const fresh = found.filter((r) => { const w = watch.get(r.id); return !w || String(w.sig).split('|')[0] !== String(r.odds); })
      // Live price match: a live price that isn't the table's is skipped at the book anyway, so it isn't checked.
      .filter((r) => !(r.isLive && behindCfg(r.book)?.exact && r.gambitOdds != null && r.gambitOdds !== r.odds));
    const { ev } = pickBets(fresh, { quiet: true });
    const batch = ev.slice(0, Math.max(0, maxInFlight - inflight.size));
    if (!batch.length) return;
    log.autoev(`Fast price check, next ${batch.length}: ${batch.map((r) => `${desc(r)} ${fmtAmerican(r.odds)} (${fmtPct(r.ev)} EV${r.gambitOdds != null && r.gambitOdds !== r.odds ? `, ${feedName} showed ${fmtAmerican(r.gambitOdds)}` : ''})`).join(', ')}`);
    for (const r of batch) startBet(r, startedAt, { pollAt: startedAt, via: 'fast' });
  } finally { fastRunning = false; }
}
if (Number(fastCfg.everySec) > 0) setInterval(() => { fastTick().catch((e) => log.debug(`fast price check: ${e.message}`)); }, Math.max(250, Number(fastCfg.everySec) * 1000));

log.info(`${dryRun ? 'DRY RUN — nothing is sent to a sportsbook. ' : ''}books=${cfg.books.join(',')} minEV=${cfg.minEvPct}%${pregameMinEv != null ? ` (pre-game ${pregameMinEv}%)` : ''}${(cfg.minEvByOdds || []).map((b) => ` (${b.minEvPct}% at ${fmtAmerican(b.from)}..${fmtAmerican(b.to)})`).join('')}${Object.entries(cfg.longOddsProps || {}).map(([bk, r]) => ` (${bk === 'all' ? 'all books' : bk} props over ${cfg.maxOdds == null ? 'any' : fmtAmerican(cfg.maxOdds)}${r.maxOdds != null ? ` to ${fmtAmerican(r.maxOdds)}` : ''}: ${r.minEvPct}%${cfg.longPropConsensus.enabled ? `, ${cfg.longPropConsensus.minBooks}+ of ${Object.keys(cfg.longPropConsensus.books).join('/')} within ${cfg.longPropConsensus.maxPts} pts` : ''})`).join('')} softBooks=${cfg.softCheck.enabled ? `${cfg.softCheck.minBooks}+ of ${Object.keys(cfg.softCheck.books).join('/')} >${cfg.softCheck.minEvPct}%` : 'off'} pinnacleVsMarket=${cfg.marketCheck.enabled ? `<=${cfg.marketCheck.maxPts}pts over ${cfg.marketCheck.minBooks}+ soft books` : 'off'} sharpOut=${(cfg.sharp.excludeBooks || []).join(',') || 'none'} predictionMarkets=${cfg.sharp.predictionMarkets.enabled ? `${cfg.sharp.predictionMarkets.books.join('/')} at $${cfg.sharp.predictionMarkets.minLiquidity}+ thinner side, <=${cfg.sharp.predictionMarkets.maxHoldPct}c spread, ${(cfg.sharp.predictionMarkets.agreeBooks || []).join('/')} within ${cfg.sharp.predictionMarkets.agreePts}pts${cfg.sharp.predictionMarkets.inFair ? ' (in fair)' : ''}` : 'off'} novig=${novig ? `>=${novig.minEvPct}% (${novig.mode})` : 'off'} odds=${cfg.minOdds == null ? 'any' : fmtAmerican(cfg.minOdds)}..${cfg.maxOdds == null ? 'any' : fmtAmerican(cfg.maxOdds)} maxEV=${cfg.maxEvPct ?? 'off'}% (props ${cfg.maxPropEvPct == null ? 'no cap' : cfg.maxPropEvPct + '%'}) propHold=${holdCfg ? `over ${holdCfg.evPct}% EV for ${holdMs / 1000}s${holdCfg.liveTiming === true ? '' : ', no live FanDuel timing rule'}` : 'off'} sharpSpread<=${cfg.sharp.maxSpreadPts ?? 'off'}pts liveSharpAge<=${cfg.sharp.liveMaxAgeSec ?? 'off'}s (props ${cfg.sharp.livePropMaxAgeSec ?? 'off'}s) group=${cfg.group.maxBets ?? 'any'} bet (pre-game ${cfg.group.pregameMaxBets ?? cfg.group.maxBets ?? 'any'})/$${cfg.group.maxStake ?? 'any'} every ${cfg.group.cooldownSec || 0}s pregame<=${cfg.pregameMaxHours == null ? 'any' : cfg.pregameMaxHours + 'h'} stake=$${cfg.stake.amount} poll=${pollSeconds}s fastPrices=${Number(fastCfg.everySec) > 0 ? `every ${fastCfg.everySec}s within ${fastCfg.marginPts} pts` : 'off'} atOnce=${maxInFlight} recheckWatch=${WATCH_MS / 60e3}min`);
{
  const lpm = cfg.livePriceMatch && cfg.livePriceMatch.enabled !== false ? cfg.livePriceMatch : null;
  const ppc = cfg.pregamePinnacleCheck, pmb = cfg.pmBelowFair, pot = cfg.pinnacleOnlyTotals;
  const byBook = Object.entries(cfg.stake.byBook || {}).map(([b, v]) => `${BOOK_LABELS[b] || b}${v.pregame != null ? ` pre-game $${v.pregame}` : ''}${v.live != null ? ` live $${v.live}` : ''}${v.amount != null ? ` $${v.amount}` : ''}${v.fallback != null ? ` (refused: book max, else $${v.fallback})` : ''}`).join(', ');
  log.info(`stakes: $${cfg.stake.amount}${byBook ? `, ${byBook}` : ''}; livePrice=${lpm ? `must match the table on ${Array.isArray(lpm.books) ? lpm.books.join('/') : 'every book'}${lpm.onRetry !== false ? ' (also on price moves while placing)' : ''}` : 'gambitBehind rules'}` +
    ` liveEvProps=${Object.keys(books).filter((b) => liveEvPropOff(cfg, { book: b, isLive: true, isProp: true })).map((b) => `${BOOK_LABELS[b] || b} off`).join(', ') || 'on'}` +
    ` pinnacleOnlyTotals=${pot && pot.enabled !== false ? `skip on ${(pot.books || []).join('/')}${pot.live === false ? '' : ' live'}${pot.pregame === true ? ' pre-game' : ''}` : 'off'}` +
    ` predictionMarketBelowFair=${pmb && pmb.enabled !== false ? `skip at ${pmb.pts}+ pts on ${(pmb.markets || []).join('/')}` : 'off'}` +
    ` pregamePinnacle=${ppc && ppc.enabled !== false ? `within ${ppc.maxPts} pts of ${Object.keys(ppc.books || {}).join(' and ')} (not priced: ${ppc.missing === 'pass' ? 'bet' : 'skip'})` : 'off'}` +
    ` logs=${[skippedLog && 'skipped.csv', shadowLog && `shadow-bets.csv (${shadowCfg.minEvPct}%+ EV)`].filter(Boolean).join(', ') || 'off'}`);
}
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
  // Checked every 15s; each book is read once every everyMinutes, but until its first good
  // read (and after a failed one) every minute, so bets that settled while the app was off
  // fill in right after it starts.
  const syncResults = () => rs.sync().catch(() => {});
  setTimeout(syncResults, 15e3); setInterval(syncResults, 15e3);
}

log.info(`${betLog.summaryLine()} (ev-placer bets for details, file ${path.basename(betLog.csvPath)})`);
// Give the Chrome extension a few seconds to connect before the first scan.
if (bridge) for (let i = 0; i < 20 && !bridge.connected(); i++) await new Promise((r) => setTimeout(r, 250));
if (bridge && !bridge.connected()) log.warn('Chrome extension not connected yet: is Chrome open with the EV Placer extension loaded?');
session.start();
const loop = async () => { await tick(); setTimeout(loop, pollSeconds * 1000); };
loop();
process.on('SIGINT', () => { save(); try { propFunnel?.flush(); } catch {} console.log(); process.exit(0); });
// Bets still listed when the app stops go into shadow-bets.csv with what was seen so far.
process.on('exit', () => { try { shadowFlushAll(); } catch {} });
