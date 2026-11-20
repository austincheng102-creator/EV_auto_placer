// BetRivers runs on Kambi. Requests below match what co.betrivers.com itself sends
// (captured 2026-11-10):
//  - price check: Kambi's public offering API (no login), fetched directly by this app
//  - place:       POST coupon.json on Kambi's player API, sent from inside your logged-in
//                 BetRivers tab by the extension, so your session and location check apply
//  - live bets come back LIVE_DELAY_PENDING; we poll coupon/history until accepted or rejected
//  - auth: Kambi's player API needs the Authorization header the site sends; the extension
//    picks it up from your BetRivers tab's own requests
// Kambi units: odds and stake are x1000 (odds 1630 = 1.63 decimal, stake 1000 = $1), lines x1000.

import { decimalToAmerican, americanToDecimal } from '../ev.js';

const STATE = (cfg) => String(cfg.region || 'CO').toLowerCase();

export function kambiSettings(cfg) {
  const st = STATE(cfg);
  const b = cfg.betrivers || {};
  return {
    offering: b.offering || `rsius${st}`,
    market: b.market || `US-${st.toUpperCase()}`,
    offeringHost: b.offeringHost || 'https://eu.offering-api.kambicdn.com',
    authHost: b.authHost || `https://us${st}-auth-api.kambicdn.org`,
    clientId: b.clientId || 200,
  };
}

const kambiToAmerican = (k) => {
  const d = k / 1000;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
};

// One coupon from BetRivers' bet history (My Bets) as a result for results.json, or null if it
// isn't settled. Matches our bet log by couponRef (logged as "coupon:<ref>"). Kambi units:
// stake, payout and odds are all x 1000 (stake 1000 = $1, payout 2600 = $2.60, odds 2600 = 2.6).
// payout is the total return (0 for a loss), so profit = payout - stake whatever the status.
export function settledCoupon(c) {
  const b = c?.bets?.[0];
  if (!c?.couponRef || !b || (c.bets.length !== 1)) return null;
  const st = String(b.betStatus || '').toUpperCase();
  const result = /CASH/.test(st) ? 'cashout'
    : /HALF/.test(st) ? (/WON|WIN/.test(st) ? 'half-won' : 'half-lost')
    : /WON|WIN/.test(st) ? 'won' : /LOST|LOSE/.test(st) ? 'lost'
    : /PUSH/.test(st) ? 'push' : /VOID|CANCEL|REFUND/.test(st) ? 'void' : null;
  if (!result) return null;
  const ko = Number(b.playedOdds);
  return {
    betId: String(c.couponRef), result, status: st,
    payout: Math.round((Number(b.payout) || 0) / 10) / 100,
    stake: Number.isFinite(Number(b.stake)) ? Number(b.stake) / 1000 : null,
    odds: Number.isFinite(ko) && ko > 1000 ? decimalToAmerican(ko / 1000) : null,
    settledAt: null, placedAt: c.placedDate || null,
  };
}

export function makeBetRivers(name, label, cfg, bridge) {
  const k = kambiSettings(cfg);
  const qs = (extra = '') => `lang=en_US&market=${k.market}&client_id=${k.clientId}&channel_id=1${extra}`;
  const json = { accept: 'application/json, text/javascript, */*; q=0.01', 'content-type': 'application/json' };

  const quoteOf = (oc, bo) => ({
    odds: oc.oddsAmerican != null ? Number(oc.oddsAmerican) : kambiToAmerican(oc.odds),
    kambiOdds: oc.odds,
    line: oc.line != null ? oc.line / 1000 : null,   // signed, from the bettor's side, like Gambit's
    suspended: oc.status !== 'OPEN',
    maxStake: null,
    betOfferId: bo.id, eventId: bo.eventId,
    changedAt: oc.changedDate || null,               // when BetRivers last changed this price
    at: Date.now(),
  });

  // Several outcomes per request (id=1,2,3). If Kambi turns that down, one request per outcome.
  let manyIds = cfg.betrivers?.manyIdsPerRequest !== false;
  async function outcomes(ids) {
    const out = new Map();
    const get = async (list) => {
      const url = `${k.offeringHost}/offering/v2018/${k.offering}/betoffer/outcome.json?${qs(`&ncid=${Date.now()}`)}&id=${list.join(',')}`;
      const res = await fetch(url, { headers: { accept: json.accept }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) { const e = new Error(`Kambi price HTTP ${res.status}`); e.status = res.status; throw e; }
      const j = await res.json();
      let n = 0;
      for (const bo of j.betOffers || []) for (const oc of bo.outcomes || []) { out.set(String(oc.id), quoteOf(oc, bo)); n++; }
      return n;
    };
    const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); })); };
    if (manyIds && ids.length > 1) {
      const chunks = [];
      for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40));
      try {
        const counts = [];
        await pool(chunks, 4, async (c) => counts.push(await get(c)));
        // Only one outcome back for a long list: Kambi read just the first id.
        if (!(chunks[0].length >= 5 && Math.max(...counts) <= 2)) return out;
      } catch (e) { if (!(e.status >= 400 && e.status < 500)) throw e; }
      manyIds = false;
      out.clear();
    }
    await pool(ids, 8, async (id) => { try { await get([id]); } catch {} });
    return out;
  }

  async function inTab(kind, url, method = 'GET', body) {
    const res = await bridge.send(name, { kind, url, method, headers: json, body, useKambiAuth: true }, 20000);
    return res;
  }

  return {
    name, label,
    // The price check is a public read of BetRivers' odds (no bet, no login), so a bet whose
    // check failed can be checked again on every scan.
    freePriceCheck: true,

    // Reads BetRivers' real prices for these rows, straight from BetRivers (public, no login),
    // and puts them in place of Gambit's copy, so the scan sees the price you'd actually get.
    // Rows within `directMarginPts` of minEvPct on Gambit's numbers are read (up to directMax).
    // Gambit's fair price stays. Returns counts for the scan line.
    async livePrices(rows, minEvPct) {
      const b = cfg.betrivers || {};
      const margin = b.directMarginPts ?? 5, max = b.directMax ?? 300;
      const want = rows.filter((r) => r.book === name && r.bookRef && Number.isFinite(r.ev) && r.ev >= minEvPct - margin)
        .sort((x, y) => y.ev - x.ev).slice(0, max);
      const ids = [...new Set(want.map((r) => String(r.bookRef)))];
      const st = { read: 0, moved: 0, gone: 0, shadowNew: 0 };
      if (!ids.length) return st;
      const got = await outcomes(ids);
      for (const r of want) {
        const q = got.get(String(r.bookRef));
        r.gambitOdds = r.odds; r.gambitEv = r.ev;
        if (!q || q.suspended || (r.line != null && q.line != null && q.line !== r.line)) { r.direct = 'gone'; r.ev = -Infinity; st.gone++; continue; }
        st.read++;
        if (q.odds !== r.odds) st.moved++;
        r.direct = true; r.directQuote = q; r.odds = q.odds;
        r.ev = (r.fairProb * americanToDecimal(q.odds) - 1) * 100;
        if (r.shadow && r.ev >= minEvPct) st.shadowNew++;
      }
      return st;
    },

    async recheck(row) {
      if (!row.bookRef) throw new Error('no BetRivers outcome id on this Gambit row');
      // Price read from BetRivers in this same scan, under 1.5s ago: that's already a live check.
      if (row.directQuote && Date.now() - row.directQuote.at < 1500) return row.directQuote;
      const url = `${k.offeringHost}/offering/v2018/${k.offering}/betoffer/outcome.json?${qs(`&ncid=${Date.now()}`)}&id=${row.bookRef}`;
      const res = await fetch(url, { headers: { accept: json.accept }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Kambi price HTTP ${res.status}`);
      const j = await res.json();
      const bo = (j.betOffers || []).find((b) => (b.outcomes || []).some((o) => String(o.id) === String(row.bookRef)));
      const oc = bo?.outcomes.find((o) => String(o.id) === String(row.bookRef));
      if (!oc) return { odds: null, suspended: true };
      return quoteOf(oc, bo);
    },

    // Settled bets placed since `from` (ms), from the list behind My Bets > Settled on
    // co.betrivers.com. Read-only, so it works while the extension is disarmed. Needs the
    // site's x-auth-token, which the extension picks up from the BetRivers tab.
    async settled(from) {
      const site = cfg.betrivers?.siteHost || `https://${STATE(cfg)}.betrivers.com`;
      const cage = cfg.betrivers?.cageCode || '720';
      const out = [];
      for (let start = 0, page = 0; page < 20; page++, start += 50) {
        const res = await bridge.send(name, {
          kind: 'history', method: 'GET', useRsiAuth: true, headers: { accept: 'application/json, text/plain, */*' },
          url: `${site}/api/service/sportsbook/bethistory/coupons?status=SETTLED&rangeStart=${start}&rangeSize=50&cageCode=${cage}`,
        }, 20000);
        if (res.status === 401 || res.status === 403) throw new Error('BetRivers didn\'t accept the login: refresh the BetRivers tab and stay logged in');
        const items = res.json?.items;
        if (res.status >= 400 || !Array.isArray(items)) throw new Error(`bet history HTTP ${res.status}: ${JSON.stringify(res.json || res.text).slice(0, 200)}`);
        for (const c of items) { const r = settledCoupon(c); if (r) out.push(r); }
        // Newest first: stop once we're past the oldest bet we're waiting on.
        const oldest = Math.min(...items.map((c) => Date.parse(c.placedDate)).filter(Number.isFinite));
        if (!res.json?.range?.more || !items.length || oldest < from) break;
      }
      return out;
    },

    // Once a minute (session.js): the same "I'm still here" call co.betrivers.com makes, so the
    // site doesn't log you out for inactivity while the app runs. Also tells us if you're logged out.
    async sessionCheck() {
      const site = cfg.betrivers?.siteHost || `https://${STATE(cfg)}.betrivers.com`;
      const res = await bridge.send(name, {
        kind: 'session', method: 'POST', useRsiAuth: true, url: `${site}/api/service/sessions/portal/keepalive`,
        headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json; charset=utf-8' },
      }, 15000);
      const code = res.json?.code;
      if (res.status < 400 && code === 'OK') return { ok: true };
      if (res.status === 401 || res.status === 403 || (code && code !== 'OK')) return { ok: false, why: `BetRivers keepalive answered ${code || `HTTP ${res.status}`}` };
      throw new Error(`BetRivers keepalive HTTP ${res.status}: ${String(res.text || '').slice(0, 120)}`);
    },

    async place(row, stake, quote) {
      const rows = [{ index: 0, odds: quote.kambiOdds, outcomeId: Number(row.bookRef), type: 'SIMPLE' }];
      const bets = [{ couponRowIndexes: [0], eachWay: false, stake: Math.round(stake * 1000) }];

      // Same pre-check the bet slip does; also tells us if the BetRivers session is still valid.
      const v = await inTab('validate', `${k.authHost}/player/api/v2019/${k.offering}/coupon/validate.json?${qs()}`, 'POST',
        { couponRows: rows, bets, isUserLoggedIn: true });
      if (v.status === 401 || v.json?.validSession === false) throw new Error('BetRivers didn\'t accept the login token: click any odds in the BetRivers tab once, then remove it from the slip');
      if (v.status >= 400 || (v.json?.status && v.json.status !== 'SUCCESS')) {
        const err = new Error(`validate: ${JSON.stringify(v.json || v.text).slice(0, 200)}`);
        err.detail = `Kambi validate response (HTTP ${v.status}): ${JSON.stringify(v.json ?? v.text)}`;
        throw err;
      }

      const requestId = crypto.randomUUID();
      const res = await inTab('place', `${k.authHost}/player/api/v2019/${k.offering}/coupon.json?${qs()}`, 'POST', {
        couponRows: rows,
        // Like the site: live may only move to a better price, pre-game must be exact. Never worse.
        allowOddsChange: 'HIGHER', allowOddsChangeLive: 'HIGHER', allowOddsChangePreMatch: 'NO',
        bets, requestId, channel: 'WEB',
        trackingData: {
          hasTeaser: false, isBetBuilderCombination: false,
          selectedOutcomes: [{ id: Number(row.bookRef), outcomeId: Number(row.bookRef), betofferId: quote.betOfferId, eventId: quote.eventId,
            approvedOdds: quote.kambiOdds, oddsApproved: true, eachWayApproved: true }],
          stakeInputOption: 'stake', reward: {}, isMultiBuilder: false, isPrePackCombination: false, partnerSpecials: [],
        },
      });
      const j = res.json || {};
      const ref = j.couponRef ?? j.coupon?.couponRef;
      if (!ref || !['SUCCESS', 'LIVE_DELAY_PENDING'].includes(j.status)) {
        const err = new Error(`rejected: ${j.status || `HTTP ${res.status}`} ${JSON.stringify(j.generalErrors || j.couponRowErrors || j.betErrors || j).slice(0, 200)}`);
        err.detail = `Kambi coupon response (HTTP ${res.status}): ${JSON.stringify(res.json ?? res.text)}`;
        throw err;
      }
      let status = j.coupon?.bets?.[0]?.betStatus;

      // Live bets wait out Kambi's delay; poll until accepted or rejected (max ~20s).
      if (j.status === 'LIVE_DELAY_PENDING') {
        await new Promise((r) => setTimeout(r, ((j.delayBeforeAcceptingBet || 1) * 1000) + 300));
        for (let i = 0; i < 20 && (!status || status === 'WAITING_FOR_APPROVAL'); i++) {
          const h = await inTab('status', `${k.authHost}/player/api/v2019/${k.offering}/coupon/history/${ref}.json?${qs('&liveDelayPoll=true')}`);
          status = (Array.isArray(h.json) ? h.json[0] : h.json)?.bets?.[0]?.betStatus || status;
          if (status === 'WAITING_FOR_APPROVAL') await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (status !== 'OPEN') throw new Error(`not accepted (coupon ${ref}, status ${status || 'unknown'})`);
      // Kambi odds are decimal x 1000 (e.g. 2150 = +115).
      const ko = Number(j.coupon?.couponRows?.[0]?.odds ?? j.coupon?.bets?.[0]?.odds);
      return { betId: `coupon:${ref}`, confirmedOdds: Number.isFinite(ko) && ko > 1000 ? decimalToAmerican(ko / 1000) : null,
        detail: `BetRivers coupon response: ${JSON.stringify(j)}` };
    },
  };
}
