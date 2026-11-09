// Self-updater for the packaged app. At startup it asks GitHub for the latest release;
// if it's newer, it downloads the binary for this OS, swaps it in place and restarts.
// Works on Windows (a running .exe can be renamed, just not overwritten) and Mac.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appDir, isPackaged } from './paths.js';
import { VERSION } from './version.js';

export const UPDATE_REPO = process.env.EV_PLACER_REPO || 'austincheng102-creator/EV_auto_placer';
const isWin = process.platform === 'win32';
export const assetName = `ev-placer-${isWin ? 'win' : 'mac'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}${isWin ? '.exe' : ''}`;

const parse = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
export function isNewer(latest, current) {
  const a = parse(latest), b = parse(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** GitHub token for a private repo: env, github-token.txt next to the app, or config.update.githubToken. */
// Pull the token out of whatever is in the file (TextEdit may save rich text, quotes, etc.).
const TOKEN_RE = /github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+/;
export function cleanToken(raw) {
  if (!raw) return null;
  const m = String(raw).match(TOKEN_RE);
  return m ? m[0] : null;
}
export function readToken(cfg) {
  if (process.env.EV_PLACER_TOKEN) return cleanToken(process.env.EV_PLACER_TOKEN);
  const f = path.join(appDir, 'github-token.txt');
  if (fs.existsSync(f)) return cleanToken(fs.readFileSync(f, 'utf8'));
  return cleanToken(cfg?.update?.githubToken);
}

const gh = (token, accept = 'application/vnd.github+json') => ({
  accept, 'user-agent': 'ev-placer-updater', 'x-github-api-version': '2022-11-28',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

/** Remove the previous binary left behind by the last update. */
export function cleanupOld() {
  const old = `${process.execPath}.old`;
  try { if (isPackaged && fs.existsSync(old)) fs.rmSync(old, { force: true }); } catch {}
}

/**
 * Returns true if an update was installed and the new version has been started
 * (the caller should then stop and wait). Never throws: any failure just logs.
 */
export async function checkForUpdate({ cfg, log, force = false }) {
  if (!isPackaged && !force) return false;              // running from source: use git pull instead
  if (cfg?.update?.enabled === false) return false;
  const token = readToken(cfg);
  if (!token && fs.existsSync(path.join(appDir, 'github-token.txt'))) {
    log.info('Update check skipped: github-token.txt has no GitHub token in it (it should start with github_pat_)');
    return false;
  }
  try {
    const res = await fetch(`${process.env.EV_PLACER_API || 'https://api.github.com'}/repos/${UPDATE_REPO}/releases/latest`,
      { headers: gh(token), signal: AbortSignal.timeout(8000) });
    if (res.status === 404) {
      log.info(token ? 'Update check: no release found (or the token can’t see the repo)'
                     : 'Update check skipped: repo is private, add your token to github-token.txt next to the app');
      return false;
    }
    if (!res.ok) { log.info(`Update check failed: GitHub HTTP ${res.status}`); return false; }
    const rel = await res.json();
    if (!isNewer(rel.tag_name, VERSION)) { log.info(`Up to date (v${VERSION})`); return false; }
    const asset = (rel.assets || []).find((a) => a.name === assetName);
    if (!asset) { log.info(`Update ${rel.tag_name} has no ${assetName} build yet`); return false; }
    if (!isPackaged) { log.info(`Update ${rel.tag_name} available (running from source: git pull)`); return false; }

    log.info(`Updating v${VERSION} -> ${rel.tag_name} …`);
    const dl = await fetch(token ? asset.url : asset.browser_download_url,
      { headers: gh(token, 'application/octet-stream'), signal: AbortSignal.timeout(180000) });
    if (!dl.ok) { log.info(`Update download failed: HTTP ${dl.status}`); return false; }
    const bytes = Buffer.from(await dl.arrayBuffer());
    if (bytes.length !== asset.size) { log.info('Update download incomplete, keeping current version'); return false; }

    const exe = process.execPath, tmp = `${exe}.new`, old = `${exe}.old`;
    fs.writeFileSync(tmp, bytes, { mode: 0o755 });
    try { fs.rmSync(old, { force: true }); } catch {}
    fs.renameSync(exe, old);
    try { fs.renameSync(tmp, exe); }
    catch (e) { fs.renameSync(old, exe); throw e; }   // put the old one back
    log.info(`Updated to ${rel.tag_name}, restarting`);

    // Run the new version in this same terminal with the same arguments.
    const child = spawn(exe, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, EV_PLACER_JUST_UPDATED: rel.tag_name } });
    process.on('SIGINT', () => {});                     // Ctrl+C reaches the child directly
    child.on('exit', (code) => process.exit(code ?? 0));
    return true;
  } catch (e) {
    log.info(`Update check failed: ${e.message}`);
    return false;
  }
}
