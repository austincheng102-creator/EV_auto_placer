// Runs inside your theScore tab (page context) from page start. theScore only takes bets while your
// location check is current. The page runs it with GeoComply (GeoComplyGetApiToken, then GeoComply's
// own servers and the GeoComply app on this PC) and sends the result to theScore with
// GeoComplyAuthorizeGeoPacket, which answers { expiresAt (20 min), refreshAt (35s before) }. When it
// runs out, bets are refused with "We need to verify your location before you proceed". This only
// reads those answers as the page receives them and keeps a copy in the tab's sessionStorage, where
// the EV Placer extension can see when the check runs out. It changes nothing the page sends or receives.
//
// It also tells the page its tab is always in view, so a background theScore tab keeps running its
// checks the way it does while you look at it (as for BetRivers and BetMGM). Nothing else changes.
(() => {
  window.__evPlacerVisible = true;
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
    Document.prototype.hasFocus = function () { return true; };
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  } catch {}
  const KEY = 'evPlacerTsGeo';
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
  const write = (o) => { try { sessionStorage.setItem(KEY, JSON.stringify({ ...read(), ...o })); } catch {} };
  const opOf = (body) => (/"operationName"\s*:\s*"(GeoComply\w+)"/.exec(typeof body === 'string' ? body : '') || [])[1] || '';
  const keep = (op, text) => {
    try {
      const now = Date.now();
      if (op === 'GeoComplyGetApiToken') { write({ startAt: now }); return; }
      if (op !== 'GeoComplyAuthorizeGeoPacket') return;
      const r = JSON.parse(text)?.data?.geoComplyAuthorizeGeoPacket;
      const errs = (r?.errors || []).map((e) => e?.message || e?.code || JSON.stringify(e)).join(', ');
      const exp = Date.parse(r?.expiresAt || '');
      if (!errs && Number.isFinite(exp)) write({ updateAt: now, nextAt: exp, refreshAt: Date.parse(r?.refreshAt || '') || 0, status: 'OK', statusAt: now });
      else write({ status: errs || 'no expiry in the answer', statusAt: now });
    } catch {}
  };
  const f = window.fetch;
  window.fetch = function (input, init) {
    const p = f.call(window, input, init);
    const op = opOf(init?.body);
    if (op) p.then((r) => r.clone().text().then((t) => keep(op, t))).catch(() => {});
    return p;
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (...a) { this.__evUrl = a[1]; return open.apply(this, a); };
  XMLHttpRequest.prototype.send = function (body) {
    const op = opOf(body);
    if (op) this.addEventListener('load', () => { try { keep(op, this.responseText); } catch {} });
    return send.call(this, body);
  };
})();
