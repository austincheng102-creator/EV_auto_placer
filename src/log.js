// Terminal log matching the [hh:mm:ss] [TAG] style.
const c = { gray: 90, green: 32, cyan: 36, yellow: 33, red: 31 };
const paint = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const ts = () => new Date().toTimeString().slice(0, 8);

function line(tag, color, msg, dimTag = false) {
  const t = paint(c.gray, `[${ts()}]`);
  const label = color ? paint(c[color], `[${tag}]`) : dimTag ? paint(c.gray, `[${tag}]`) : `[${tag}]`;
  console.log(`${t}  ${label} ${msg}`);
}

export const log = {
  scan: (msg, empty) => line('SCAN', null, msg, empty),
  autoev: (msg) => line('AUTOEV', null, msg),
  header: (msg) => line('EV BET', 'cyan', `── ${msg}`),
  bet: (msg) => line('EV BET', null, msg),
  ok: (msg) => line('EV BET', 'green', `✓ ${msg}`),
  warn: (msg) => line('EV BET', 'yellow', msg),
  err: (msg) => line('ERROR', 'red', msg),
  info: (msg) => line('INFO', null, msg, true),
};
