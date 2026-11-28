// Player props funnel: which rule stops each prop Gambit lists, so we can see why few props
// get bet. Every scan, each prop row (one per book) is tagged with the first rule it fails, or
// "sent to re-check". Over a window (default 10 min) each prop counts once, at the furthest
// step it reached in any scan, so a prop that was 6% EV for 9 minutes and then got stopped by
// the FanDuel timing rule counts under the timing rule. Re-check results (placed, EV too low,
// place failed...) are counted too.
// Every window: a [PROPS] line on screen and one line in props-funnel.csv next to the app.
// "propsFunnel": {"everyMinutes": 0} in config.json turns it off.
import fs from 'node:fs';
import path from 'node:path';

/** Steps in funnel order. Labels are filled in from the config (EV and timing numbers). */
export const STAGES = ['gone', 'evLow', 'evNear', 'noProps', 'liveEvProps', 'odds', 'evCap', 'pregameFar', 'noSharp', 'sharpSpread', 'softBooks', 'longConsensus', 'pinnacleOff',
  'pinnacleOnlyTotal', 'pmBelow', 'pregamePinnacle', 'pregameBooks', 'stale',
  'group', 'sameEv', 'groupInFlight', 'cooldown', 'perEvent', 'livePropCap', 'playerStats', 'noTab', 'novig', 'held', 'dupInScan', 'sent'];

export function stageLabels(cfg) {
  const near = cfg.minEvPct - 3;
  return {
    gone: 'gone or line changed at the book',
    evLow: `under ${near}% EV`,
    evNear: `${near}-${cfg.minEvPct}% EV`,
    odds: `odds outside ${cfg.minOdds ?? 'any'}..${cfg.maxOdds ?? 'any'}`,
    evCap: `above the EV cap (${cfg.maxEvPct ?? 'no cap'}${cfg.maxEvPct != null ? '%' : ''}; props ${cfg.maxPropEvPct == null ? 'no cap' : cfg.maxPropEvPct + '%'})`,
    pregameFar: `pre-game, starts more than ${cfg.pregameMaxHours}h away`,
    noSharp: `no ${(cfg.sharp.livePropNeeds || []).join('/')} price (live) or ${(cfg.sharp.pregamePropNeeds || []).join('/')} (pre-game)`,
    sharpSpread: `sharp books more than ${cfg.sharp.maxSpreadPts} pts apart`,
    softBooks: `not above ${cfg.softCheck?.minEvPct ?? 0}% EV on ${cfg.softCheck?.minBooks ?? 2}+ soft books`,
    longConsensus: `over ${cfg.maxOdds ?? 'any'} without ${Object.keys(cfg.longPropConsensus?.books || {}).join('/')} within ${cfg.longPropConsensus?.maxPts} pts`,
    pinnacleOff: `Pinnacle more than ${cfg.marketCheck?.maxPts} pts above the soft-book median`,
    noProps: 'props off on this book',
    liveEvProps: 'live +EV-table prop on a book with those off (liveEvProps)',
    pinnacleOnlyTotal: `total on ${(cfg.pinnacleOnlyTotals?.books || []).join('/')} with a Pinnacle-only fair`,
    pmBelow: `a prediction market ${cfg.pmBelowFair?.pts ?? 2}+ pts below fair`,
    pregamePinnacle: `pre-game, Pinnacle not within ${cfg.pregamePinnacleCheck?.maxPts ?? 2} pts of ${Object.keys(cfg.pregamePinnacleCheck?.books || {}).join('/') || 'DraftKings/FanDuel'}${cfg.pregamePinnacleCheck?.missing === 'pass' ? '' : ' (or one not priced)'}`,
    pregameBooks: `pre-game, a book more than ${cfg.pregameBookCheck?.maxPts ?? 2} pts from the Pinnacle/prediction-market fair`,
    stale: `live, no sharp move in ${cfg.sharp.liveMaxAgeSec}s (props: ${(cfg.sharp.livePropNeeds || []).join('/')} in ${cfg.sharp.livePropMaxAgeSec ?? cfg.sharp.liveMaxAgeSec}s)`,
    group: 'group already bet',
    sameEv: `same bet already placed at EV within ${cfg.group.repeatMinEvPts} pts`,
    groupInFlight: 'same group being checked',
    cooldown: 'waiting after a failed try',
    perEvent: `game already has ${cfg.maxBetsPerEvent} bets (maxBetsPerEvent)`,
    livePropCap: `live game already has ${cfg.liveMaxPropsPerEvent} props (liveMaxPropsPerEvent)`,
    playerStats: `player already has ${cfg.maxPropStatsPerPlayer} stats bet`,
    noTab: 'book tab not open',
    novig: 'Novig check',
    held: `over ${cfg.propHold?.evPct}% EV, held ${cfg.propHold?.sec}s before the second check (propHold)`,
    dupInScan: 'other side/row of same group picked',
    sent: 'sent to re-check',
  };
}

const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function makePropFunnel(cfg, dir, { dryRun = false, log, now = () => Date.now() } = {}) {
  const everyMs = Number(cfg.propsFunnel?.everyMinutes ?? 10) * 60e3;
  if (!(everyMs > 0)) return null;
  const file = path.join(dir, dryRun ? 'props-funnel.dry.csv' : 'props-funnel.csv');
  const headerNow = ['time', 'minutes', 'props', 'live', 'preGame', ...STAGES, 'recheckResults'].join(',');
  // A file from an older version has other columns: keep it aside and start a new one.
  try {
    const first = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n', 1)[0].trim() : '';
    if (first && first !== headerNow) fs.renameSync(file, file.replace(/\.csv$/, `.old-${Date.now()}.csv`));
  } catch { /* in use: appends continue */ }
  const labels = stageLabels(cfg);
  const rank = Object.fromEntries(STAGES.map((s, i) => [s, i]));
  let start = now();
  let best = new Map();      // row id -> { stage, live }
  let outcomes = new Map();  // row id -> last re-check outcome
  let pending = [];

  function write(line, header) {
    pending.push(line);
    try {
      const head = fs.existsSync(file) ? '' : header + '\n';
      fs.appendFileSync(file, head + pending.join('\n') + '\n');
      pending = [];
    } catch { if (pending.length > 200) pending = pending.slice(-200); }   // Excel has it open: try next time
  }

  function flush() {
    const t = now();
    const minutes = (t - start) / 60e3;
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
    let live = 0;
    for (const v of best.values()) { counts[v.stage]++; if (v.live) live++; }
    const oc = {};
    for (const o of outcomes.values()) oc[o] = (oc[o] || 0) + 1;
    const ocText = Object.entries(oc).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join('; ');
    const header = headerNow;
    write([new Date(t).toISOString(), minutes.toFixed(1), best.size, live, best.size - live,
      ...STAGES.map((s) => counts[s]), cell(ocText)].join(','), header);
    const parts = STAGES.filter((s) => counts[s]).sort((a, b) => counts[b] - counts[a]).map((s) => `${counts[s]} ${labels[s]}`);
    log?.info(`[PROPS] last ${Math.round(minutes)} min: ${best.size} prop${best.size === 1 ? '' : 's'} on Gambit (${live} live)` +
      (parts.length ? `: ${parts.join(', ')}` : '') + (ocText ? `. Re-check: ${ocText}` : '') + ` (${path.basename(file)})`);
    start = t; best = new Map(); outcomes = new Map();
  }

  return {
    file,
    /** One prop row's step this scan. */
    note(row, stage) {
      const had = best.get(row.id);
      if (!had || rank[stage] > rank[had.stage]) best.set(row.id, { stage, live: !!row.isLive });
    },
    /** What the book re-check / placing did with a prop. */
    outcome(row, outcome) { if (outcome) outcomes.set(row.id, outcome); },
    /** Call once per scan; writes the window when it's due. */
    tick() { if (now() - start >= everyMs) flush(); },
    flush,
  };
}
