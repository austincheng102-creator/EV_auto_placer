// "source": "both": Gambit and PropProfessor read side by side, one list of rows for the rules.
//  - Each source is fetched every poll; one failing doesn't stop the other (its error is passed on
//    to the session watch, so a logged-out site still raises the alarm).
//  - The same bet listed by both (same book, same bet id at the book) is kept once: Gambit's row,
//    unless "propprofessor": {"preferInBoth": true}.
//  - PropProfessor names games and teams its own way ("Kansas" vs Gambit's "Kansas Jayhawks"), so its
//    rows take the Gambit game name when the game is in Gambit's table too. That keeps "one bet per
//    game and market" (groups) and the per-game cap working across both sources. A match is kept
//    (24h), so the name doesn't flip back when the game drops out of Gambit's table for a poll.
import { parseTime, fairKey } from '../betlog.js';

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const inside = (x, y) => { const wy = new Set(words(y)); const wx = words(x); return wx.length > 0 && wx.every((w) => wy.has(w)); };
const sideMatch = (a, b) => inside(a, b) || inside(b, a);
const keyNorm = (s) => fairKey({ event: s, marketKey: '', selection: '', line: '' }).split('|')[0];

/** Keeps Gambit's games (24h) and which PropProfessor game names they match. */
export function makeAligner() {
  const games = new Map();    // Gambit name -> { name, start, sides, seen }
  const matched = new Map();  // PropProfessor name -> { name, at } (name null = no match yet)
  return {
    learn(gambitRows, now = Date.now()) {
      for (const r of gambitRows) {
        const g = games.get(r.event);
        if (g) { g.seen = now; continue; }
        const sides = String(r.event).split(' @ ');
        if (sides.length === 2) games.set(r.event, { name: r.event, start: parseTime(r.startDate), sides, seen: now });
      }
      for (const [k, g] of games) if (now - g.seen > 24 * 3600e3) games.delete(k);
      for (const [k, m] of matched) if (now - m.at > 24 * 3600e3) matched.delete(k);
    },
    /** Gambit's name for a PropProfessor game, or null. Only an unambiguous match (one game) counts. */
    nameFor(ppEvent, startDate, now = Date.now()) {
      const had = matched.get(ppEvent);
      if (had?.name) return had.name;
      if (had && now - had.at < 60e3) return null;   // looked up in the last minute, no match
      const s = String(ppEvent).split(' @ ');
      const t = parseTime(startDate);
      const near = (g) => !Number.isFinite(t) || !Number.isFinite(g.start) || Math.abs(g.start - t) <= 3 * 3600e3;
      const hits = s.length !== 2 ? [] : [...games.values()].filter((g) => near(g)
        && ((sideMatch(s[0], g.sides[0]) && sideMatch(s[1], g.sides[1])) || (sideMatch(s[0], g.sides[1]) && sideMatch(s[1], g.sides[0]))));
      const name = hits.length === 1 ? hits[0].name : null;
      matched.set(ppEvent, { name, at: now });
      return name;
    },
    /** PropProfessor name -> Gambit name, for every match made so far. */
    renames() { const m = new Map(); for (const [k, v] of matched) if (v.name) m.set(k, v.name); return m; },
  };
}

/** Renames PropProfessor rows' games to Gambit's. The row's sharpKey stays (the live timing rule's memory). */
export function alignEvents(ppRows, gambitRows, aligner = makeAligner()) {
  aligner.learn(gambitRows);
  for (const r of ppRows) {
    const name = aligner.nameFor(r.event, r.startDate);
    if (name && name !== r.event) { r.ppEvent = r.event; r.event = name; }
  }
  return aligner;
}

/** A fair index (fairKey -> fair) with PropProfessor game names swapped for Gambit's, so closing line
 *  value finds a bet logged under the Gambit name. */
export function renameFairIndex(index, renames) {
  if (!renames.size) return index;
  const pre = new Map([...renames].map(([pp, g]) => [keyNorm(pp), keyNorm(g)]));
  const out = new Map();
  for (const [k, v] of index) {
    const i = k.indexOf('|');
    const to = pre.get(k.slice(0, i));
    out.set(to ? to + k.slice(i) : k, v);
  }
  return out;
}

export function makeCombinedSource(cfg, sources, { onError = () => {} } = {}) {
  const preferPP = cfg.propprofessor?.preferInBoth === true;
  const aligner = makeAligner();
  const fairOf = (s, fn) => {
    const f = s[fn]?.();
    return f && s.name === 'propprofessor' ? renameFairIndex(f, aligner.renames()) : f;
  };
  const mergeFair = (fn) => () => {
    const m = new Map();
    for (const s of sources) {
      const f = fairOf(s, fn);
      if (f) for (const [k, v] of f) { const had = m.get(k); if (!had || v.prob < had.prob) m.set(k, v); }
    }
    return m;
  };
  const arbs = sources.map((s) => s.arb).filter(Boolean);
  return {
    name: 'both', label: sources.map((s) => s.label).join(' + '),
    needsBridge: sources.some((s) => s.needsBridge),
    fairIndex: mergeFair('fairIndex'),
    arbFairIndex: mergeFair('arbFairIndex'),
    arb: arbs[0] || null,
    async fetchRows() {
      const got = await Promise.allSettled(sources.map((s) => s.fetchRows()));
      const errs = [];
      const by = {};
      got.forEach((g, i) => {
        const s = sources[i];
        if (g.status === 'fulfilled') { by[s.name] = g.value; onError(s.name, null); }
        else { errs.push({ source: s.name, text: `${s.label}: ${g.reason?.message || g.reason}` }); onError(s.name, g.reason); }
      });
      if (!Object.keys(by).length) throw new Error(errs.map((e) => e.text).join('; '));
      if (by.gambit) aligner.learn(by.gambit);
      if (by.propprofessor) alignEvents(by.propprofessor, [], aligner);
      const order = preferPP ? ['propprofessor', 'gambit'] : ['gambit', 'propprofessor'];
      const out = [], have = new Set();
      for (const n of order) for (const r of by[n] || []) {
        const k = `${r.book}|${r.arb ? 'arb' : 'ev'}|${r.bookRef ?? r.optionId ?? r.id}`;
        if (have.has(k)) continue;
        have.add(k);
        out.push(r);
      }
      out.errors = errs;
      return out;
    },
  };
}
