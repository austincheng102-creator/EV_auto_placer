// First-run setup: writes config.json and the Chrome extension folder next to the app.
// The files are embedded (src/embedded.js) so the packaged executable is a single file.
import fs from 'node:fs';
import path from 'node:path';
import { appDir } from './paths.js';
import embedded from './embedded.js';

// True when this run rewrote extension files (e.g. after an update), so Chrome should reload it.
export let extensionChanged = false;

export function writeExtension() {
  const dir = path.join(appDir, 'extension');
  for (const [rel, body] of Object.entries(embedded)) {
    if (!rel.startsWith('extension/')) continue;
    const p = path.join(appDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== body) {
      if (fs.existsSync(p)) extensionChanged = true;
      fs.writeFileSync(p, body);
    }
  }
  return dir;
}

export function ensureConfig(file = 'config.json') {
  const p = path.isAbsolute(file) ? file : path.join(appDir, file);
  if (fs.existsSync(p)) return { path: p, created: false };
  fs.writeFileSync(p, embedded['config.example.json']);
  return { path: p, created: true };
}
