#!/usr/bin/env node
// Auto +EV placer: poll Gambit -> filter by EV -> re-check live price at the book -> place.
import fs from 'node:fs';
import path from 'node:path';
import { evPct, fmtAmerican, fmtPct } from './ev.js';
import { log } from './log.js';
import { makeGambitSource } from './sources/gambit.js';
import { makeMockSource } from './sources/mock.js';
import { startBridge } from './books/bridge.js';
import { makeBooks, parseBooks, BOOK_LABELS } from './books/index.js';
import { makeHardRock } from './books/hardrock.js';
import { makeResults, betKey } from './results.js';
import readline from 'node:readline/promises';
import { appDir } from './paths.js';
import { ensureConfig, writeExtension, extensionChanged } from './setup.js';
import { VERSION } from './version.js';
import embedded from './embedded.js';
import { checkForUpdate, cleanupOld } from './update.js';
import { makeNovig } from './novig.js';
import { seenBooks } from './sources/gambit-evs.js';
import { makeBetLog } from './betlog.js';
import { writeSnapshot, serveReport, openInBrowser } from './report.js';

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
const source = useMock ? makeMockSource(cfg) : makeGambitSource(cfg, bridge);
const books = makeBooks(cfg, bridge, dryRun);
for (const b of Object.values(books)) {
  if (b.ready === false) { log.err(`${b.label}: ${b.notReadyReason}`); process.exit(1); }
}
const novig = makeNovig(cfg); // null = Novig check turned off
const betLog = makeBetLog(root, { dryRun, log });

// Persistent state: what we've already bet and how much today.
const statePath = path.join(root, dryRun ? 'state.dry.json' : 'state.json');
const today = () => new Date().toISOString().slice(0, 10);
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { placed: [], day: today(), staked: 0 };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const cooldown = new Map(); // row.id -> retry-after ms
const COOLDOWN_MS = 5 * 60 * 1000;
const warnedNoRows = new Set();

const selKey = (r) => `${r.book}|${r.event}|${r.market}|${r.selection}`;
const desc = (r) => `${BOOK_LABELS[r.book] || r.book} ${r.market} ${r.selection === r.market ? '' : r.selection + ' '}${r.line ?? ''}`.replace(/\s+/g, ' ').trim();

const fmtNovig = (nv) => `${fmtAmerican(nv.odds)}${nv.oppOdds != null ? `/${fmtAmerican(nv.oppOdds)}` : ''}`;

function stakeFor(quote) {
  let s = cfg.stake.amount;
  if (cfg.stake.capAtMaxStake && quote.maxStake) s = Math.min(s, quote.maxStake);
  return Math.floor(s * 100) / 100;
}

async function tryBet(row) {
  const book = books[row.book];
  log.header(`${desc(row)} ${fmtAmerican(row.odds)} (${fmtPct(row.ev)} EV) — ${row.event}${row.book === 'hardrock' && row.gambitBookId ? ` [Gambit book ${row.gambitBookId}]` : ''}`);

  let quote;
  try { quote = await book.recheck(row); }
  catch (e) { log.warn(`${book.label}: re-check error: ${e.message}`); return false; }

  if (!Number.isFinite(quote.odds)) { log.warn(`${book.label}: re-check returned no price — skipped`); return false; }
  if (quote.suspended) { log.warn(`${book.label}: market suspended — skipped`); return false; }
  if (row.line != null && quote.line != null && quote.line !== row.line) {
    log.warn(`${BOOK_LABELS[row.book]}: line moved (Gambit priced ${row.line}, ${book.label} line is now ${quote.line}) — skipped, nothing placed`);
    return false;
  }
  return placeAt(row, book, quote);
}

// EV, Novig, stake limits, then place. If the book says the price changed and tells us the new
// one, everything is checked again at that price and the bet is sent once more.
async function placeAt(row, book, quote, retried = false) {
  if (tooLong(quote.odds)) { log.warn(`${book.label}: ${fmtAmerican(quote.odds)} is above the ${fmtAmerican(cfg.maxOdds)} cap — skipped, nothing placed`); return false; }
  const ev = evPct(quote.odds, row.fairOdds);
  const tail = `${fmtAmerican(quote.odds)} vs fair ${fmtAmerican(row.fairOdds)} from ${row.fairBooks ?? '?'} book(s) -> ${fmtPct(ev)} EV` +
    (quote.maxStake ? ` (max stake $${quote.maxStake})` : '');
  if (ev < cfg.minEvPct) { log.warn(`${book.label}: re-check FAIL: ${tail}`); return false; }
  log.bet(`${book.label}: re-check OK: ${tail}`);

  // Novig has to agree at the live price too.
  let novigEvPct = null, novigCheck = null;
  if (novig) {
    const nc = novig.check(row, quote.odds);
    if (!nc.ok) {
      log.warn(nc.nv ? `Novig FAIL: ${fmtAmerican(quote.odds)} vs Novig ${fmtNovig(nc.nv)} -> ${fmtPct(nc.ev)} EV (need ${novig.minEvPct}%) — skipped, nothing placed`
        : 'Novig FAIL: Novig has no usable price for this selection (missing, or its two sides are from different lines) — skipped, nothing placed');
      return false;
    }
    novigEvPct = nc.ev; novigCheck = nc;
    log.bet(`Novig OK: ${fmtAmerican(quote.odds)} vs Novig ${fmtNovig(nc.nv)} -> ${fmtPct(nc.ev)} EV`);
  }

  const stake = stakeFor(quote);
  if (stake <= 0) { log.warn('stake is 0 — skipped'); return false; }
  if (cfg.dailyStakeLimit && state.staked + stake > cfg.dailyStakeLimit) {
    log.warn(`daily stake limit $${cfg.dailyStakeLimit} reached — skipped`); return false;
  }
  try {
    const { betId, confirmedOdds, detail } = await book.place(row, stake, quote);
    if (detail) log.debug(`${book.label} ${desc(row)} PLACED — ${detail}`);
    state.placed.push({ at: new Date().toISOString(), key: selKey(row), event: row.event, book: row.book,
      market: row.market, gambitBookId: row.gambitBookId, selection: row.selection, line: row.line, odds: quote.odds, fair: row.fairOdds, ev, novigEv: novigEvPct, stake, betId });
    state.staked += stake; save();
    // Paper trail: what we checked vs what the book says it accepted, plus Gambit's fair odds.
    // Dry runs: the simulated book "confirms" the price we sent.
    betLog.record({ row, quote, stake, betId, confirmedOdds: dryRun ? quote.odds : confirmedOdds, ev, novig: novigCheck });
    log.ok(`${BOOK_LABELS[row.book]} PLACED $${stake} @ ${fmtAmerican(quote.odds)} (${fmtPct(ev)} EV) bet_id=${betId}${dryRun ? ' [DRY RUN]' : ''}`);
    if (!dryRun) {
      if (confirmedOdds == null) log.bet(`${book.label} didn't report the accepted price; check bet ${betId} in your bet history (raw reply in debug.log)`);
      else if (confirmedOdds === quote.odds) log.bet(`${book.label} confirmed ${fmtAmerican(confirmedOdds)}, same as checked. Logged to bets.csv`);
      else log.warn(`${book.label} CONFIRMED ${fmtAmerican(confirmedOdds)}, NOT the ${fmtAmerican(quote.odds)} we checked: ${fmtPct(evPct(confirmedOdds, row.fairOdds))} EV at that price. Logged to bets.csv`);
    }
    return true;
  } catch (e) {
    if (e.detail) log.debug(`${book.label} ${desc(row)} — ${e.message}: ${e.detail}`);
    const hasNew = e.newOdds != null && Number.isFinite(e.newOdds);
    // Price moves and pulled markets are routine: one short line, details in debug.log.
    if (e.priceMoved) {
      if (hasNew && !retried) {
        log.warn(`${book.label}: price moved ${fmtAmerican(quote.odds)} → ${fmtAmerican(e.newOdds)}, checking again`);
        return placeAt(row, book, { ...quote, odds: e.newOdds }, true);
      }
      log.warn(`${book.label}: price moved${hasNew ? ` to ${fmtAmerican(e.newOdds)}` : ''} — skipped, nothing placed`);
      return false;
    }
    if (e.gone) { log.warn(`${book.label}: bet no longer offered — skipped, nothing placed`); return false; }
    log.err(`${book.label}: place failed: ${e.message}`);
    return false;
  }
}

async function tick() {
  if (state.day !== today()) { state.day = today(); state.staked = 0; save(); }
  let rows;
  try { rows = await source.fetchRows(); }
  catch (e) { log.err(`Gambit fetch failed: ${e.message}`); return; }
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
  const placedKeys = new Set(state.placed.map((p) => p.key));
  const perEvent = {};
  for (const p of state.placed) perEvent[p.event] = (perEvent[p.event] || 0) + 1;
  const now = Date.now();
  let ev = rows
    .filter((r) => Number.isFinite(r.ev) && r.ev >= cfg.minEvPct && !tooLong(r.odds))
    .filter((r) => !placedKeys.has(selKey(r)) && (cooldown.get(r.id) || 0) < now)
    .filter((r) => (perEvent[r.event] || 0) < (cfg.maxBetsPerEvent ?? Infinity))
    .filter((r) => dryRun || bridge.hasTab(r.book))
    .sort((a, b) => b.ev - a.ev);
  const gambitCount = ev.length;
  if (novig) ev = ev.filter((r) => novig.check(r, r.odds).ok);

  const nBooks = new Set(rows.map((r) => r.book)).size;
  log.scan(`${ev.length} +EV bets from ${rows.length} rows (${nBooks} book${nBooks === 1 ? '' : 's'})` +
    (novig ? `, ${gambitCount - ev.length} dropped because Novig doesn't show ${novig.minEvPct}%+` : ''), ev.length === 0);
  if (!ev.length) return;
  if (!dryRun && !bridge.connected()) { log.warn('Chrome extension not connected — not placing'); return; }

  const batch = ev.slice(0, cfg.betsAtOnce || 1);
  log.autoev(`Next ${batch.length} at once: ${batch.map((r) => `${desc(r)} ${fmtAmerican(r.odds)} (${fmtPct(r.ev)} EV)`).join(', ')}`);
  for (const r of batch) {
    const ok = await tryBet(r);
    if (!ok) cooldown.set(r.id, Date.now() + COOLDOWN_MS);
  }
}

log.info(`${dryRun ? 'DRY RUN — nothing is sent to a sportsbook. ' : ''}books=${cfg.books.join(',')} minEV=${cfg.minEvPct}% novig=${novig ? `>=${novig.minEvPct}% (${novig.mode})` : 'off'} maxOdds=${cfg.maxOdds == null ? 'off' : fmtAmerican(cfg.maxOdds)} stake=$${cfg.stake.amount} poll=${cfg.pollSeconds}s`);
// Results for the P&L chart: read Hard Rock's settled bets (My Bets > Settled) every few
// minutes while any logged Hard Rock bet has no result yet. Works on BetRivers days too,
// as long as a Hard Rock tab is open. "results": {"everyMinutes": 0} turns it off.
const resultsEvery = (cfg.results?.everyMinutes ?? 10) * 60e3;
const resultStore = makeResults(root, { dryRun });
const hrResults = !dryRun && bridge && resultsEvery > 0 ? (books.hardrock?.settled ? books.hardrock : makeHardRock('hardrock', 'Hard Rock Bet', cfg, bridge)) : null;
let resultsWarned = false;
async function syncResults() {
  if (!hrResults || !bridge.connected() || !bridge.hasTab('hardrock')) return;
  const have = resultStore.read();
  const waiting = betLog.bets().filter((b) => b.book === 'hardrock' && /^hardrock:\d+/.test(b.betId || '') && !have[betKey(b)]);
  if (!waiting.length) return;
  const byId = new Map(waiting.map((b) => [/^hardrock:(\d+)/.exec(b.betId)[1], b]));
  const from = Math.min(...waiting.map((b) => Date.parse(b.placedAt))) - 864e5;
  try {
    const settled = (await hrResults.settled(from)).filter((r) => byId.has(r.betId));
    resultsWarned = false;
    if (!settled.length) return;
    const n = resultStore.setMany(settled.map((r) => ({ key: betKey(byId.get(r.betId)), result: r.result, payout: r.payout, odds: r.odds, settledAt: r.settledAt })));
    if (!n) return;
    const profit = settled.reduce((s, r) => s + r.payout - (r.stake ?? byId.get(r.betId).stake), 0);
    const won = settled.filter((r) => r.result === 'won').length, lost = settled.filter((r) => r.result === 'lost').length;
    const other = settled.length - won - lost;
    log.info(`Results: ${n} Hard Rock bet${n === 1 ? '' : 's'} settled (${won} won, ${lost} lost${other ? `, ${other} other` : ''}), ${profit >= 0 ? '+' : '-'}$${Math.abs(profit).toFixed(2)}. Show bets for the P&L chart`);
  } catch (e) {
    if (!resultsWarned) log.warn(`Couldn't read Hard Rock's settled bets: ${e.message} (will keep trying)`);
    resultsWarned = true;
  }
}
if (hrResults) { setTimeout(syncResults, 15e3); setInterval(syncResults, resultsEvery); }

log.info(`${betLog.summaryLine()} (ev-placer bets for details, file ${path.basename(betLog.csvPath)})`);
// Give the Chrome extension a few seconds to connect before the first scan.
if (bridge) for (let i = 0; i < 20 && !bridge.connected(); i++) await new Promise((r) => setTimeout(r, 250));
if (bridge && !bridge.connected()) log.warn('Chrome extension not connected yet: is Chrome open with the EV Placer extension loaded?');
const loop = async () => { await tick(); setTimeout(loop, (cfg.pollSeconds || 6) * 1000); };
loop();
process.on('SIGINT', () => { save(); console.log(); process.exit(0); });
