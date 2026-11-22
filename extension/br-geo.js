// Runs inside your BetRivers tab (page context) from page start. BetRivers only takes bets while
// your location check (Xpoint) is current: the page sends one to co.betrivers.com
// (geolocation/xpoint/geopackage), which answers {"status":"ALLOWED","expires":...} (about 14
// minutes), and the site's live connection tells the page SET_FLAG SUCCESSFUL_GEOLOCATION.
// When it runs out, the flag is cleared and Kambi refuses bets with ACCOUNT_BLOCKED until the
// page sends a new one. This only reads those answers as the page receives them and keeps a copy
// in the tab's sessionStorage, where the EV Placer extension can see when the check runs out.
// It changes nothing the page sends or receives.
(() => {
  const KEY = 'evPlacerBrGeo';
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
  const write = (o) => { try { sessionStorage.setItem(KEY, JSON.stringify({ ...read(), ...o })); } catch {} };
  const isGeo = (u) => /\/geolocation\/(xpoint|geocomply)\/geopackage/.test(String(u || ''));
  const keep = (text) => {
    try {
      const j = JSON.parse(text);
      if (!j?.status) return;
      const exp = Date.parse(j.expires);
      write({ status: j.status, at: Date.now(), ...(j.status === 'ALLOWED' && Number.isFinite(exp) ? { expires: exp } : { expires: 0 }) });
    } catch {}
  };
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
  // The site's live connection (wss://<site>/api/service/ws/<session>) says when the location
  // flag is set or cleared, and when a bet was blocked for the lack of one.
  const W = window.WebSocket;
  if (!W) return;
  const listen = (ws) => ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(ev.data);
      const code = m?.data?.flagCode || m?.data?.blockingFlag || '';
      if (!/SUCCESSFUL_GEOLOCATION$/.test(code) || /SUPPLEMENTARY/.test(code)) return;
      if (m.type === 'SET_FLAG') write({ flag: 'set', flagAt: Date.now() });
      else if (m.type === 'CLEAR_FLAG') write({ flag: 'cleared', flagAt: Date.now() });
      else if (m.type === 'WAGER_BLOCKED') write({ flag: 'blocked', flagAt: Date.now() });
    } catch {}
  });
  function Wrapped(url, protocols) {
    const ws = protocols === undefined ? new W(url) : new W(url, protocols);
    try { if (/\/api\/service\/ws\//.test(String(url))) listen(ws); } catch {}
    return ws;
  }
  Wrapped.prototype = W.prototype;
  Object.setPrototypeOf(Wrapped, W);
  window.WebSocket = Wrapped;
})();
