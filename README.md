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
- Tiles: bets and $ staked, settled profit and ROI, expected profit, average CLV, bets still waiting.
- **All books** is the default view; click **Hard Rock Bet** or **BetRivers** to see one book.
  Also 30 days / 7 days.

**Results.** Results fill in by themselves. While the placer runs, it reads each book's
**My Bets > Settled** list every 10 minutes (Hard Rock and BetRivers, whichever tabs are open, on
any day) and saves the result, payout and odds of each logged bet to `results.json`. The terminal
shows a `Results:` line when bets settle. Change the timing with `"results": {"everyMinutes": 10}`
in `config.json` (0 turns it off). It's read-only, so it works while the extension is disarmed.
BetRivers needs the extension to have seen the site's login once: refresh the BetRivers tab after
updating.

You can also mark a bet in the table at the bottom of the page (won, lost, push, void, half won,
half lost). A result you mark by hand is never overwritten. Results live in `results.json`, apart
from `bets.json`, so the running placer never overwrites them.
- Keep the Show bets window open while you mark results; closing it stops the page.
- A read-only copy is saved as `bets.html` and opens on its own later.
- Bets placed before the bet log existed (from `state.json`) are included.

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
