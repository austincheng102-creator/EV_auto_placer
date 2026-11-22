// Runs inside your FanDuel tab (page context) from page start. FanDuel's bet requests need its
// location check (x-geo-packet), which the page gets from api.fanduel.com/geolocation/v1/jwt/create
// every 20 minutes and keeps to itself. This only reads that answer as the page receives it and
// keeps a copy in the tab's sessionStorage, where the EV Placer's bet requests pick it up.
// It changes nothing the page sends or receives.
(() => {
  // When the EV Placer couldn't get a new location check with a plain reload, it sets this flag
  // and from then on this tab tells the page it is in view (Chrome tells background tabs they're
  // hidden, and some sites hold off on work until you look at them). Nothing else changes.
  try {
    if (sessionStorage.getItem('evPlacerFdVisible') === '1') {
      Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
      Document.prototype.hasFocus = function () { return true; };
      const stop = (e) => e.stopImmediatePropagation();
      document.addEventListener('visibilitychange', stop, true);
    }
  } catch {}
  const KEY = 'evPlacerFdGeo';
  const isGeo = (u) => /\/geolocation\/v1\/jwt\/create/.test(String(u || ''));
  const keep = (text) => { try { const j = JSON.parse(text); if (j?.jwt) sessionStorage.setItem(KEY, j.jwt); } catch {} };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    if (isGeo(u)) this.addEventListener('load', () => { try { keep(this.responseText); } catch {} });
    return open.call(this, m, u, ...rest);
  };
  const f = window.fetch;
  window.fetch = function (input, init) {
    const p = f.call(window, input, init);
    const u = typeof input === 'string' ? input : input?.url;
    if (isGeo(u)) p.then((r) => r.clone().text().then(keep)).catch(() => {});
    return p;
  };
})();
