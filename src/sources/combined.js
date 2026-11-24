// "source": "both": Gambit and PropProfessor read side by side, one list of rows for the rules.
//  - Each source is fetched every poll; one failing doesn't stop the other (its error is passed on
//    to the session watch, so a logged-out site still raises the alarm).
//  - The same bet listed by both (same book, same bet id at the book) is kept once: Gambit's row,
//    unless "propprofessor": {"preferInBoth": true}.
//  - PropProfessor names games and teams its own way ("Kansas" vs Gambit's "Kansas Jayhawks"), so its
//    rows take the Gambit game name when the game is in Gambit's table too. That keeps "one bet per
//    game and market" (groups) working across both sources.
import { parseTime } from '../betlog.js';

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const inside = (x, y) => { const wy = new Set(words(y)); const wx = words(x); return wx.length > 0 && wx.every((w) => wy.has(w)); };
const sideMatch = (a, b) => inside(a, b) || inside(b, a);

/** Gambit's name for each PropProfessor game, matched by start time (within 3h) and both teams' names. */
export function alignEvents(ppRows, gambitRows) {
  const games = new Map();
  for (const r of gambitRows) if (!games.has(r.event)) games.set(r.event, { name: r.event, start: parseTime(r.startDate), sides: String(r.event).split(' @ ') });
  const list = [...games.values()].filter((g) => g.sides.length === 2);
  const cache = new Map();
  for (const r of ppRows) {
    if (!cache.has(r.event)) {
      const s = String(r.event).split(' @ ');
      const t = parseTime(r.startDate);
      const near = (g) => !Number.isFinite(t) || !Number.isFinite(g.start) || Math.abs(g.start - t) <= 3 * 3600e3;
      const hits = s.length !== 2 ? [] : list.filter((g) => near(g) && ((sideMatch(s[0], g.sides[0]) && sideMatch(s[1], g.sides[1])) || (sideMatch(s[0], g.sides[1]) && sideMatch(s[1], g.sides[0]))));
      cache.set(r.event, hits.length === 1 ? hits[0].name : null);
    }
    const name = cache.get(r.event);
    if (name && name !== r.event) { r.ppEvent = r.event; r.event = name; }
  }
}

export function makeCombinedSource(cfg, sources, { onError = () => {} } = {}) {
  const preferPP = cfg.propprofessor?.preferInBoth === true;
  const mergeFair = (fn) => () => {
    const m = new Map();
    for (const s of sources) {
      const f = s[fn]?.();
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
        else { errs.push(`${s.label}: ${g.reason?.message || g.reason}`); onError(s.name, g.reason); }
      });
      if (!Object.keys(by).length) throw new Error(errs.join('; '));
      if (by.propprofessor && by.gambit) alignEvents(by.propprofessor, by.gambit);
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
