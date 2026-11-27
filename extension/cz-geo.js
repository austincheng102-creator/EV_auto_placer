// Runs inside your Caesars tab (page context) from page start. Caesars only takes bets while your
// location check is current. The page runs it with GeoComply (the GeoComply app on this PC) and sends
// the result to api.americanwagering.com .../pam/geocomply/transaction, which answers
// { expiration (20 min later), detectedStateCode, transaction: { geolocate_in: 1200, ... } } (Austin's
// capture 2026-11-27). This only reads those answers as the page receives them and keeps a copy in the
// tab's sessionStorage, where the EV Placer extension can see when the check runs out. It changes
// nothing the page sends or receives.
(() => {
  const KEY = 'evPlacerCzGeo';
  const VERIFY = /\/pam\/geocomply\/transaction/;
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
  const write = (o) => { try { sessionStorage.setItem(KEY, JSON.stringify({ ...read(), ...o })); } catch {} };
  const urlOf = (input) => { try { return typeof input === 'string' ? input : input?.url || String(input || ''); } catch { return ''; } };
  const keep = (status, text) => {
    try {
      const now = Date.now();
      let j = null; try { j = JSON.parse(text); } catch {}
      const exp = Date.parse(j?.expiration || '');
      const bad = [j?.transaction?.error_message, j?.transaction?.error_summary, j?.message].filter(Boolean).join(', ');
      if (status < 400 && Number.isFinite(exp)) {
        write({ updateAt: now, nextAt: exp, refreshAt: exp - 35e3, status: 'OK', statusAt: now, location: j.detectedStateCode || '' });
      } else {
        write({ status: `HTTP ${status}${bad ? `: ${bad}` : ''}`.slice(0, 300), statusAt: now });
      }
    } catch {}
  };
  const f = window.fetch;
  window.fetch = function (input, init) {
    const p = f.call(window, input, init);
    if (VERIFY.test(urlOf(input)) && String(init?.method || input?.method || 'GET').toUpperCase() === 'POST') {
      write({ startAt: Date.now() });
      p.then((r) => r.clone().text().then((t) => keep(r.status, t))).catch(() => write({ status: 'the location answer never came (network)', statusAt: Date.now() }));
    }
    return p;
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (...a) { this.__evCzGeo = VERIFY.test(String(a[1] || '')) && String(a[0]).toUpperCase() === 'POST'; return open.apply(this, a); };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__evCzGeo) {
      write({ startAt: Date.now() });
      this.addEventListener('loadend', () => { try { keep(this.status || 599, this.responseType === '' || this.responseType === 'text' ? this.responseText : JSON.stringify(this.response)); } catch {} });
    }
    return send.call(this, body);
  };
})();
