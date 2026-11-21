# Bet365 standalone scanner

An isolated read-only scanner. It does not import or modify the parent app's source, launchers, root config, package files, or original Chrome extension. Own Node process, extension, config, tests, and WebSocket port 8875.

Rules: 15% minimum EV; no player props; minimum 2 valid two-sided consensus sources from FanDuel (100), DraftKings (200), Caesars (300), MGM (400); all available valid consensus probabilities must be within 5 percentage points after de-vigging; odds -300 to +250; 25% EV cap; pre-game within 12 hours; Novig EV >= 2% by default.

Windows: install Node 18+; open PowerShell in the bet365 folder; run npm install; run npm run init; edit config.json and set scanEnabled=true while leaving livePlacementEnabled=false; log in to Gambit in Chrome; open chrome://extensions, enable Developer mode, click Load unpacked, select bet365/extension; run npm run dry and stop with Ctrl+C. For a single scan use npm run dry:once after the extension is already connected. Run npm test for unit tests.

Removal: stop the process, remove the Bet365 EV Scanner extension, delete this folder. Parent app stays untouched. You can instead delete this feature branch; main is unchanged.

Live placement is not implemented. The uploaded Bet365 HAR includes geo_complyfailed in add-to-slip responses. This phase only reads Gambit's feed and prints candidates; it never calls Bet365 write endpoints and must not bypass location/account checks.
