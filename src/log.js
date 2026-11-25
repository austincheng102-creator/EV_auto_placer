// Terminal log matching the [hh:mm:ss] [TAG] style.
import fs from 'node:fs';
import path from 'node:path';
import { appDir } from './paths.js';
const c = { gray: 90, green: 32, cyan: 36, yellow: 33, red: 31 };
const paint = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const ts = () => new Date().toTimeString().slice(0, 8);

function line(tag, color, msg, dimTag = false) {
  const t = paint(c.gray, `[${ts()}]`);
  const label = color ? paint(c[color], `[${tag}]`) : dimTag ? paint(c.gray, `[${tag}]`) : `[${tag}]`;
  console.log(`${t}  ${label} ${msg}`);
}

// Full details (raw book responses) go to debug.log next to the app, not the screen.
// Kept under ~5 MB: when it grows past that, the old file becomes debug.old.log.
const debugPath = path.join(appDir, 'debug.log');
// The file's size is looked up once and then counted here, instead of two disk checks per line.
let debugSize = null;
function debug(msg) {
  try {
    if (debugSize == null) { try { debugSize = fs.statSync(debugPath).size; } catch { debugSize = 0; } }
    if (debugSize > 5e6) { fs.renameSync(debugPath, path.join(appDir, 'debug.old.log')); debugSize = 0; }
    const line = `${new Date().toISOString()} ${msg}\n`;
    fs.appendFileSync(debugPath, line);
    debugSize += Buffer.byteLength(line);
  } catch { debugSize = null; }
}

export const log = {
  debug,
  scan: (msg, empty) => line('SCAN', null, msg, empty),
  autoev: (msg) => line('AUTOEV', null, msg),
  header: (msg) => line('EV BET', 'cyan', `── ${msg}`),
  bet: (msg) => line('EV BET', null, msg),
  ok: (msg) => line('EV BET', 'green', `✓ ${msg}`),
  warn: (msg) => line('EV BET', 'yellow', msg),
  err: (msg) => line('ERROR', 'red', msg),
  info: (msg) => line('INFO', null, msg, true),
  // Something needs you (a site logged out): a bell, and a red block that's hard to miss.
  alarm: (msg) => {
    process.stdout.write('\x07');
    const bar = '!'.repeat(70);
    for (const m of [bar, `!!  ${msg}`, bar]) line('LOGIN', 'red', process.stdout.isTTY ? `\x1b[1;41;97m${m}\x1b[0m` : m);
  },
  good: (msg) => line('LOGIN', 'green', `✓ ${msg}`),
};
