// Runs inside your BetMGM tab (page context) from page start. BetMGM only takes bets while your
// location check is current. The page runs it with the GeoComply app on this PC (127.0.0.1:53280)
// and BetMGM's location server (geoloc-real-<state>.partygaming.com/rest/gds/...): "init" starts
// it, "update" sends the result and answers "operation:waitAndCheck|...|timeForNextCall:<ms>"
// (about 19.5 minutes), and the page is meant to run the next check by then. When it doesn't,
// bets are refused with SessionTokenInvalid ("unable to confirm that you are located in a legal
// betting area"). This only reads those answers as the page receives them and keeps a copy in the
// tab's sessionStorage, where the EV Placer extension can see when the next check is due and
// whether the page ran it. It changes nothing the page sends or receives.
//
// It also tells the page its tab is always in view, so a background BetMGM tab keeps running its
// checks the way it does while you look at it (as for BetRivers). Nothing else changes.
(() => {
  window.__evPlacerVisible = true;
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
    Document.prototype.hasFocus = function () { return true; };
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  } catch {}
  const KEY = 'evPlacerMgmGeo';
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
  const write = (o) => { try { sessionStorage.setItem(KEY, JSON.stringify({ ...read(), ...o })); } catch {} };
  const isGeo = (u) => /partygaming\.com\/rest\/gds\/(init|update|locationInfostatus)/i.test(String(u || ''));
  const keep = (u, text) => {
    try {
      const op = /\/rest\/gds\/(\w+)/i.exec(String(u))[1];
      const now = Date.now();
      if (/^locationInfostatus$/i.test(op)) {
        const j = JSON.parse(text);
        write({ statusAt: now, status: String(j?.locationStatus || ''), statusMsg: String(j?.errorMsg || '').slice(0, 120) });
        return;
      }
      const next = Number((/timeForNextCall:(\d+)/.exec(text) || [])[1]);
      const operation = (/operation:(\w+)/.exec(text) || [])[1] || '';
      write({ [`${op.toLowerCase()}At`]: now, operation, ...(Number.isFinite(next) && next > 0 ? { nextAt: now + next } : {}) });
    } catch {}
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    if (isGeo(u)) this.addEventListener('load', () => { try { keep(u, this.responseText); } catch {} });
    return open.call(this, m, u, ...rest);
  };
  const f = window.fetch;
  window.fetch = function (input, init) {
    const p = f.call(window, input, init);
    const u = typeof input === 'string' ? input : input?.url;
    if (isGeo(u)) p.then((r) => r.clone().text().then((t) => keep(u, t))).catch(() => {});
    return p;
  };
})();
