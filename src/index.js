#!/usr/bin/env node
// Auto +EV placer: poll Gambit -> filter by EV -> re-check live price at the book -> place.
import fs from 'node:fs';
import path from 'node:path';
import { evPct, fmtAmerican, fmtPct } from './ev.js';
import { log } from './log.js';
import { makeGambitSource } from './sources/gambit.js';
import { makeMockSource } from './sources/mock.js';
import { startBridge } from './books/bridge.js';
import { makeBooks, BOOK_LABELS } from './books/index.js';
import { appDir } from './paths.js';
import { ensureConfig, writeExtension, extensionChanged } from './setup.js';
import { VERSION } from './version.js';
import embedded from './embedded.js';
import { checkForUpdate, cleanupOld } from './update.js';
import { makeNovig } from './novig.js';

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

  --min-ev 12            override minimum EV %
  --novig-min-ev 2       Novig must also show at least this EV % (default 2)
  --no-novig             don't require Novig to agree
  --books betrivers,fanduel
  --config other.json    use a different config file
  --dry-run              simulate the book, never place
  --source mock          use the fake Gambit feed
  --no-update            skip the update check at startup

  Files live in: ${appDir}`);
  process.exit(0);
}
if (flag('--version') || flag('-v')) { console.log(VERSION); process.exit(0); }

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
if (opt('--books')) cfg.books = opt('--books').split(',');
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

const useMock = opt('--source', 'gambit') === 'mock';
// The extension is needed to place bets, and also to read Gambit through your logged-in tab.
const needBridge = !dryRun || (!useMock && (cfg.gambit?.via || 'extension') === 'extension');
const bridge = needBridge ? startBridge(cfg.bridgePort || 8765, { reloadExtension: extensionChanged }) : null;
const source = useMock ? makeMockSource(cfg) : makeGambitSource(cfg, bridge);
const books = makeBooks(cfg, bridge, dryRun);
const novig = makeNovig(cfg); // null = Novig check turned off

// Persistent state: what we've already bet and how much today.
const statePath = path.join(root, dryRun ? 'state.dry.json' : 'state.json');
const today = () => new Date().toISOString().slice(0, 10);
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { placed: [], day: today(), staked: 0 };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const cooldown = new Map(); // row.id -> retry-after ms
const COOLDOWN_MS = 5 * 60 * 1000;

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
  log.header(`${desc(row)} ${fmtAmerican(row.odds)} (${fmtPct(row.ev)} EV) — ${row.event}`);

  let quote;
  try { quote = await book.recheck(row); }
  catch (e) { log.warn(`${book.label}: re-check error: ${e.message}`); return false; }

  if (!Number.isFinite(quote.odds)) { log.warn(`${book.label}: re-check returned no price — skipped`); return false; }
  if (quote.suspended) { log.warn(`${book.label}: market suspended — skipped`); return false; }
  if (row.line != null && quote.line != null && quote.line !== row.line) {
    log.warn(`${BOOK_LABELS[row.book]}: line moved (Gambit priced ${row.line}, ${book.label} line is now ${quote.line}) — skipped, nothing placed`);
    return false;
  }
  const ev = evPct(quote.odds, row.fairOdds);
  const tail = `${fmtAmerican(quote.odds)} vs fair ${fmtAmerican(row.fairOdds)} from ${row.fairBooks ?? '?'} book(s) -> ${fmtPct(ev)} EV` +
    (quote.maxStake ? ` (max stake $${quote.maxStake})` : '');
  if (ev < cfg.minEvPct) { log.warn(`${book.label}: re-check FAIL: ${tail}`); return false; }
  log.bet(`${book.label}: re-check OK: ${tail}`);

  // Novig has to agree at the live price too.
  let novigEvPct = null;
  if (novig) {
    const nc = novig.check(row, quote.odds);
    if (!nc.ok) {
      log.warn(nc.nv ? `Novig FAIL: ${fmtAmerican(quote.odds)} vs Novig ${fmtNovig(nc.nv)} -> ${fmtPct(nc.ev)} EV (need ${novig.minEvPct}%) — skipped, nothing placed`
        : 'Novig FAIL: Novig has no price for this selection — skipped, nothing placed');
      return false;
    }
    novigEvPct = nc.ev;
    log.bet(`Novig OK: ${fmtAmerican(quote.odds)} vs Novig ${fmtNovig(nc.nv)} -> ${fmtPct(nc.ev)} EV`);
  }

  const stake = stakeFor(quote);
  if (stake <= 0) { log.warn('stake is 0 — skipped'); return false; }
  if (cfg.dailyStakeLimit && state.staked + stake > cfg.dailyStakeLimit) {
    log.warn(`daily stake limit $${cfg.dailyStakeLimit} reached — skipped`); return false;
  }
  try {
    const { betId } = await book.place(row, stake, quote);
    state.placed.push({ at: new Date().toISOString(), key: selKey(row), event: row.event, book: row.book,
      market: row.market, selection: row.selection, line: row.line, odds: quote.odds, fair: row.fairOdds, ev, novigEv: novigEvPct, stake, betId });
    state.staked += stake; save();
    log.ok(`${BOOK_LABELS[row.book]} PLACED $${stake} @ ${fmtAmerican(quote.odds)} (${fmtPct(ev)} EV) bet_id=${betId}${dryRun ? ' [DRY RUN]' : ''}`);
    return true;
  } catch (e) { log.err(`${book.label}: place failed: ${e.message}`); return false; }
}

async function tick() {
  if (state.day !== today()) { state.day = today(); state.staked = 0; save(); }
  let rows;
  try { rows = await source.fetchRows(); }
  catch (e) { log.err(`Gambit fetch failed: ${e.message}`); return; }
  if (novig) {
    try { await novig.refresh(); }
    catch (e) { log.err(`Novig fetch failed: ${e.message} — not placing`); return; }
  }

  rows = rows.filter((r) => books[r.book]);
  const placedKeys = new Set(state.placed.map((p) => p.key));
  const perEvent = {};
  for (const p of state.placed) perEvent[p.event] = (perEvent[p.event] || 0) + 1;
  const now = Date.now();
  let ev = rows
    .filter((r) => Number.isFinite(r.ev) && r.ev >= cfg.minEvPct)
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

log.info(`${dryRun ? 'DRY RUN — nothing is sent to a sportsbook. ' : ''}books=${cfg.books.join(',')} minEV=${cfg.minEvPct}% novig=${novig ? `>=${novig.minEvPct}% (${novig.mode})` : 'off'} stake=$${cfg.stake.amount} poll=${cfg.pollSeconds}s`);
const loop = async () => { await tick(); setTimeout(loop, (cfg.pollSeconds || 6) * 1000); };
loop();
process.on('SIGINT', () => { save(); console.log(); process.exit(0); });
