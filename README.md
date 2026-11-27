# EV Placer

Polls your Gambit odds feed, finds bets at or above `minEvPct` (default 10%), re-checks the live
price at the book, and places the bet through a Chrome extension running inside your logged-in
sportsbook tab. Log format: `[SCAN]`, `[AUTOEV]`, `[EV BET] re-check OK/FAIL`, `line moved`, `PLACED`.

## Install (Windows or Mac, nothing else needed)

Unzip the right zip anywhere:

| Computer | Zip |
|---|---|
| Windows | `ev-placer-win-x64.zip` |
| Mac with Apple chip (M1 to M4) | `ev-placer-mac-arm64.zip` |
| Older Intel Mac | `ev-placer-mac-x64.zip` |

Inside the folder, double-click:

- **Run demo** (`Run demo.bat` / `Run demo.command`): fake Gambit feed and a simulated book, nothing is sent anywhere.
- **Start EV Placer** (`Start EV Placer.bat` / `Start EV Placer.command`): the live run.

The first run creates `config.json` and an `extension/` folder next to the app. Fill in `config.json`
(Gambit and BetRivers sections), then start it again. Each computer keeps its own `config.json`
and `state.json` (bets already placed, today's stake).

**Mac:** if macOS says it "can't be opened" or the developer can't be verified, right-click
`Run demo.command` and choose Open once, or run `xattr -dr com.apple.quarantine <folder>` in Terminal.
**Windows:** if SmartScreen warns about an unrecognized app, click More info, then Run anyway.

From a terminal, the app takes commands:
```
ev-placer            live run
ev-placer dry        demo run
ev-placer init       create config.json and extension/, then exit
ev-placer bets       bet log and closing line value (also: Show bets)
ev-placer --book hardrock   bet Hard Rock this run (or betrivers)
ev-placer --help     all options (--min-ev 12, --books betrivers,hardrock, --config other.json)
```

## Picking the book (BetRivers, Hard Rock Bet, FanDuel, BetMGM, DraftKings, theScore or Caesars)
One app runs either book; the Gambit feed, Novig check, EV math and limits are shared.
- Double-click **Start BetRivers** or **Start Hard Rock** to bet that book for the day.
  **Start EV Placer** uses `"books"` from `config.json`.
- Set `"books": "ask"` in `config.json` to be asked which book each time it starts.
- From a terminal: `ev-placer --book hardrock`, or `--books betrivers,hardrock,fanduel,betmgm,draftkings,thescore,caesars` for several at once.
  In `config.json`: `"books": ["betrivers", "hardrock", "fanduel"]`.
- `state.json` and the daily stake limit are shared across books.

**Hard Rock Bet (Colorado)** is wired from a recording of a real bet on app.hardrock.bet:
- Before each bet it checks Hard Rock's stake limit for that selection (no bet is made, so it
  also runs while the extension is disarmed). The price check is the bet itself: it's sent at
  Gambit's price with price changes refused, so Hard Rock turns it down if the price moved.
- The extension copies your login and location-check tokens from your Hard Rock tab's own
  requests. The location token is only sent when you place a bet, so **after logging in, place
  one small bet by hand**. The popup shows "Hard Rock location: from your bet N min ago".
- Gambit lists Hard Rock under several ids; 851 is Colorado and is the default. Set
  `gambit.bookIds.hardrock` (a number or a list) to override. If the log says Gambit has no Hard Rock rows, tick Hard Rock in Gambit's sportsbook
  filter and copy the new evs.json link into `config.json`.
- Straight bets match a recorded $1 straight bet. The selection id comes from Gambit's Hard Rock
  link (`app.hardrock.bet/?deep_link_value=betslip/<id>`). Not yet known: how long Hard Rock
  accepts the location token.

**FanDuel (Colorado, co.sportsbook.fanduel.com)** is wired from recordings of a real $1 bet and a game page:
- Gambit only carries FanDuel **New Jersey** (id 100). Selection ids are the same in every state
  but market ids aren't, so for each +EV row the app finds the game on FanDuel CO's league page
  (NBA, NCAAB, NFL, NCAAF, NHL, MLB, WNBA; `"fanduel": {"leaguePages": {...}}` adds others), or for
  any other league (tennis, soccer, UFC, boxing, other basketball/hockey/baseball leagues, ...) on
  FanDuel's sport page and then FanDuel's own event search for that sport
  (`"fanduel": {"eventTypes": {"<league>": <FanDuel sport id>}}` adds a league it doesn't know), and
  the matching Colorado market (same kind and period: spread, total, moneyline; full game,
  halves, quarters). Alternate lines, 3-way and team markets are never used.
- **Colorado prices for EV**: every scan the app reads FanDuel CO's own price (no login needed)
  for each FanDuel row within 5 points of min EV and recomputes EV from it, so the 8% rule uses
  Colorado's price, not New Jersey's. The [SCAN] line shows "FanDuel prices read directly: N
  (M moved since Gambit)". `"fanduel": {"coPrices": false}` goes back to Gambit's NJ price.
- **Looser rules for one book** (off unless set): `"fanduel": {"devigMethod": "power"}` scores that
  book's EV with Gambit's Power number (or "multiplicative", "additive", "shin", "best") instead of
  the lowest of the 4; `"fanduel": {"sharpRules": false}` skips the sharp-book rules for it (sharp
  book needed live, sharp move in the last 5s, sharp books within 3 pts). Price re-check, odds range,
  max EV, groups and the daily limit still apply. Works for any book key.
- **Alternate lines**: if the line Gambit shows isn't FanDuel CO's main line, the app looks for that exact
  line (same side, same sign) in FanDuel CO's alternate spreads/totals. `"fanduel": {"altLines": false}` turns it off.
- **Price re-check**: FanDuel CO's own current price, line and max stake (its bet-slip check,
  no bet is made, so it also runs while disarmed). EV and every rule are checked at that price.
- **Bet**: sent at exactly that price with lower odds refused. If FanDuel says the price moved,
  nothing is placed and the bet is re-checked from scratch.
- **No player props on FanDuel** (FanDuel is the sharp reference for live props, so a FanDuel
  prop would be checked against itself). `"fanduel": {"props": true}` turns them on.
- The extension copies your FanDuel login and location check from your FanDuel tab. The location
  check lasts 20 minutes and FanDuel's page renews it while the **FanDuel location app**
  (GeoComply) is running. After the extension updates, **reload the FanDuel tab once**.
  The popup shows "FanDuel login: seen (good for N min)".
- Daily stake limit, groups and once-per-book rules cover FanDuel like the other books.

**BetMGM (Colorado, www.co.betmgm.com)** is wired from recordings of real $0.10 pre-game and live bets:
- Gambit has no Colorado BetMGM: 400 ("BetMGM" on Gambit) links to Ontario and 1001 to Michigan.
  The app uses 400 (`"gambit": {"bookIds": {"betmgm": 1001}}` switches). Market and option ids are
  the same in every state, so the bet is found from the ids in Gambit's link.
- **Colorado prices for EV**: every scan the app reads BetMGM CO's own price for each BetMGM row
  within 5 points of min EV and recomputes EV from it. `"betmgm": {"coPrices": false}` turns it off.
- Only BetMGM's newer markets can be bet for now (all NFL, NBA props, some NBA/NCAAB/NHL lines).
  Rows on its older markets (links with a plain-number game id) are skipped with a note.
- **Price re-check**: BetMGM's own current price and line for that option (no login needed, no
  bet made). BetMGM's main spreads/totals are rolling lines, so a line that moved is skipped.
- **Bet**: sent at exactly that price with "accept odds changes" off. Live bets wait out BetMGM's
  delay (about 3s) for the answer.
- **Player props are on** for BetMGM, under the same prop rules as the other books.
- The login is your BetMGM tab's own; the extension copies its anti-forgery token (x-xsrf-token)
  from the tab's requests. BetMGM's location check runs in the page (GeoComply). After the
  extension updates, **reload the BetMGM tab once**. The popup shows "BetMGM login: seen".
- Results come from My Bets > Settled; Show bets colors BetMGM gold.

**DraftKings (Colorado, sportsbook.draftkings.com)** is wired from a recording of a real $0.10 live bet:
- Gambit id 200. Selection ids ("0ML87369883_1") are the same in every state, so the bet is found
  from Gambit's link (`?outcomes=<id>`).
- **Price re-check**: the selection's price, line and suspension from DraftKings' odds feed
  (selectioninfo, the feed the page reads to show odds). The bet slip's price check (calculateBets:
  odds plus a token for exactly that price, no bet made) goes out only right before a bet, like a
  tap on the odds; sending it on every re-check drew HTTP 403s from DraftKings' bot filter.
  `"draftkings": {"feedRecheck": false}` goes back to calculateBets on every check.
- **Bet**: placeBets with that token and auto-accept off, so a moved price is refused. Live bets
  wait out DraftKings' delay (3s) for its answer; a bet with no answer is recorded as waiting.
- DraftKings is also a reference book (soft-book check, Pinnacle-vs-market, arb props): a
  DraftKings bet is never checked against DraftKings itself.
- **Bot detection**: DraftKings' page runs bot detection that watches mouse and keyboard use.
  Bets the app sends carry no clicks, so DraftKings may notice the pattern. Nothing is done to
  hide from it.
- Results aren't read from DraftKings yet (its My Bets loads over a live connection): mark them
  in Show bets.

**theScore (Colorado, sportsbook.thescore.bet)** is wired from a recording of a real $0.10 live bet:
- Gambit id 700. Selection ids are the same everywhere (`market_selection_id[0]=<id>` in the link).
- **Price re-check**: adds the selection to your theScore bet slip, the way a click does, and reads
  its current odds and status. A selection the app checks but doesn't bet stays on the slip.
- **Bet**: sets the stake and places at exactly the checked odds (changes are never accepted).
  Live bets take about 9s.
- Results come from My Bets > Settled. If theScore updates its site and the app says a query
  wasn't found, the app needs an update.

**Caesars (Colorado, sportsbook.caesars.com)** is wired from a recording of two real $0.10 bets (live and pre-game):
- PropProfessor "Caesars" rows (link `.../us/co/bet/betslip?selectionIds=<id>`) and Gambit id 300 (its Michigan feed;
  the selection id is looked up in Colorado). Keep a logged-in Caesars tab open.
- **Price re-check**: Caesars' bet-slip check (`v2/bets/details`): current price, line and whether it can be bet.
  It makes no bet and leaves nothing on your slip.
- **Bet**: places at exactly the checked price (changes are never accepted). Live bets wait Caesars' delay
  (about 4s) before the answer. A bet refused over the location check reloads the Caesars tab.
- The extension copies the page's own login headers (popup: "Caesars login"). Results come from My Bets > Settled.
- Caesars isn't checked against itself in the soft-book, Pinnacle-vs-market and long-odds-props checks.

## Longest odds: +250
Bets with odds above +250 are skipped, both when scanning and at the live or new price. Change it
with `"maxOdds"` in `config.json` (`null` turns it off) or `--max-odds 300`.

## Placement rules (odds window, EV cap, sharp books, groups)
All are checked when scanning, and the odds and EV ones again at the live or new price. Each is a
setting in `config.json`; one that isn't there gets the default below, and `null` turns it off.

| Rule | Default | Setting |
|---|---|---|
| Favorites: nothing shorter than -300 (-300 itself is fine) | -300 | `"minOdds"` or `--min-odds -250` |
| Underdogs: nothing longer than +250 | +250 | `"maxOdds"` (above) |
| Nothing above 25% EV | 25 | `"maxEvPct"` or `--max-ev 20` |
| Player props (+EV and arb-table): no EV cap (`maxEvPct` doesn't apply to them). A number caps them there again | none (`null`) | `"maxPropEvPct"` |
| Player props (+EV and arb-table, Gambit and PropProfessor) above 30% EV: after passing every rule they're held, and must stay listed 40 seconds. Then every rule runs again on the newest scan (fresh fair price, sharp timing, groups, caps) and the book re-check and its checks run as usual before the bet. A prop whose book price is over 30% at the re-check is held too. Once held it waits the full time; one that fails the second check is checked again each scan while it's listed. These props skip the live 30-second FanDuel timing rule (FanDuel must still list the prop); `"liveTiming": true` puts it back. Logged as `HOLD:`, `HOLD over: ... PASSED` / `FAILED (reason)`, `HOLD dropped` | 30%, 40s, no timing rule | `"propHold": {"evPct": 30, "sec": 40, "liveTiming": false}`, `false` turns it off |
| Hard Rock: skip when its price changed under 3s before the scan and shows 3+ points more EV than Gambit's copy (the game likely moved before the sharp prices caught up) | 3s, 3 pts | `"freshJump": {"books", "sec", "evPts"}`, `false` turns it off |
| Live bets: skip when the book's real price is no longer the price Gambit shows for it (the game moved after Gambit's snapshot, so Gambit's sharp prices behind "fair" are from before the move). Checked again on later scans and placed once Gambit shows the book's new price. Hard Rock is left out (its moves away from Gambit were on model) | every book but Hard Rock, any change | `"gambitBehind": {"exceptBooks", "books", "maxPts"}`, `false` turns it off |
| Pre-game bets (+EV and arb-table rows, Gambit and PropProfessor) need this EV instead of `minEvPct` (`arbProps.minEvPct` for arb rows); live bets keep `minEvPct`. The odds bands and long-odds props rules below still raise it. `null` = pre-game uses the live minimum | 6% | `"pregameMinEvPct": 6` |
| Bets at +201 to +250 need 12% EV (everything else `minEvPct`) | 12% | `"minEvByOdds": [{"from": 201, "to": 250, "minEvPct": 12}]` |
| Player props above the `maxOdds` cap (+251 and up), on every book, are allowed up to +400 but need 18% EV (arb-table props too). Game lines keep the +250 cap. A book can get its own entry next to `"all"`; `{}` turns the rule off | 18%, up to +400 | `"longOddsProps": {"all": {"minEvPct": 18, "maxOdds": 400}}` |
| Those +251..+400 props also need DraftKings or Caesars (not the book being bet, both sides listed) with a no-vig win % within 5 points of our fair win %. Neither priced = skipped | 1 of DK/Caesars within 5 pts | `"longPropConsensus": {"books": {"draftkings": 200, "caesars": 300}, "maxPts": 5, "minBooks": 1}` (`"enabled": false` = off) |
| Soft-book check: the price is above 0% EV against the no-vig price of at least 2 of DraftKings, Caesars, FanDuel, Fanatics (Gambit 722, PropProfessor "Fanatics"; on Gambit's arbitrage table the app adds these ids to sportsbooks_id). A book that doesn't list both sides doesn't count; fewer than 2 priced = skip. The book being bet isn't checked against itself (a FanDuel bet needs 2 of DraftKings, Caesars, Fanatics) | 2 of 4, >4% | `"softCheck": {"enabled", "books", "minBooks", "minEvPct", "skipOwnBook"}` |
| Pinnacle vs the market: skip when Pinnacle's no-vig win % for our side is more than 3 points above the median no-vig % of the soft books on the row (DraftKings, FanDuel, Caesars, BetMGM, theScore, Hard Rock, BetRivers/Kambi, BetParx, Fliff, bet365, Bovada, BetOnline; each needs both sides; the book being bet is left out, and Kambi too for BetRivers). Needs 3+ soft books priced, otherwise it passes. Live and pre-game +EV rows on every book; Arb-table rows skip it (`"arb": true` adds them). Each skip is logged with both numbers | 3 pts, 3 books | `"marketCheck": {"enabled", "maxPts", "minBooks", "books", "ownAlso", "arb"}` |
| Prediction markets (Kalshi, Polymarket, Novig, ProphetX) are sharp books. A price counts only when its two sides add up to 103% or less (3 cent spread) and the thinner side has $500+ (Gambit's liquidity number). Its fair is the lower of the mid ((ours + 100 - other) / 2) and the size-weighted mid. If Kalshi and Polymarket both count they must be within 2 points, or neither counts. Ones that don't count are ignored by every sharp rule, the live timing rule and the fair price. They're added to the 3-point rule and the live mainline list even if config.json lists only Pinnacle | on, $500, 3c, 2 pts | `"sharp": {"predictionMarkets": {"enabled", "books", "minLiquidity", "maxHoldPct", "agreeBooks", "agreePts", "inFair"}}` |
| Fair price (+EV table): the lowest of Pinnacle's no-vig win % and each counted prediction market's fair (FanDuel too on props). Rows where Gambit's fair came from its "market" blend are recomputed from those books (the blend can hold thin prices); with none priced the row is skipped. Arb-table rows keep their own fair | on | `"sharp": {"predictionMarkets": {"inFair"}}` |
| Books never used as sharp, even if a list names them | none | `"sharp": {"excludeBooks"}` |
| Sharp books' no-vig win probabilities within 3 points of each other (Pinnacle, Polymarket, Novig; not FanDuel) | 3 | `"sharp": {"maxSpreadPts", "spreadBooks"}` |
| Live mainlines need Pinnacle, Polymarket or Novig listed | | `"sharp": {"liveMainlineNeeds"}` |
| Live player props need FanDuel listed | | `"sharp": {"livePropNeeds"}` |
| Pre-game player props need FanDuel listed | fanduel | `"sharp": {"pregamePropNeeds"}` (`[]` turns it off) |
| Live: a sharp price changed within the last 5 seconds | 5 | `"sharp": {"liveMaxAgeSec"}` |
| Live player props: FanDuel's price changed within the last 30 seconds (not props over the `propHold` EV) | 30 | `"sharp": {"livePropMaxAgeSec"}` |
| Same game + market + period = one group (both sides): up to 3 bets live (1 pre-game), $3 per book, at least 150s apart on one book | 3 live / 1 pre-game, $3, 150s, per book | `"group": {"maxBets", "pregameMaxBets", "maxStake", "cooldownSec", "bothSides", "perBook"}` |
| Same bet again (same book, side and line) only if its EV differs by 3 points or more from each earlier one | 3 | `"group": {"repeatMinEvPts"}` |

- **Sharp agreement:** each sharp book with both sides listed is de-vigged on its own (Pinnacle comes
  through Gambit as PS3838). For player props FanDuel counts as a sharp book too. If fewer than two
  sharp books have both sides, there's nothing to compare and the rule passes.
- **Live timing:** Gambit doesn't say when a sharp price last moved, so the app watches the sharp
  prices itself from poll to poll. A change is dated to the previous poll (the earliest it could have
  happened), so while this rule is on the app polls every 3 seconds. A live selection seen for the
  first time has no known age and waits for its next move.
- **Groups:** the line, the book and the side don't matter (Over 214.5 and Under 212.5 on the full-game total
  are one group, so are Bowling Green +19.5 and Toledo -23.5). The period is part of the market (1H Moneyline is
  its own group). Player props group per player and stat (Trae Young assists Over/Under). Bets from the last
  24 hours count. `"bothSides": true` makes each side its own group again. With `maxBets` above 1 the group
  can be bet again, at most once per scan, and each bet is still checked at the book's real price first.
  `cooldownSec` (default 150): a repeat in the same group on the same book waits until 150 seconds after the
  last one (a Warriors total placed, another Warriors total 2s later is skipped), and it must still pass every
  rule (EV, sharp books, re-check) at that moment. A different market on the same game (a Curry prop, the
  spread) doesn't wait. `0` turns the wait off.
  `repeatMinEvPts` (default 3): the same bet again (same book, same side, same line) is skipped while its
  EV is within 3 points of any earlier bet on it in the last 24 hours: after a 10.1% EV bet, a repeat needs
  13.1% EV or more. Each book only looks at its own bets. A different line (Over 214.5 after Over 212.5) isn't
  the same bet. The `[SCAN]` line counts these as "same bet already placed at EV within 3 pts". `0` turns it off.
  `maxBetsPerEvent` caps game lines (spreads, totals, moneylines, any period) per game. Player props don't
  count toward it: each player + stat is its own group, so Trae Young points, points + rebounds and steals
  can each get one bet, but points Under can't go twice. `maxPropStatsPerPlayer` (default 2) caps how many
  different stats one player gets per game: points and rebounds placed, then steals is skipped. The same stat
  on both books counts once. `"propsInEventCap": true` puts props back under the cap.
  With `"perBook": true` (default) the count and $ cap are per book: Over 214.5 on Hard Rock and Over 215.5
  on BetRivers can both be placed (each passing every rule on its own), and a repeat on one book waits 150s.
  `"otherSide"` (default `"afterCooldown"`): if the EV swings to the other side (the Under, the other team),
  it can be bet once the group's last bet on any book is `cooldownSec` old and it passes every rule.
  `"block"` keeps the other side off for the day. `"perBook": false` = one count across both books.
- The `[SCAN]` line says how many rows each rule skipped.
- Not done yet: no bets in the last 2 minutes of a game. Gambit's feed has no game clock.

## Pre-game: only within 12 hours of the start
Gambit's pre-game list is scanned along with live. A pre-game bet is only placed if the game starts
within 12 hours (a row with no start time is skipped). Change it with `"pregameMaxHours"` in
`config.json` (`null` = no limit) or `--pregame-hours 6`. Bet lines show `[live]` or
`[pre-game, starts in 3.5h]`.

## When the book's price already moved
Gambit's copy of a book's price can be a few seconds old, so a bet can show 10%+ on Gambit
while the book already moved. Every bet is checked at the book's real price first (EV, Novig and
all the rules above), and nothing is placed at a price that didn't pass.
- Bets run in the background, up to `maxInFlight` (default 3) at once, each in a different group,
  so scanning Gambit keeps going while Hard Rock takes ~10s to accept a bet.
- BetRivers' price check is free (a public read, no bet), so when it fails, the app checks that
  bet again on every scan for `recheckWatchMinutes` (default 5) as long as Gambit still lists it,
  and places it if the real price gets back to `minEvPct`. Repeat checks only show on screen when
  the price changes. Hard Rock's check is the bet itself, so a failed Hard Rock bet still waits 5 minutes.
- When a book refuses a bet because its price moved and says the new price (Hard Rock NEW_ODDS,
  BetRivers ODDS_CHANGED, FanDuel price not available), the bet is checked again at that price
  with every rule, and placed if it still passes, up to `priceMoveRetries` (default 2) times.
  `0` turns this off.
- **BetRivers prices are read straight from BetRivers** on every scan (its public odds, no login)
  for every BetRivers selection within `betrivers.directMarginPts` (default 5) points of `minEvPct`
  on Gambit's numbers, up to `betrivers.directMax` (default 300). The scan then uses BetRivers' real
  price with Gambit's fair price, so stale Gambit rows drop out before a bet is tried, and a
  selection Gambit only lists under another book still counts when BetRivers' real price is +EV.
  Every rule still applies. `"betrivers": {"directPrices": false}` turns this off. The scan line
  shows how many prices were read and how many had moved since Gambit's copy.
- **Hard Rock prices come straight from Hard Rock's live odds feed** (the one app.hardrock.bet
  uses, no login): the app follows live games and games starting within `pregameMaxHours`
  (up to `hardrock.feedMaxGames`, default 150) and uses Hard Rock's real price in the scan, the same
  way as BetRivers. Bets still go in with price changes refused, so Hard Rock turns a bet down if
  the price moved in the meantime. `"hardrock": {"directPrices": false}` turns this off.
- **Reading book prices never holds up the scan.** All books are read at the same time and the
  scan waits at most `directWaitSec` (default 1.5) for them. A book that takes longer keeps
  Gambit's prices for that scan while its read finishes in the background (every bet is still
  checked at the book first). FanDuel CO game lookups run in the background and are remembered
  for 10 minutes (a game not found is tried again after 60s). If a scan takes much longer than
  `pollSeconds`, a warning says how long Gambit and the book reads took.
- **Fast price check between Gambit polls.** Every `fastPrices.everySec` (default 1) seconds the
  app reads each book's own prices again for the selections from the last scan that are within
  `fastPrices.marginPts` (default 3) points of min EV and still pass the rules that don't depend on
  the price (up to `fastPrices.max`, default 20, per book). One that now clears min EV goes through
  every rule and the book's price re-check, exactly like a bet found by a scan, and the screen says
  "Fast price check". The fair price is still the last Gambit poll's. Any book with direct prices
  (BetRivers, Hard Rock, FanDuel, and books added later) takes part. `"fastPrices": {"everySec": 0}`
  turns it off.
- **Quicker re-checks:** FanDuel's market read and slip check go out together (one round trip
  instead of two); BetRivers sends the bet without the slip's separate validate call first (the bet
  is refused for the same reasons; `"betrivers": {"validateFirst": true}` puts it back); Hard Rock
  reuses a selection's max stake from the last `hardrock.stakeCheckCacheSec` (default 300) seconds
  when its live feed has the price (`0` = check every time). Price changes are still never accepted
  without a check.
- **Bet timing:** for each bet sent to a book, a `timing:` line on screen and a line in
  `bet-timing.csv` say where the seconds went: Gambit poll, waiting for book prices, the re-check,
  our rules, and how long the book took to answer (with the book's own live bet delay when it says,
  FanDuel and BetRivers). Book delays are the book holding a live bet before it re-prices it; the
  app can't shorten those.
- `prices.csv` next to the app gets a line for each check: Gambit's price, how long Gambit had shown
  it, the book's real price and EV, how long ago BetRivers last changed that price, and what happened. This shows how far behind Gambit is.
- `sharp-skips.csv` next to the app gets a line for each bet skipped by the sharp-books rule
  (`sharp.maxSpreadPts`): its EV, how far apart the sharp books were, each sharp book's no-vig win %,
  and whether it would pass at 4 or 5 points. The same bet is only written again after 5 minutes or
  when its odds change.
- `props-funnel.csv` next to the app shows why player props don't get bet. Every 10 minutes it
  adds a line: how many props Gambit listed for your books, and for each one the furthest step it
  got to (under 5% EV, 5-8% EV, no FanDuel move in 30s, game already has `maxBetsPerEvent` bets, ...,
  sent to re-check), plus what the re-check did. The same summary shows on screen as a `[PROPS]` line.
  `"propsFunnel": {"everyMinutes": 0}` turns it off.

## Novig has to agree (on by default)
A bet is only placed when Novig's price also shows it at **2% EV or more**, on top of Gambit's
`minEvPct`. It's checked twice: when scanning Gambit's rows, and again at the live price after the
book re-check. If Novig has no price for that selection, the bet is skipped. Log lines:
`Novig OK` / `Novig FAIL`, and `[SCAN] ... N dropped because Novig doesn't show 2%+`.

EV vs Novig = Novig's win probability x the book's decimal odds - 1. If both Novig sides are
known they are de-vigged; with one side, Novig's price is used as-is (it's a no-vig exchange).
If the two sides add up to under 97% or over 115% they can't be the same line (e.g. -2281/-4445),
so that counts as no Novig price and the bet is skipped (`novig.overroundRange` to change).

Set it in `config.json` -> `novig`:
- `minEvPct`: the Novig threshold (default 2). `required: false` turns the check off.
- `mode: "gambit"` (default): Novig's odds come from the Gambit row. Map them with
  `gambit.fields.novigOdds` (and optionally `novigOppOdds` for the other side).
- `mode: "feed"`: fetch Novig's own odds request (`novig.url`, `headers`, `rowsPath`, `fields`),
  matched to Gambit rows by event, market, selection and line.

Command line: `--novig-min-ev 3`, `--no-novig`.

## Checking that bets were really +EV
Every placed bet is saved to **`bets.csv`** next to the app (open it in Excel or Sheets; the same
data is in `bets.json`). Dry runs go to `bets.dry.csv`. Each row has:
- **Gambit listed odds**, **odds we checked and sent**, and **book confirmed odds**: the price
  Hard Rock (or BetRivers) says it accepted, read from its reply. `confirmed = sent` should be `yes`.
  Hard Rock bets are sent with price changes refused, so it can't fill you at a different price.
  If the book doesn't report its price, the column says `not reported` and the raw reply is in
  `debug.log`.
- **Other books' odds**: every other book Gambit listed for that selection, as `our side/other side`
  (sharp books first: Pinnacle, Kalshi, Polymarket, Novig, FanDuel), then each sharp book's no-vig
  win % and how many points apart they were. These are the prices behind the fair odds. Bets placed
  before this was added have these columns empty.
- **Fair odds**: the one we used (the lowest of Gambit's four no-vig methods), plus each method
  (Power, Multiplicative, Additive, Shin) and how many books are behind it. If Gambit's page shows a
  higher EV than the log, it's using a different method than the lowest one; find it in those columns.
- EV at Gambit's price and at the placed price, Novig's odds and EV, stake, and Hard Rock's max stake.
- **Fair set by**, **Gambit prices fetched at** and **secs from those prices to bet accepted**: which
  book(s) set the fair price and the win % taken from them, and how old the Gambit prices behind the
  EV were when the book took the bet. Then **fair odds in the first Gambit prices after accepted** and
  the EV against that, to see whether the fair price held during the book's hold.

In **Show bets**, hover a bet (tap on a phone) to see the same thing: the fair price and which book
set it, every book's two sides with the win % the fair calculation used from each (or why it was left
out, e.g. a prediction market with too little money), the time of those Gambit prices, how long
before the bet was accepted they were, how long since the sharp price last moved (live), and the
fair price right after the bet was accepted. Bets placed before this was added show the older popup.

**Closing line value (CLV).** After a bet is placed the app keeps watching Gambit's fair price for
the same selection. At game start it saves the last pre-game fair price (the "close") and works out
CLV % = the close's win probability x our decimal odds - 1. If the bets beat the close on average,
the edge is real; that's the standard check, and it doesn't need hundreds of results to settle.
- Live bets have no real close: they use the last fair price Gambit showed (`live, last seen`),
  once it's been gone for 15 minutes.
- Gambit only lists selections that are +EV somewhere. If it stops listing one after we bet, there's
  no close for it (`not seen after placing`) and it's left out of the average.
- The terminal shows a `CLV:` line for each close and the running average. **Show bets**
  (`ev-placer bets`) prints the last 25 bets and the totals.

## Bets and P&L chart
**Show bets** (`ev-placer bets`) also opens a chart page in your browser:
- **Profit and loss**: running total of settled bets, next to the expected profit (stake x EV of
  every bet). Over many bets the two should track each other; a short gap is normal luck.
- **Bets placed per day**, split by book.
- **Calendar**: each day shows the settled profit (green up, red down) and how many bets were
  placed, plus the best and worst day. Click a day to show only that day's bets in the tiles,
  chart and table; **Show all days** goes back. Use the arrows to see earlier months.
- Tiles: bets and $ staked, settled profit and ROI, expected profit, average CLV, bets still waiting.
- **All books** is the default view; click **Hard Rock Bet** or **BetRivers** to see one book.
  Also 30 days / 7 days.

**Results.** Results fill in by themselves. While the placer runs, it reads each book's
**My Bets > Settled** list every 10 minutes (Hard Rock, BetRivers and FanDuel, whichever tabs are open, on
any day) and saves the result, payout and odds of each logged bet to `results.json`. The terminal
shows a `Results:` line when bets settle. Change the timing with `"results": {"everyMinutes": 10}`
in `config.json` (0 turns it off). It's read-only, so it works while the extension is disarmed.
Bets that settled while the app was off fill in within a minute or two of starting it: until a
book's list has been read once (and after a failed read), it's tried every minute, not every 10.
Hard Rock's list is read in 2-day pieces so a long list can't cut off the newest bets. Bets
older than 14 days are no longer looked up (`"lookbackDays": 14`), and a `Results:` warning names
any bet from over a day ago that the book still doesn't list.
**Show bets** also checks the books when it opens (Chrome with the book tab open, placer not running),
so the chart catches up on days you don't bet. It lets go of the extension within 90 seconds.
BetRivers needs the extension to have seen the site's login once: refresh the BetRivers tab after
updating.

You can also mark a bet in the table at the bottom of the page (won, lost, push, void, half won,
half lost). A result you mark by hand is never overwritten. Results live in `results.json`, apart
from `bets.json`, so the running placer never overwrites them.
- Keep the Show bets window open while you mark results; closing it stops the page.
- A read-only copy is saved as `bets.html` and opens on its own later.
- Bets placed before the bet log existed (from `state.json`) are included.

## Odds source: Gambit or PropProfessor
Where the +EV rows come from is one line in config.json:
```json
"source": "gambit"
```
- `"gambit"` (default): Gambit's +EV and arbitrage tables, as before.
- `"propprofessor"`: PropProfessor's Positive EV and Arbitrage tables instead.

One source per run. The two are separate: PropProfessor rows never use Gambit's data and Gambit rows
never use PropProfessor's. (`"both"` was removed; the app stops with a message if it's still set.)

`--source propprofessor` on the command line does the same for one run.

**How PropProfessor is read:** stay logged in to propprofessor.com in Chrome. The extension reads the
tables your PropProfessor pages already show. It never calls PropProfessor itself, so the page keeps
its own login going. A PropProfessor page shows either pre-game or live, so the extension keeps one tab
for each table it needs: pre-game +EV, live +EV, and pre-game and live arbitrage when `arbProps` is on.
It opens any missing tab in the background and clicks **Live** / **Pre-Match** on it. A table that
hasn't changed for a while gets its tab reloaded, in case the page lost its feed: 2 min (live) or 5 min
(pre-game) for a table of 50+ rows, 10 / 30 min for a smaller one. Live tables are read on every scan;
pre-game ones every 10s (`"pregameEverySec"`, 0 = every scan).
bets.csv says which source found each bet ("odds source").

**Your PropProfessor settings decide what it sends:** books, leagues, min EV, hours away, devig and
comparison books. Keep them at least as wide as the app's rules, for example PropProfessor min EV at
or below the app's `minEvPct`, its books including the ones you bet, and its hours away covering
`pregameMaxHours`.

**The rules are the same as for Gambit.** Each PropProfessor row becomes a Gambit-style row: every
book's price for both sides (Pinnacle, Kalshi, Polymarket, Novig, ProphetX, FanDuel, DraftKings,
Caesars, ...) is mapped to the Gambit ids the rules use. The fair price is PropProfessor's no-vig fair,
then replaced by the sharp-book fair exactly as for Gambit rows. The bet ids come from PropProfessor's
links for each book. Arbitrage-table props are priced off `arbProps.refBooks` the same way as Gambit's.

```json
"propprofessor": { "live": true, "pregame": true, "arbPregame": true, "arbLive": true,
                   "openTabs": true, "liveMaxAgeSec": 600, "pregameMaxAgeSec": 1800,
                   "pregameEverySec": 10, "fairFallback": true, "stuckSec": 60 }
```
A PropProfessor tab that still has no table after `stuckSec` seconds (stuck loading) is closed and the
page opened again in a new tab, at most once every 3 min per table (`0` turns this off).
PropProfessor sends no Pinnacle prices, so with `"fairFallback": true` (the default) a game line
(spread, total, moneyline) that has no Pinnacle and no prediction market with enough money behind it
uses PropProfessor's own no-vig fair instead of being skipped. Every other rule still applies (min EV,
soft-book check, live timing, which then watches PropProfessor's fair for a move). Player props still
need FanDuel. `false` skips those game lines, as before.
On the first run, a sample of each table is saved next to the app
(`propprofessor-sample-ev-pregame.json` and so on), to check how it was read.

## Staying logged in (Gambit, BetRivers, Hard Rock)
Why the sites logged out during long runs: each site's own page keeps your login alive (Hard
Rock's token lasts 28 minutes and its page renews it every 10 seconds; Gambit's lasts about an
hour; BetRivers logs you out after a while with no activity). When Chrome unloads a tab you
haven't looked at in a while (Memory Saver), or the computer sleeps, the page stops and the login
runs out. What the app and extension do now:
- **Tabs stay loaded.** The extension tells Chrome never to unload the Gambit and book tabs, and
  reloads any tab Chrome already unloaded.
- **Stalled pages get reloaded.** If Gambit's token is about to run out without being renewed, or
  Hard Rock's page stops renewing its token, the extension reloads that tab so the site can renew
  the login from its cookies. Never while a bet is being sent from that tab, and at most once
  every 5 minutes per site.
- **Hard Rock and Gambit see you as active.** Hard Rock logs you out after about 30 minutes with
  no mouse or keyboard use in its tab, even while the app is running. Every 4 minutes the extension
  moves the pointer and taps Shift inside the Hard Rock and Gambit tabs. It never clicks or types.
- **BetRivers keepalive.** Once a minute the app sends the same "still here" call co.betrivers.com
  makes, from your BetRivers tab, so it doesn't time you out for inactivity.
- **Login check once a minute.** BetRivers (that keepalive) and Hard Rock (a balance read) are
  checked every minute, and Gambit on every poll.
- **Loud alert when logged out.** A bell and a red `[LOGIN]` banner in the app window, repeated
  every 2 minutes, plus a Windows/Mac notification from Chrome that stays up until you close it
  and a red **!** on the extension icon. The app never stops: it keeps scanning and retrying, and
  prints `[LOGIN] ✓ ... logged in again` once you log back in. It never types a password.
- **Gambit auto login.** When Gambit logs you out (its tab lands on the home page with a Login
  button, or Gambit keeps refusing the login), the extension opens Gambit's login box, lets
  Chrome's password manager fill in your saved email and password, and presses Login. Chrome
  hides a filled-in password from scripts until a real click, so these clicks go through Chrome's
  debugger, which counts as real input. While that runs (a few seconds) Chrome shows a bar
  "EV Placer Bridge started debugging this browser"; it closes itself. The app and extension never
  read or store the password. It tries at most every 2 minutes (every 10 after 3 failures) and
  prints `[LOGIN]` lines saying what happened. Needs the Gambit login saved in Chrome
  (chrome://password-manager) and DevTools closed on the Gambit tab. If Gambit shows a robot check
  or asks for a code, log in by hand. Turn it off with `"session": {"gambitAutoLogin": false}`.

Also on the betting PC: turn off sleep while the app runs (Windows Settings > System > Power >
Screen and sleep: "Never" while plugged in), and allow Chrome notifications
(Windows Settings > System > Notifications > Google Chrome: On).

Settings (`config.json`, all optional): `"session": {"checkSeconds": 60, "remindMinutes": 2, "reloadTabs": true, "gambitAlertSeconds": 20}`.
`"checkSeconds": 0` turns the checks off; `"reloadTabs": false` stops the app asking for tab reloads; `"gambitAutoLogin": false` turns off Gambit auto login.
Gambit only counts as logged out after it has refused for `gambitAlertSeconds` in a row, and the extension only reloads the Gambit tab after about 10 refused polls in a row or once its token has been out for a minute. If Gambit refuses the token, the extension first tries the other recent tokens your Gambit tab sent.

## Updates (automatic)
Every change pushed to `main` is built by GitHub Actions and published as a release. Each time the
app starts it checks for a newer release, downloads the build for your computer, replaces itself
and restarts in the same window. Run `ev-placer update` to check right now, or `--no-update` to skip.
If the extension's files changed, Chrome reloads it on its own.

The repo is private, so each computer needs a read-only GitHub token once:
1. Create a fine-grained token at https://github.com/settings/personal-access-tokens/new
   with access to only `EV_auto_placer` and **Contents: Read-only**.
2. Save it in a file named `github-token.txt` next to the app. On a Mac the easy way: copy the token, then run
   `pbpaste > ~/path/to/ev-placer-mac-arm64/github-token.txt` in Terminal.

## Chrome extension
1. chrome://extensions → turn on Developer mode → Load unpacked → pick the `extension/` folder next to the app.
2. Log in to BetRivers in a normal tab and leave it open.
3. Click the extension icon to see whether the engine is connected and which book tabs it sees.
   It starts **disarmed**: re-checks run, but no bet is placed until you press **Arm**.

## Running from source (developers)
Needs Node 18+.
```
npm install
npm run dry      # demo
npm start        # live
npm run build    # needs Bun (https://bun.sh); writes the three zips to dist/
```
The build re-embeds `config.example.json` and `extension/` into the app (`scripts/embed.mjs`),
so the packaged app writes out the current versions.

## How it works
- `src/sources/gambit.js` pulls Gambit's table (URL/headers from config) and maps fields via `gambit.fields`.
- `src/index.js` filters by EV, skips selections already bet (`state.json`), caps the daily stake,
  re-checks each candidate and only places if the line is unchanged, EV still meets the threshold,
  and Novig agrees (`src/novig.js`).
- `src/books/template.js` turns the `recheck` / `place` request templates in config into requests;
  `{{bookRef}}`, `{{stake}}`, `{{odds}}`, `{{decimalOdds}}`, `{{requestId}}` and any Gambit row field are substituted.
- `extension/background.js` runs each request with `fetch` inside the book tab, so the site's own
  session and geolocation apply.

The BetRivers/FanDuel request templates are filled in from real captured requests (DevTools → Copy as cURL).
