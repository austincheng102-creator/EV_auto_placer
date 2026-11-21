// FanDuel Sportsbook (Colorado, co.sportsbook.fanduel.com). Requests below match what the site
// itself sent for a $1 pre-game straight bet (Austin's capture, 2026-11-21):
//  - price:  POST smp.<st>.../readonly/v1/getMarketPrices   {marketIds:[...]}  (no login needed)
//  - slip:   POST sib.<st>.../transactional/v1/implyBets     -> live price, max stake and a
//            betReference that placeBet needs. No bet is made, so this is the price re-check.
//  - place:  POST spb.<st>.../transactional/v1/placeBet      with the exact price from the slip
//            check and acceptLowerOdds=false, so FanDuel refuses the bet if the price dropped.
//  - auth:   x-authentication header (FanDuel login, about an hour, the page renews it) and, for
//            placeBet only, x-geo-packet (FanDuel's location check, lasts 20 minutes). The
//            extension copies both from your FanDuel tab.
// Gambit only carries FanDuel New Jersey (id 100, market ids "42.x"); Colorado's market ids are
// different ("708.x"), so each row is first matched to the Colorado market (coMarket below).
// Player props are not bet on FanDuel (Austin, 2026-11-21): FanDuel is the live-prop sharp
// reference, so a FanDuel prop would be checked against itself. "fanduel": {"props": true} allows them.

import { decimalToAmerican } from '../ev.js';

const GEO = '{{fdGeo}}';

/** American odds from a FanDuel odds object ({americanDisplayOdds}, {trueOdds}), or null. */
export function fdAmerican(o) {
  const a = Number(o?.americanDisplayOdds?.americanOddsInt ?? o?.americanDisplayOdds?.americanOdds);
  if (Number.isFinite(a) && a !== 0) return Math.round(a);
  const d = Number(o?.trueOdds?.decimalOdds?.decimalOdds ?? o?.decimalDisplayOdds?.decimalOdds);
  return Number.isFinite(d) && d > 1 ? decimalToAmerican(d) : null;
}

// One settled bet from My Bets > Settled (search-bets) as a result for results.json.
// pandl is the total return (stake + winnings; 0 for a loss), the same as payout elsewhere.
export function settledBet(b) {
  if (!b?.betReceiptId || !b.isSettled || (b.legs || []).length !== 1) return null;
  const st = String(b.result || '').toUpperCase();
  const result = /CASH/.test(st) ? 'cashout'
    : /HALF/.test(st) ? (/WON|WIN/.test(st) ? 'half-won' : 'half-lost')
    : /WON|WIN/.test(st) ? 'won' : /LOST|LOSE/.test(st) ? 'lost'
    : /PUSH/.test(st) ? 'push' : /VOID|CANCEL|REFUND/.test(st) ? 'void' : null;
  if (!result) return null;
  const am = Number(b.legs[0]?.parts?.[0]?.americanPrice);
  return {
    betId: String(b.betReceiptId), result, status: st,
    payout: Math.round((Number(b.pandl) || 0) * 100) / 100,
    stake: Number.isFinite(Number(b.currentSize)) ? Number(b.currentSize) : null,
    odds: Number.isFinite(am) && am !== 0 ? am : null,
    settledAt: b.settledDate || null, placedAt: b.placedDate || null,
  };
}

// Why FanDuel refused a slip or a bet, from its failure lists and result codes.
const fdWhy = (j) => [...new Set([
  ...(j?.betFailures || []), ...(j?.legFailures || []),
  ...(j?.result || []).filter((r) => r.resultCode && r.resultCode !== 'SUCCESS'),
].map((f) => [f.resultCode, f.failureCode, f.code, f.reason, f.message].filter(Boolean).join(' ')).filter(Boolean)
  .concat(j?.respCode && j.respCode !== 'SUCCESS' ? [j.respCode] : []))].join(', ');

const uuid = () => (globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
}));

export function makeFanDuel(name, label, cfg, bridge) {
  const f = cfg.fanduel || {};
  const st = String(cfg.region || 'CO').toLowerCase();
  const host = (sub) => `https://${sub}.${st}.sportsbook.fanduel.com`;
  const appKey = f.appKey || 'FhMFpcPWXMeyZxOx';   // FanDuel's site key, the same for everyone
  const json = { accept: 'application/json', 'content-type': 'application/json', 'x-application': appKey };
  const loginMsg = 'FanDuel didn\'t accept the login: refresh the FanDuel tab and stay logged in';
  const send = (kind, url, method, body, extra = {}, ms = 20000) =>
    bridge.send(name, { kind, url, method, headers: { ...json, ...extra }, body, useFanDuelAuth: true }, ms);
  const authFail = (res) => res.status === 401 || res.status === 403;

  // Colorado market + runner for a Gambit (New Jersey) row. Filled in from the game-page capture.
  async function coMarket(row) {
    if (row.coMarket) return row.coMarket;
    throw new Error('FanDuel Colorado market lookup isn\'t built yet');
  }

  const runnerOf = (m, sel) => (m?.runnerDetails || []).find((r) => String(r.selectionId) === String(sel));

  return {
    name, label,
    freePriceCheck: true,   // the slip check makes no bet, so a failed check can be watched and retried

    // Live price, line and max stake from FanDuel Colorado, plus the betReference placeBet needs.
    async recheck(row) {
      if (row.isProp && f.props !== true) throw new Error('player props are off for FanDuel');
      const m = await coMarket(row);
      const prices = await send('recheck', `${host('smp')}/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0`, 'POST', { marketIds: [m.marketId] });
      if (prices.status >= 400) throw new Error(`price check HTTP ${prices.status}: ${JSON.stringify(prices.json || prices.text).slice(0, 200)}`);
      const mk = (Array.isArray(prices.json) ? prices.json : []).find((x) => x.marketId === m.marketId);
      const rn = runnerOf(mk, m.selectionId);
      if (!mk || !rn) return { odds: null, suspended: true };
      const line = row.line == null ? null : Number(rn.handicap);
      if (mk.marketStatus !== 'OPEN' || rn.runnerStatus !== 'ACTIVE') return { odds: fdAmerican(rn.winRunnerOdds), line, suspended: true };

      const slip = await send('recheck', `${host('sib')}/api/sports/fixedodds/transactional/v1/implyBets?pricePolicy=SUGGESTED`, 'POST',
        { betLegs: [{ legType: 'SIMPLE_SELECTION', betRunners: [{ runner: { marketId: m.marketId, selectionId: m.selectionId } }] }] });
      const j = slip.json || {};
      if (authFail(slip)) throw new Error(loginMsg);
      if (slip.status >= 400 || j.respCode !== 'SUCCESS') throw new Error(`slip check ${slip.status >= 400 ? `HTTP ${slip.status}` : j.respCode || 'failed'}: ${fdWhy(j) || JSON.stringify(j || slip.text).slice(0, 200)}`);
      const combo = (j.betCombinations || []).find((c) => c.betType === 'SINGLE');
      const ro = (j.winRunnerOdds || j.runnerOdds || []).find((r) => String(r.runner?.selectionId) === String(m.selectionId))?.odds;
      const odds = fdAmerican(ro || combo?.winAvgOdds);
      if (!combo?.betReference || odds == null) return { odds: null, suspended: true };
      const max = Number(combo.betMaxStake);
      return {
        odds, line, suspended: false,
        maxStake: Number.isFinite(max) && max > 0 ? max : null,
        fd: { ...m, handicap: Number(rn.handicap) || 0, betReference: combo.betReference, trueOdds: ro?.trueOdds, oddsFor: odds, delay: mk.betDelay },
      };
    },

    async place(row, stake, quote) {
      const q = quote.fd;
      // The slip's reference and price go together: if the engine is retrying at a new price,
      // check the slip again instead of sending a price FanDuel didn't just quote.
      if (!q?.betReference || q.oddsFor !== quote.odds) {
        const fresh = await this.recheck(row);
        if (fresh.suspended || fresh.odds == null) { const e = new Error('rejected: no longer offered'); e.gone = true; throw e; }
        if (fresh.odds !== quote.odds) { const e = new Error(`rejected: price is now ${fresh.odds}`); e.priceMoved = true; e.newOdds = fresh.odds; e.newQuote = { fd: fresh.fd, maxStake: fresh.maxStake }; throw e; }
        return this.place(row, stake, { ...quote, fd: fresh.fd });
      }
      const dec = Number(q.trueOdds?.decimalOdds?.decimalOdds);
      const body = {
        customerRef: uuid(), acceptLowerOdds: false, useAvailableBonus: false, dryRun: false,
        betDefinitions: [{
          betReference: q.betReference, betType: 'SINGLE', betNo: 0, stakePerLine: stake,
          winExpectedOdds: { trueOdds: { decimalOdds: { decimalOdds: dec } } }, edges: [],
          legs: [{ legType: 'SIMPLE_SELECTION', betRunners: [{ runner: { marketId: q.marketId, selectionId: q.selectionId, handicap: q.handicap } }],
            ...(q.trueOdds?.fractionalOdds ? { winExpectedOdds: { fractionalOdds: q.trueOdds.fractionalOdds } } : {}), edgeContexts: [] }],
          wallets: [],
        }],
      };
      // Live bets wait out FanDuel's bet delay (betDelay seconds) before it answers.
      const res = await send('place', `${host('spb')}/api/sports/fixedodds/transactional/v1/placeBet`, 'POST', body, { 'x-geo-packet': GEO }, 60000);
      const j = res.json || {};
      if (authFail(res)) throw new Error(loginMsg);
      const r = j.result?.[0];
      const detail = `FanDuel placeBet response: ${JSON.stringify(j || res.text)}`;
      if (r?.resultCode === 'SUCCESS' && r.betReceiptId) {
        return { betId: `fanduel:${r.betReceiptId}`, confirmedOdds: fdAmerican(r.betPrice || r.runners?.[0]?.winOdds || r.runners?.[0]?.odds), detail };
      }
      // A receipt with a pending/accepted code: record it so the same bet is never sent twice.
      if (r?.betReceiptId && /PENDING|DELAY|ACCEPT|REFER/i.test(String(r.resultCode))) {
        return { betId: `fanduel:${r.betReceiptId} (${r.resultCode})`, confirmedOdds: null, detail };
      }
      const why = fdWhy(j) || `HTTP ${res.status}`;
      const err = new Error(`rejected: ${why}`);
      err.detail = detail;
      if (/PRICE|ODDS/i.test(why)) err.priceMoved = true;      // re-checked and retried once by the engine
      else if (/SUSPEND|CLOSED|UNAVAILABLE|NOT_ACTIVE|INACTIVE/i.test(why)) err.gone = true;
      throw err;
    },

    // Settled bets since `from` (ms), newest first, from My Bets > Settled. Read-only.
    async settled(from) {
      const out = [];
      for (let start = 1; start <= 400; start += 20) {
        const res = await send('history', `https://api.sportsbook.fanduel.com/my-bets/search-bets?isSettled=true&fromRecord=${start}&toRecord=${start + 19}&sortDir=DESC&sortParam=SETTLEMENT_DATE&rewardsClubEnabled=false&_ak=${appKey}`,
          'GET', null, { 'x-sportsbook-region': st.toUpperCase() }, 30000);
        const j = res.json || {};
        if (authFail(res)) throw new Error(loginMsg);
        if (res.status >= 400 || !Array.isArray(j.bets)) throw new Error(`settled bets HTTP ${res.status}: ${JSON.stringify(j || res.text).slice(0, 200)}`);
        out.push(...j.bets.map(settledBet).filter(Boolean));
        const oldest = Date.parse(j.bets.at(-1)?.settledDate);
        if (!j.moreAvailable || !j.bets.length || (Number.isFinite(oldest) && oldest < from)) break;
      }
      return out;
    },

    // Once a minute (session.js): read the balance, like the site does, to tell whether you're
    // still logged in.
    async sessionCheck() {
      const res = await bridge.send(name, { kind: 'session', url: 'https://api.fanduel.com/account/wallet', method: 'GET',
        headers: { accept: 'application/json, text/plain, */*', 'x-brand': 'FANDUEL' }, useFanDuelAuth: true, walletAuth: true }, 15000);
      const bal = (res.json?.wallet_balances || []).find((w) => w.account_type === 'SPORTSBOOK_PLAYABLE_NO_BONUS');
      if (res.status < 400 && bal) return { ok: true, balance: Number(bal.balance).toFixed(2) };
      if (authFail(res)) return { ok: false, why: `FanDuel balance check answered HTTP ${res.status}` };
      throw new Error(`FanDuel balance check HTTP ${res.status}: ${JSON.stringify(res.json || res.text).slice(0, 120)}`);
    },
  };
}
