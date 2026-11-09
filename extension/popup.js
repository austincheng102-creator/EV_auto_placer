const $ = (id) => document.getElementById(id);
async function render() {
  const { armed = false } = await chrome.storage.local.get('armed');
  const s = await chrome.runtime.sendMessage('status');
  $('status').textContent = s.status; $('status').className = s.status === 'connected' ? 'on' : 'off';
  $('tabs').textContent = s.tabs.map((t) => t.book).join(', ') || 'none open';
  $('armed').textContent = armed ? 'ARMED' : 'disarmed (re-checks only)'; $('armed').className = armed ? 'on' : 'off';
  $('toggle').textContent = armed ? 'Disarm' : 'Arm (allow real bets)';
}
$('toggle').onclick = async () => {
  const { armed = false } = await chrome.storage.local.get('armed');
  await chrome.storage.local.set({ armed: !armed }); render();
};
render();
