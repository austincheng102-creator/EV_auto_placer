// Terminal log matching the [hh:mm:ss] [TAG] style.
import fs from 'node:fs';
import path from 'node:path';
import { appDir } from './paths.js';
const c = { gray: 90, green: 32, cyan: 36, yellow: 33, red: 31 };
const paint = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const ts = () => new Date().toTimeString().slice(0, 8);

// Status line: one line at the bottom that each scan rewrites in place (on a terminal).
// Any other log line clears it first and it's drawn again on the next scan. Without a terminal
// (output to a file) it's printed as a normal line at most every 30 seconds.
let statusShown = false, lastStatusPrint = 0;
function clearStatus() {
  if (statusShown) { process.stdout.write('\r\x1b[2K'); statusShown = false; }
}
function status(msg) {
  const text = `[${ts()}]  ${msg}`;
  if (!process.stdout.isTTY) {
    if (Date.now() - lastStatusPrint > 30e3) { lastStatusPrint = Date.now(); console.log(text); }
    return;
  }
  const w = Math.max(20, (process.stdout.columns || 120) - 1);
  process.stdout.write('\r\x1b[2K' + paint(c.gray, text.length > w ? text.slice(0, w - 1) + '…' : text));
  statusShown = true;
}

function line(tag, color, msg, dimTag = false) {
  clearStatus();
  const t = paint(c.gray, `[${ts()}]`);
  const label = color ? paint(c[color], `[${tag}]`) : dimTag ? paint(c.gray, `[${tag}]`) : `[${tag}]`;
  console.log(`${t}  ${label} ${msg}`);
}

// Full details (raw book responses) go to debug.log next to the app, not the screen.
// Kept under ~5 MB: when it grows past that, the old file becomes debug.old.log.
const debugPath = path.join(appDir, 'debug.log');
function debug(msg) {
  try {
    if (fs.existsSync(debugPath) && fs.statSync(debugPath).size > 5e6) fs.renameSync(debugPath, path.join(appDir, 'debug.old.log'));
    fs.appendFileSync(debugPath, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

export const log = {
  debug,
  status,
  scan: (msg, empty) => line('SCAN', null, msg, empty),
  autoev: (msg) => line('AUTOEV', null, msg),
  header: (msg) => line('EV BET', 'cyan', `── ${msg}`),
  bet: (msg) => line('EV BET', null, msg),
  ok: (msg) => line('EV BET', 'green', `✓ ${msg}`),
  warn: (msg) => line('EV BET', 'yellow', msg),
  err: (msg) => line('ERROR', 'red', msg),
  info: (msg) => line('INFO', null, msg, true),
};
