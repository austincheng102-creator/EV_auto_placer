// Hard Rock Bet (app.hardrock.bet). Same flow as BetRivers: Gambit finds the bet, we
// re-check the live price, then place it from inside your logged-in Hard Rock tab through
// the extension, so your own session and location check apply.
//
// Hard Rock's price-check and place-bet requests haven't been captured yet, so this
// adapter isn't wired to their API. Until it is, a live run with Hard Rock stops at
// startup with a clear message; `ev-placer dry --book hardrock` works.
//
// To wire it: record a HAR in the Hard Rock tab while placing one small bet, then fill in
// recheck() and place() below from those requests (like betrivers.js does for Kambi).
// A stopgap also works: "recheck"/"place" request templates under config.json -> hardrock
// (see template.js) are used instead of this file when present.

export const HARDROCK_HOSTS = /(^|\.)hardrock\.bet$|(^|\.)hardrocksportsbook\.com$/;

export function makeHardRock(name, label /* , cfg, bridge */) {
  const notYet = () => { throw new Error('Hard Rock bet placement is not set up yet (needs a captured bet)'); };
  return {
    name, label,
    ready: false,
    notReadyReason: 'Hard Rock Bet placement is not set up yet. It needs a HAR recording of one bet placed on Hard Rock\'s site. Use `ev-placer dry --book hardrock` to try the flow meanwhile.',
    async recheck() { notYet(); },
    async place() { notYet(); },
  };
}
