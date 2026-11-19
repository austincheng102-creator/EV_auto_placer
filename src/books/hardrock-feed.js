// Hard Rock Bet's live prices, read the way app.hardrock.bet reads them (captured 2026-11-19):
//  - wss://api.hardrocksportsbook.com/graphql-ws, no login needed: SportsbookLoginRequest with
//    channel/locale, then SubscriptionRequest per game. Hard Rock then streams {"Market":...}
//    messages; each selection carries `rootIdx`, a step in Hard Rock's price ladder.
//  - the ladder (step -> decimal/American) comes from GET /sportsbook/v1/api/getRootLadder
//  - games come from GET /java-graphql/events (list) and /java-graphql/events/<id> (market types)
// Event messages also carry the game clock (period, time left), kept for later rules.
import WebSocket from 'ws';

const API = 'https://api.hardrocksportsbook.com';
const WS_URL = 'wss://api.hardrocksportsbook.com/graphql-ws';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = { accept: 'application/json', origin: 'https://app.hardrock.bet', referer: 'https://app.hardrock.bet/', 'user-agent': UA };
const STATES = { CO: 'COLORADO' };
const DEFAULT_SPORTS = ['BASKETBALL', 'AMERICAN_FOOTBALL', 'ICE_HOCKEY', 'BASEBALL', 'SOCCER'];

/** Ladder rows -> Map rootIndex -> { decimal, american }. */
export function parseLadder(j) {
  const rows = j?.PriceAdjustmentDetailsResponse?.rootLadder || [];
  const out = new Map();
  for (const r of rows) {
    const d = Number(r.decimal), a = Math.round(Number(r.moneyline));
    if (Number.isFinite(d) && d > 1 && Number.isFinite(a) && a !== 0) out.set(Number(r.rootIndex), { decimal: d, american: a });
  }
  return out;
}

/** Every market type a game shows (the site subscribes with these). */
export function eventMarketTypes(ev) {
  const t = new Set();
  for (const g of ev?.displayedGroups || []) {
    for (const x of g.types || []) t.add(x);
    for (const p of g.pills || []) for (const x of p.types || []) t.add(x);
  }
  return [...t];
}

/**
 * Applies one feed message to the selection and game maps. Hard Rock sends whole markets and
 * also partial ones (a selection with only a new rootIdx), so missing fields keep their value.
 */
export function applyMessage(j, sels, games, now = Date.now()) {
  // A new subscription answers with the game and its markets (the starting prices).
  const sub = j?.SubscriptionResponse?.data;
  if (sub?.markets) {
    for (const mk of sub.markets) applyMessage({ Market: { fullPath: `:${sub.id}|`, ...mk } }, sels, games, now);
    return 'snapshot';
  }
  const m = j?.Market;
  if (m) {
    const marketOpen = m.state == null ? undefined : m.state === 'OPEN' && m.displayed !== false;
    for (const s of m.selections || []) {
      if (!s?.id) continue;
      const prev = sels.get(s.id) || {};
      const eventId = /:(\d+)\|/.exec(s.fullPath || m.fullPath || '')?.[1] || prev.eventId;
      sels.set(s.id, {
        idx: s.rootIdx ?? prev.idx,
        active: s.state != null ? s.state === 'ACTIVE' && s.displayed !== false : prev.active,
        marketOpen: marketOpen ?? prev.marketOpen,
        eventId, name: s.name ?? prev.name,
        changedAt: s.rootIdx != null && s.rootIdx !== prev.idx ? now : prev.changedAt ?? now,
      });
    }
    return 'market';
  }
  const e = j?.Event;
  if (e?.id) {
    const g = games.get(e.id) || {};
    for (const k of ['matchPeriod', 'remainingTimeSecondsInPeriod', 'elapsedTimeSeconds', 'clockRunning', 'matchCompleted', 'pointsA', 'pointsB'])
      if (e[k] !== undefined) g[k] = e[k];
    g.clockAt = now;
    games.set(e.id, g);
    return 'event';
  }
  return null;
}

export function makeHardRockFeed(cfg, log) {
  const h = cfg.hardrock || {};
  const st = String(cfg.region || 'CO').toUpperCase();
  const channel = h.channel || `${STATES[st] || st}_ONLINE`;
  const segment = st.toLowerCase();
  const q = `channel=${channel}&segment=${segment}&region=us&language=enus`;
  const sports = h.feedSports || DEFAULT_SPORTS;
  const maxGames = h.feedMaxGames ?? 150;

  let ladder = null;
  const sels = new Map();        // selection id -> { idx, active, marketOpen, eventId, changedAt }
  const games = new Map();       // event id -> clock fields
  const subscribed = new Map();  // event id -> true
  const typesCache = new Map();  // event id -> market types
  let sock = null, open = false, lastMsg = 0, reqId = 0, started = false, timers = [];
  let warnedAt = 0;

  const get = async (path) => {
    const res = await fetch(`${h.feedApi || API}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Hard Rock ${path.split('?')[0]} HTTP ${res.status}`);
    return res.json();
  };
  const warn = (msg) => { if (Date.now() - warnedAt > 60e3) { warnedAt = Date.now(); log.warn(msg); } };
  const send = (o) => { if (open) sock.send(JSON.stringify(o)); };

  async function subscribeGames() {
    if (!open) return;
    const now = Date.now(), horizon = (cfg.pregameMaxHours ?? 12) * 3600e3;
    const want = [];
    for (const sport of sports) {
      for (const inplay of [true, false]) {
        try {
          const j = await get(`/java-graphql/events?${q}&sports=${sport}&outright=false&inplay=${inplay}&offset=0&limit=100&includeMarkets=false`);
          for (const e of j?.data || []) {
            const t = Number(e.eventTime);
            if (e.inplay || (Number.isFinite(t) && t - now < horizon)) want.push({ id: e.id, inplay: !!e.inplay, t });
          }
        } catch (e) { warn(`Hard Rock live prices: couldn't list ${sport} games (${e.message})`); }
      }
    }
    want.sort((a, b) => (b.inplay - a.inplay) || a.t - b.t);
    const keep = new Set(want.slice(0, maxGames).map((e) => e.id));
    const drop = [...subscribed.keys()].filter((id) => !keep.has(id));
    if (drop.length) { send({ SubscriptionRequest: { unsubscribe: { ids: drop } } }); for (const id of drop) subscribed.delete(id); }
    for (const id of keep) {
      if (subscribed.has(id)) continue;
      let types = typesCache.get(id);
      if (!types) {
        try { types = eventMarketTypes(await get(`/java-graphql/events/${id}?${q}`)); typesCache.set(id, types); }
        catch { continue; }
      }
      send({ SubscriptionRequest: { subscribe: { ids: [id], descendants: true, mostBalancedMarkets: false, marketTypes: types } } });
      subscribed.set(id, true);
    }
    // Selections of games we no longer follow can't be trusted to be current.
    for (const [id, s] of sels) if (s.eventId && !subscribed.has(s.eventId)) sels.delete(id);
  }

  let gen = 0;
  function connect() {
    const my = ++gen;
    sock = new WebSocket(h.feedWsUrl || WS_URL, { headers: { origin: HEADERS.origin, 'user-agent': UA } });
    sock.on('open', () => {
      open = true; lastMsg = Date.now();
      send({ SportsbookLoginRequest: { application: 'sportsbook', channel, locale: `enus-us-x-${segment}` } });
      log.info('Hard Rock live prices: connected');
      subscribeGames().catch(() => {});
    });
    sock.on('message', (buf) => {
      lastMsg = Date.now();
      let j; try { j = JSON.parse(buf); } catch { return; }
      applyMessage(j, sels, games);
    });
    const down = () => {
      if (my !== gen) return;   // this connection was already handled
      gen++;
      open = false; sock = null; subscribed.clear(); sels.clear();
      warn('Hard Rock live prices: disconnected, reconnecting (using Gambit\'s Hard Rock prices meanwhile)');
      setTimeout(connect, 5000);
    };
    sock.on('close', down);
    sock.on('error', () => { try { sock?.terminate(); } catch {} down(); });
  }

  return {
    async start() {
      if (started) return;
      started = true;
      try { ladder = parseLadder(await get('/sportsbook/v1/api/getRootLadder')); }
      catch (e) { log.warn(`Hard Rock live prices: couldn't load the price table (${e.message}); using Gambit's Hard Rock prices`); started = false; return; }
      if (!ladder.size) { log.warn('Hard Rock live prices: price table was empty; using Gambit\'s Hard Rock prices'); started = false; return; }
      connect();
      timers.push(setInterval(() => send({ KeepAlive: { reqId: ++reqId } }), 10e3));
      timers.push(setInterval(() => subscribeGames().catch(() => {}), 60e3));
      timers.push(setInterval(() => { if (open && Date.now() - lastMsg > 45e3) { try { sock.terminate(); } catch {} } }, 15e3));
      for (const t of timers) t.unref?.();
    },
    /** True while the feed is connected and talking. */
    live: () => open && Date.now() - lastMsg < 30e3,
    /** Current price of a selection: { odds, decimal, suspended, changedAt } or null if the feed doesn't have it. */
    price(selectionId) {
      const s = sels.get(String(selectionId));
      // Only selections seen whole (state known), not ones we only got a partial update for.
      if (!s || s.idx == null || s.active == null || !ladder) return null;
      const p = ladder.get(Number(s.idx));
      if (!p) return null;
      return { odds: p.american, decimal: p.decimal, suspended: !(s.active !== false && s.marketOpen !== false), changedAt: s.changedAt };
    },
    clock: (eventId) => games.get(String(eventId)) || null,
    stats: () => ({ games: subscribed.size, selections: sels.size }),
  };
}
