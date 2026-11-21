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

## Picking the book (BetRivers or Hard Rock Bet)
One app runs either book; the Gambit feed, Novig check, EV math and limits are shared.
- Double-click **Start BetRivers** or **Start Hard Rock** to bet that book for the day.
  **Start EV Placer** uses `"books"` from `config.json`.
- Set `"books": "ask"` in `config.json` to be asked which book each time it starts.
- From a terminal: `ev-placer --book hardrock`, or `--books betrivers,hardrock` for both at once.
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
| Hard Rock: skip when its price changed under 3s before the scan and shows 3+ points more EV than Gambit's copy (the game likely moved before the sharp prices caught up) | 3s, 3 pts | `"freshJump": {"books", "sec", "evPts"}`, `false` turns it off |
| Sharp books' no-vig win probabilities within 3 points of each other (Pinnacle, Kalshi, Polymarket, Novig; not FanDuel) | 3 | `"sharp": {"maxSpreadPts", "spreadBooks"}` |
| Live mainlines need Pinnacle, Kalshi, Polymarket or Novig listed | | `"sharp": {"liveMainlineNeeds"}` |
| Live player props need FanDuel listed | | `"sharp": {"livePropNeeds"}` |
| Live: a sharp price changed within the last 5 seconds | 5 | `"sharp": {"liveMaxAgeSec"}` |
| Live player props: FanDuel's price changed within the last 30 seconds | 30 | `"sharp": {"livePropMaxAgeSec"}` |
| Same game + market + period = one group (both sides): one bet, $1 total | 1 bet, $1 | `"group": {"maxBets", "maxStake", "bothSides"}` |

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
  `maxBetsPerEvent` still caps the whole game.
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
- `prices.csv` next to the app gets a line for each check: Gambit's price, how long Gambit had shown
  it, the book's real price and EV, how long ago BetRivers last changed that price, and what happened. This shows how far behind Gambit is.

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
- **Fair odds**: the one we used (the lowest of Gambit's four no-vig methods), plus each method
  (Power, Multiplicative, Additive, Shin) and how many books are behind it. If Gambit's page shows a
  higher EV than the log, it's using a different method than the lowest one; find it in those columns.
- EV at Gambit's price and at the placed price, Novig's odds and EV, stake, and Hard Rock's max stake.

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
**My Bets > Settled** list every 10 minutes (Hard Rock and BetRivers, whichever tabs are open, on
any day) and saves the result, payout and odds of each logged bet to `results.json`. The terminal
shows a `Results:` line when bets settle. Change the timing with `"results": {"everyMinutes": 10}`
in `config.json` (0 turns it off). It's read-only, so it works while the extension is disarmed.
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

Also on the betting PC: turn off sleep while the app runs (Windows Settings > System > Power >
Screen and sleep: "Never" while plugged in), and allow Chrome notifications
(Windows Settings > System > Notifications > Google Chrome: On).

Settings (`config.json`, all optional): `"session": {"checkSeconds": 60, "remindMinutes": 2, "reloadTabs": true, "gambitAlertSeconds": 20}`.
`"checkSeconds": 0` turns the checks off; `"reloadTabs": false` stops the app asking for tab reloads.
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
