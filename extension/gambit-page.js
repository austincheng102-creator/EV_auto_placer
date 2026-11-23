// Runs inside your Gambit tab (page context) from page start, and tells the page its tab is
// always in view. Gambit's page only renews its login and asks for new odds while you're looking
// at it: in a background tab its login ran out, every poll was refused (HTTP 401) even after a
// reload and a fresh login, and it only started working again when you switched to the Gambit tab
// (Austin, 2026-11-23). Same fix as BetRivers' br-geo.js. Nothing else changes.
(() => {
  if (window.__evPlacerVisible) return;
  window.__evPlacerVisible = true;
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
    Document.prototype.hasFocus = function () { return true; };
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    window.addEventListener('blur', (e) => e.stopImmediatePropagation(), true);
  } catch {}
})();
