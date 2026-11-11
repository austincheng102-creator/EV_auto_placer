const $ = (id) => document.getElementById(id);
async function render() {
  const { armed = false } = await chrome.storage.local.get('armed');
  const s = await chrome.runtime.sendMessage('status');
  $('status').textContent = s.status; $('status').className = s.status === 'connected' ? 'on' : 'off';
  $('tabs').textContent = s.tabs.map((t) => t.book).join(', ') || 'none open';
  $('gambit').textContent = s.gambitLogin ? 'seen' : 'not yet (refresh Gambit tab)'; $('gambit').className = s.gambitLogin ? 'on' : 'off';
  $('br').textContent = s.betriversLogin ? 'seen' : 'not yet (click any odds in the BetRivers tab)'; $('br').className = s.betriversLogin ? 'on' : 'off';
  $('hr').textContent = s.hardrockLogin ? 'seen' : 'not yet (refresh the Hard Rock tab)'; $('hr').className = s.hardrockLogin ? 'on' : 'off';
  const geoMin = s.hardrockGeo ? Math.round((Date.now() - s.hardrockGeo) / 60000) : null;
  $('hrgeo').textContent = geoMin == null ? 'not yet (place one bet by hand)' : `from your bet ${geoMin} min ago`; $('hrgeo').className = geoMin == null ? 'off' : 'on';
  $('armed').textContent = armed ? 'ARMED' : 'disarmed (re-checks only)'; $('armed').className = armed ? 'on' : 'off';
  $('toggle').textContent = armed ? 'Disarm' : 'Arm (allow real bets)';
}
$('toggle').onclick = async () => {
  const { armed = false } = await chrome.storage.local.get('armed');
  await chrome.storage.local.set({ armed: !armed }); render();
};
render();
