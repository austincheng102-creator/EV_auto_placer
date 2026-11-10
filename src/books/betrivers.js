// BetRivers runs on Kambi. Requests below match what co.betrivers.com itself sends
// (captured 2026-11-10):
//  - price check: Kambi's public offering API (no login), fetched directly by this app
//  - place:       POST coupon.json on Kambi's player API, sent from inside your logged-in
//                 BetRivers tab by the extension, so your session and location check apply
//  - live bets come back LIVE_DELAY_PENDING; we poll coupon/history until accepted or rejected
// Kambi units: odds and stake are x1000 (odds 1630 = 1.63 decimal, stake 1000 = $1), lines x1000.

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

export function makeBetRivers(name, label, cfg, bridge) {
  const k = kambiSettings(cfg);
  const qs = (extra = '') => `lang=en_US&market=${k.market}&client_id=${k.clientId}&channel_id=1${extra}`;
  const json = { accept: 'application/json, text/javascript, */*; q=0.01', 'content-type': 'application/json' };

  async function inTab(kind, url, method = 'GET', body) {
    const res = await bridge.send(name, { kind, url, method, headers: json, body }, 20000);
    return res;
  }

  return {
    name, label,

    async recheck(row) {
      if (!row.bookRef) throw new Error('no BetRivers outcome id on this Gambit row');
      const url = `${k.offeringHost}/offering/v2018/${k.offering}/betoffer/outcome.json?${qs(`&ncid=${Date.now()}`)}&id=${row.bookRef}`;
      const res = await fetch(url, { headers: { accept: json.accept }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Kambi price HTTP ${res.status}`);
      const j = await res.json();
      const bo = (j.betOffers || []).find((b) => (b.outcomes || []).some((o) => String(o.id) === String(row.bookRef)));
      const oc = bo?.outcomes.find((o) => String(o.id) === String(row.bookRef));
      if (!oc) return { odds: null, suspended: true };
      return {
        odds: oc.oddsAmerican != null ? Number(oc.oddsAmerican) : kambiToAmerican(oc.odds),
        kambiOdds: oc.odds,
        line: oc.line != null ? oc.line / 1000 : null,   // signed, from the bettor's side, like Gambit's
        suspended: oc.status !== 'OPEN',
        maxStake: null,
        betOfferId: bo.id, eventId: bo.eventId,
      };
    },

    async place(row, stake, quote) {
      const rows = [{ index: 0, odds: quote.kambiOdds, outcomeId: Number(row.bookRef), type: 'SIMPLE' }];
      const bets = [{ couponRowIndexes: [0], eachWay: false, stake: Math.round(stake * 1000) }];

      // Same pre-check the bet slip does; also tells us if the BetRivers session is still valid.
      const v = await inTab('validate', `${k.authHost}/player/api/v2019/${k.offering}/coupon/validate.json?${qs()}`, 'POST',
        { couponRows: rows, bets, isUserLoggedIn: true });
      if (v.json?.validSession === false) throw new Error('BetRivers session expired: log in again in the BetRivers tab');
      if (v.status >= 400 || (v.json?.status && v.json.status !== 'SUCCESS')) throw new Error(`validate: ${JSON.stringify(v.json || v.text).slice(0, 200)}`);

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
        throw new Error(`rejected: ${j.status || `HTTP ${res.status}`} ${JSON.stringify(j.generalErrors || j.couponRowErrors || j.betErrors || j).slice(0, 200)}`);
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
      return { betId: `coupon:${ref}` };
    },
  };
}
