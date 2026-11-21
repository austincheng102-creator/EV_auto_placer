// Runs inside your FanDuel tab (page context) from page start. FanDuel's bet requests need its
// location check (x-geo-packet), which the page gets from api.fanduel.com/geolocation/v1/jwt/create
// every 20 minutes and keeps to itself. This only reads that answer as the page receives it and
// keeps a copy in the tab's sessionStorage, where the EV Placer's bet requests pick it up.
// It changes nothing the page sends or receives.
(() => {
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
    const p = f.call(this, input, init);
    const u = typeof input === 'string' ? input : input?.url;
    if (isGeo(u)) p.then((r) => r.clone().text().then(keep)).catch(() => {});
    return p;
  };
})();
