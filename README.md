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
- Hard Rock's Gambit sportsbook id is read from its bet links; set `gambit.bookIds.hardrock` to
  override. If the log says Gambit has no Hard Rock rows, tick Hard Rock in Gambit's sportsbook
  filter and copy the new evs.json link into `config.json`.
- Straight bets match a recorded $1 straight bet. The selection id comes from Gambit's Hard Rock
  link (`app.hardrock.bet/?deep_link_value=betslip/<id>`). Not yet known: how long Hard Rock
  accepts the location token.

## Novig has to agree (on by default)
A bet is only placed when Novig's price also shows it at **2% EV or more**, on top of Gambit's
`minEvPct`. It's checked twice: when scanning Gambit's rows, and again at the live price after the
book re-check. If Novig has no price for that selection, the bet is skipped. Log lines:
`Novig OK` / `Novig FAIL`, and `[SCAN] ... N dropped because Novig doesn't show 2%+`.

EV vs Novig = Novig's win probability x the book's decimal odds - 1. If both Novig sides are
known they are de-vigged; with one side, Novig's price is used as-is (it's a no-vig exchange).

Set it in `config.json` -> `novig`:
- `minEvPct`: the Novig threshold (default 2). `required: false` turns the check off.
- `mode: "gambit"` (default): Novig's odds come from the Gambit row. Map them with
  `gambit.fields.novigOdds` (and optionally `novigOppOdds` for the other side).
- `mode: "feed"`: fetch Novig's own odds request (`novig.url`, `headers`, `rowsPath`, `fields`),
  matched to Gambit rows by event, market, selection and line.

Command line: `--novig-min-ev 3`, `--no-novig`.

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
