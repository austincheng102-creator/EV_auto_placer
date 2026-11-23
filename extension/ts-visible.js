// Runs inside your theScore tab (page context) from page start. theScore only takes bets while its
// location check (GeoComply, run by the page) is current. It only tells the page its tab is always in
// view, so a background theScore tab keeps running its location checks the way it does while you
// look at it (as for BetRivers and BetMGM). Nothing else changes.
(() => {
  window.__evPlacerVisible = true;
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
    Document.prototype.hasFocus = function () { return true; };
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  } catch {}
})();
