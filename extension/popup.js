const $ = (id) => document.getElementById(id);
async function render() {
  const { armed = false } = await chrome.storage.local.get('armed');
  const s = await chrome.runtime.sendMessage('status');
  $('status').textContent = s.status; $('status').className = s.status === 'connected' ? 'on' : 'off';
  $('tabs').textContent = s.tabs.map((t) => t.book).join(', ') || 'none open';
  const gLeft = s.gambitExp ? Math.round((s.gambitExp * 1000 - Date.now()) / 60000) : null;
  $('gambit').textContent = !s.gambitLogin ? 'not yet (refresh Gambit tab)' : gLeft == null ? 'seen' : gLeft > 0 ? `seen (token good for ${gLeft} min)` : 'token ran out (reloading the Gambit tab)';
  $('gambit').className = s.gambitLogin && (gLeft == null || gLeft > 0) ? 'on' : 'off';
  $('alert').hidden = !s.alert; $('alert').textContent = s.alert ? `⚠ ${s.alert}` : '';
  $('reload').hidden = !s.lastReload;
  if (s.lastReload) $('reload').textContent = `Last tab reload: ${s.lastReload.book}, ${Math.round((Date.now() - s.lastReload.at) / 60000)} min ago (${s.lastReload.why})`;
  $('login').hidden = !s.lastLogin;
  if (s.lastLogin) { $('login').textContent = `Gambit auto login ${Math.round((Date.now() - s.lastLogin.at) / 60000)} min ago: ${s.lastLogin.ok ? 'worked' : s.lastLogin.why}`; $('login').className = `row ${s.lastLogin.ok ? 'on' : 'off'}`; }
  $('br').textContent = s.betriversLogin ? 'seen' : 'not yet (click any odds in the BetRivers tab)'; $('br').className = s.betriversLogin ? 'on' : 'off';
  const bl = s.betriversGeoExp ? Math.round((s.betriversGeoExp - Date.now()) / 60000) : null;
  const blast = s.betriversGeoLast && !s.betriversGeoLast.ok ? ` (last renewal didn't work: ${s.betriversGeoLast.why})` : '';
  $('brgeo').textContent = (!s.betriversGeoSeen ? 'not seen yet (reload the BetRivers tab once)' : bl != null && bl >= 0 ? `good for ${bl} min (renewed automatically)` : 'ran out (renewing automatically)') + blast;
  $('brgeo').className = bl != null && bl >= 0 ? 'on' : 'off';
  $('hr').textContent = s.hardrockLogin ? 'seen' : 'not yet (refresh the Hard Rock tab)'; $('hr').className = s.hardrockLogin ? 'on' : 'off';
  const geoMin = s.hardrockGeo ? Math.round((Date.now() - s.hardrockGeo) / 60000) : null;
  $('hrgeo').textContent = geoMin == null ? 'not yet (place one bet by hand)' : `from your bet ${geoMin} min ago`; $('hrgeo').className = geoMin == null ? 'off' : 'on';
  const fLeft = s.fanduelExp ? Math.round((s.fanduelExp * 1000 - Date.now()) / 60000) : null;
  $('fd').textContent = fLeft == null ? 'not yet (refresh the FanDuel tab)' : fLeft > 0 ? `seen (good for ${fLeft} min)` : 'token ran out (reloading the FanDuel tab)';
  $('fd').className = fLeft > 0 ? 'on' : 'off';
  const gl = s.fanduelGeoExp ? Math.round((s.fanduelGeoExp - Date.now()) / 60000) : null;
  const last = s.fanduelGeoLast && !s.fanduelGeoLast.ok ? ` (last renewal didn't work: ${s.fanduelGeoLast.why})` : '';
  $('fdgeo').textContent = (gl == null ? 'not seen yet (renewing automatically)' : gl > 0 ? `good for ${gl} min (renewed automatically)` : 'ran out (renewing automatically)') + last;
  $('fdgeo').className = gl > 0 ? 'on' : 'off';
  { const n = s.betmgmGeoNext ? Math.round((s.betmgmGeoNext - Date.now()) / 60000) : null; const l = s.betmgmGeoLast ? ` (last renewal: ${s.betmgmGeoLast.ok ? 'worked' : 'failed'})` : '';
    $('bmgeo').textContent = (n == null ? 'not seen yet (renewed automatically)' : n >= 0 ? `next check due in ${n} min (renewed automatically)` : 'due now (renewing automatically)') + l; $('bmgeo').className = n != null && n >= 0 ? 'on' : 'off'; }
  { const n = s.thescoreGeoNext ? Math.round((s.thescoreGeoNext - Date.now()) / 60000) : null; const l = s.thescoreGeoLast ? ` (last renewal: ${s.thescoreGeoLast.ok ? 'worked' : 'failed'})` : '';
    $('tsgeo').textContent = (n == null ? 'not seen yet (renewed automatically)' : n >= 0 ? `good for ${n} min (renewed automatically)` : 'ran out (renewing automatically)') + l; $('tsgeo').className = n != null && n >= 0 ? 'on' : 'off'; }
  $('bm').textContent = s.betmgmLogin ? `seen${(s.betmgmHeaders || []).length ? ` (${s.betmgmHeaders.join(', ')})` : ' (refresh the BetMGM tab once)'}` : 'not yet (refresh the BetMGM tab)'; $('bm').className = s.betmgmLogin ? 'on' : 'off';
  { const h = s.thescoreHeaders || []; $('ts').textContent = h.length ? h.join(', ') : 'none seen yet (cookies only; refresh the theScore tab)'; $('ts').className = h.length ? 'on' : 'off'; }
  { const left = s.dkSpanLeft != null ? Math.max(0, Math.round((s.dkSpanLeft - (Date.now() - s.dkSpanAt) / 1000) / 60)) : null;
    $('dkspan').textContent = left == null ? 'not seen yet (open the DraftKings tab)' : `${left} min left (renewed automatically)${s.dkSpanRenewedAt ? `, last renewed ${Math.round((Date.now() - s.dkSpanRenewedAt) / 60000)} min ago` : ''}`;
    $('dkspan').className = left ? 'on' : 'off'; }
  $('armed').textContent = armed ? 'ARMED' : 'disarmed (re-checks only)'; $('armed').className = armed ? 'on' : 'off';
  $('toggle').textContent = armed ? 'Disarm' : 'Arm (allow real bets)';
}
$('toggle').onclick = async () => {
  const { armed = false } = await chrome.storage.local.get('armed');
  await chrome.storage.local.set({ armed: !armed }); render();
};
render();
