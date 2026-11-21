// Watches that Gambit and each book are still logged in, keeps the books' sessions active, and
// raises a loud alert (bell + red banner here, a notification that stays up in Chrome) the
// moment one isn't. It never stops the app: scanning and betting carry on, and it says so when
// the login works again. It never types a password.
//
// Why sites log out during a run (from Austin's recordings, 2026-11-17 and 2026-11-19):
//  - Hard Rock's login token lasts 28 minutes. Its page renews it every 10 seconds (keepAlive).
//  - BetRivers' page tells the site you're still there (sessions/portal/keepalive), mostly when
//    you click around, and the site logs you out after a while with no activity.
//  - Gambit's token lasts about an hour; its page renews it.
//  If Chrome unloads a tab you haven't looked at (Memory Saver) or the PC sleeps, the page stops
//  renewing and the login runs out. The extension now keeps these tabs loaded and reloads a
//  stalled one; this file sends BetRivers' keepalive itself and checks each login once a minute.
//
// config.json "session": { "checkSeconds": 60, "remindMinutes": 2, "reloadTabs": true, "gambitAlertSeconds": 20 }
//   checkSeconds 0 turns the checks off.

const LOGIN_RE = /login|logged|log in|token|HTTP 40[13]|session|not seen yet/i;

export function makeSessionWatch({ cfg, bridge, books, log, labels }) {
  const s = cfg.session || {};
  const every = Number(s.checkSeconds ?? 60) * 1000;
  const remindMs = Number(s.remindMinutes ?? 2) * 60e3;
  const reloadTabs = s.reloadTabs !== false;
  const down = new Map();   // site -> { since, why, remindedAt }
  const label = (site) => (site === 'gambit' ? 'Gambit' : labels[site] || site);
  const howToFix = (site) => site === 'gambit' ? 'Log in again in the Gambit tab'
    : site === 'hardrock' ? 'Log in again in the Hard Rock tab, then place one small bet by hand for the location check'
    : `Log in again in the ${label(site)} tab`;

  // Hard Rock's location check is missing (not a logout): bets can't go through until you place one by hand.
  const needsGeo = (why) => /location check not seen/i.test(why || '');
  function alarm(site, why) {
    const text = needsGeo(why)
      ? `${label(site)} needs a location check before it can place bets: place one small bet by hand in the Hard Rock tab. You are still logged in. The app keeps running and retrying.`
      : `${label(site)} is LOGGED OUT (${why}). ${howToFix(site)}. The app keeps running and retrying.`;
    log.alarm(text);
    bridge?.tell({ type: 'alert', book: site, title: `EV Placer: ${label(site)} ${needsGeo(why) ? 'needs a location check' : 'logged out'}`, text });
  }

  function bad(site, why) {
    const d = down.get(site);
    if (!d) {
      down.set(site, { since: Date.now(), why, remindedAt: Date.now() });
      alarm(site, why);
      // The site may still have you logged in under the hood: a reload lets it renew from its cookies.
      if (reloadTabs && !needsGeo(why)) bridge?.tell({ type: 'reloadTab', book: site, why: `the app found it logged out (${why})` });
    } else if (Date.now() - d.remindedAt >= remindMs) {
      d.remindedAt = Date.now(); d.why = why;
      alarm(site, `${why}, for ${Math.round((Date.now() - d.since) / 60e3)} min`);
      if (reloadTabs && !needsGeo(why)) bridge?.tell({ type: 'reloadTab', book: site, why: 'still logged out' });   // the extension allows one per 5 min
    }
  }

  function ok(site, extra = '') {
    const d = down.get(site);
    if (!d) return;
    down.delete(site);
    log.good(`${label(site)} is logged in again${extra} (was out ${Math.max(1, Math.round((Date.now() - d.since) / 60e3))} min)`);
    bridge?.tell({ type: 'clearAlert', book: site, all: down.size === 0 });
  }

  let checking = false;
  async function checkBooks() {
    if (checking || !bridge?.connected()) return;
    checking = true;
    try {
      for (const [name, b] of Object.entries(books)) {
        if (!b.sessionCheck) continue;
        if (!bridge.hasTab(name)) { bad(name, `no ${label(name)} tab open`); continue; }
        try {
          const r = await b.sessionCheck();
          if (r.ok) ok(name, r.balance != null ? `, balance $${r.balance}` : '');
          else bad(name, r.why || 'the site says the login is no longer valid');
        } catch (e) {
          // A network blip or slow reply isn't a logout; only alert on login errors.
          if (LOGIN_RE.test(e.message)) bad(name, e.message);
          // While the site is marked logged out, say why the check couldn't confirm the login.
          else if (down.has(name)) log.warn(`${label(name)} login check didn't answer: ${e.message} (still showing it as logged out)`);
          else log.debug(`${label(name)} login check: ${e.message}`);
        }
      }
    } finally { checking = false; }
  }

  let timer = null;
  let gambitFailSince = 0;
  const gambitGraceMs = Number(s.gambitAlertSeconds ?? 20) * 1000;
  return {
    start() {
      if (every <= 0 || timer) return;
      setTimeout(checkBooks, 10e3);
      timer = setInterval(checkBooks, every);
    },
    check: checkBooks,
    /** The Gambit poll's result: an Error, or null when it worked. */
    // Only alarm (and ask for a reload) once Gambit has refused for gambitAlertSeconds (default 20):
    // a single refused poll while the page renews its token is normal, and reloading the tab in
    // the middle of that renewal is what knocked the login out.
    gambit(err) {
      if (!err) { gambitFailSince = 0; return ok('gambit'); }
      if (!/HTTP 40[13]|log in|no Gambit login|no open Gambit tab/i.test(err.message)) return;
      if (!gambitFailSince) gambitFailSince = Date.now();
      if (Date.now() - gambitFailSince >= gambitGraceMs) bad('gambit', err.message);
    },
    /** A book's request that needs the login just worked: it isn't logged out. */
    bookOk(name) { ok(name); },
    /** A book reported a login error while checking or placing a bet. */
    bookError(name, msg) { if (/didn't accept the login|login not seen yet|login token|not seen yet/i.test(msg)) bad(name, msg); },
    isDown: (site) => down.has(site),
  };
}
