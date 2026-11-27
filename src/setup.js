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

// Any file next to the app whose name has "config" in it and ends in .json is the config, so each
// computer's file can carry a name people recognize (ants_config.json, ethan_config.json...).
// Files the app or the docs make itself don't count.
const NOT_CONFIG = /example|effective|cache|as-sent/i;
export function configFiles(dir = appDir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  return names.filter((n) => /config.*\.json$/i.test(n) && !NOT_CONFIG.test(n) && !n.startsWith('.'))
    .map((n) => { const p = path.join(dir, n); try { return { path: p, name: n, mtime: fs.statSync(p).mtimeMs, file: fs.statSync(p).isFile() }; } catch { return null; } })
    .filter((f) => f && f.file);
}

/**
 * Which config file this run uses: --config wins; otherwise the one *config*.json next to the app.
 * With several, the most recently saved one is used, and `others` lists the rest (the caller says so).
 * With none, config.json is created from the example.
 */
export function findConfig(file) {
  if (file) {
    const p = path.isAbsolute(file) ? file : path.join(appDir, file);
    return { path: p, others: [] };
  }
  const list = configFiles().sort((a, b) => b.mtime - a.mtime);
  if (!list.length) return { path: path.join(appDir, 'config.json'), others: [] };
  return { path: list[0].path, others: list.slice(1).map((f) => f.name) };
}

export function ensureConfig(file) {
  const { path: p, others } = findConfig(file);
  if (fs.existsSync(p)) return { path: p, created: false, others };
  fs.writeFileSync(p, embedded['config.example.json']);
  return { path: p, created: true, others };
}
