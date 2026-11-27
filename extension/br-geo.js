// Runs inside your BetRivers tab (page context) from page start. BetRivers only takes bets while
// your location check (Xpoint) is current: the page sends one to co.betrivers.com
// (geolocation/xpoint/geopackage), which answers {"status":"ALLOWED","expires":...} (about 14
// minutes), and the site's live connection tells the page SET_FLAG SUCCESSFUL_GEOLOCATION.
// When it runs out, the flag is cleared and Kambi refuses bets with ACCOUNT_BLOCKED until the
// page sends a new one. This only reads those answers as the page receives them and keeps a copy
// in the tab's sessionStorage, where the EV Placer extension can see when the check runs out.
// It changes nothing the page sends or receives.
//
// It also tells the page its tab is always in view. The page's Xpoint code only asks the Xpoint
// app on this PC for a new location check while the tab is in view (it skips its 10-second check
// while document.hidden), so in a background tab the check ran out and every bet was refused
// with ACCOUNT_BLOCKED until you switched to the tab. Nothing else changes.
(() => {
  window.__evPlacerVisible = true;
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
    Document.prototype.hasFocus = function () { return true; };
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  } catch {}
  const KEY = 'evPlacerBrGeo';
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
  const write = (o) => { try { sessionStorage.setItem(KEY, JSON.stringify({ ...read(), ...o })); } catch {} };
  const isGeo = (u) => /\/geolocation\/(xpoint|geocomply)\/geopackage/.test(String(u || ''));
  const keep = (text) => {
    try {
      const j = JSON.parse(text);
      if (!j?.status) return;
      const exp = Date.parse(j.expires);
      write({ status: j.status, at: Date.now(), pkgAt: Date.now(), pkgStatus: j.status, ...(j.status === 'ALLOWED' && Number.isFinite(exp) ? { expires: exp } : { expires: 0 }) });
    } catch {}
  };
  // The page's calls to the Xpoint app on this PC (127.0.0.1:18354 / local.xpoint.tech:28354):
  // kept only to say why a renewal didn't work (the app didn't answer, or had no new check).
  const isXp = (u) => /^https?:\/\/(127\.0\.0\.1:18354|local\.xpoint\.tech:28354)\/(check-status|wagering-start)/.test(String(u || ''));
  const keepXp = (text) => { try { const j = JSON.parse(text); write({ xpAt: Date.now(), xpStatus: j?.status || '' }); } catch {} };
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
    else if (isXp(u)) p.then((r) => r.clone().text().then(keepXp)).catch((e) => write({ xpErrAt: Date.now(), xpErr: String(e?.message || e).slice(0, 80) }));
    return p;
  };
  // The site's live connection (wss://<site>/api/service/ws/<session>) says when the location
  // flag is set or cleared, and when a bet was blocked for the lack of one.
  const W = window.WebSocket;
  if (!W) return;
  // It also says when the site is about to log you out for inactivity (TIMEOUT_WARNING: the page
  // shows "You have been inactive for a long time. You will be logged out automatically in 5
  // minutes" and logs you out when that runs out, unless it sees a mouse move or key press). The
  // page's own idle timer resets on mouse moves, so a small mouse move (nothing clicked or typed)
  // tells it you're there: it closes that warning and tells the site you're active. Also kept: the
  // site's LOGOUT message and what it gave as the reason, so the app can say why it logged out.
  const poke = () => {
    try {
      const x = 40 + Math.round(Math.random() * 300), y = 40 + Math.round(Math.random() * 200);
      const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y + 80, view: window };
      document.body?.dispatchEvent(new MouseEvent('mousemove', o));
      document.documentElement.dispatchEvent(new MouseEvent('mousemove', { ...o, clientX: x + 7 }));
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Shift', code: 'ShiftLeft', shiftKey: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift', code: 'ShiftLeft' }));
    } catch {}
  };
  const listen = (ws) => ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m?.type === 'TIMEOUT_WARNING') {
        const left = Date.parse(m.data?.timeoutTime) - Date.now();
        write({ idleWarnAt: Date.now(), idleWarnLeft: Number.isFinite(left) && left > 0 ? `${Math.round(left / 60e3)} min` : '' });
        // The page shows its warning after this message: move the mouse once it's up, and again a bit later.
        for (const ms of [1500, 4000, 15000]) setTimeout(poke, ms);
        return;
      }
      if (m?.type === 'LOGOUT') {
        const d = m.data || {};
        write({ logoutAt: Date.now(), logoutWhy: String(d.reason || d.logoutReason || d.code || d.message || JSON.stringify(d)).slice(0, 120) });
        return;
      }
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
