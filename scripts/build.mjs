// Builds single-file executables for Windows and Mac (no Node install needed) and
// zips each with double-click launchers. Requires Bun: https://bun.sh
//   node scripts/build.mjs            -> dist/ev-placer-{win-x64,mac-arm64,mac-x64}.zip
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const dist = path.join(root, 'dist');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const TARGETS = [
  { name: 'win-x64', bun: 'bun-windows-x64', exe: 'ev-placer.exe', asset: 'ev-placer-win-x64.exe' },
  { name: 'mac-arm64', bun: 'bun-darwin-arm64', exe: 'ev-placer', asset: 'ev-placer-mac-arm64' },
  { name: 'mac-x64', bun: 'bun-darwin-x64', exe: 'ev-placer', asset: 'ev-placer-mac-x64' },
];
const only = process.argv[2];

const LAUNCHERS = {
  win: {
    'Start EV Placer.bat': '@echo off\r\ncd /d "%~dp0"\r\nev-placer.exe %*\r\npause\r\n',
    'Run demo.bat': '@echo off\r\ncd /d "%~dp0"\r\nev-placer.exe dry\r\npause\r\n',
  },
  mac: {
    'Start EV Placer.command': '#!/bin/bash\ncd "$(dirname "$0")"\nxattr -d com.apple.quarantine ./ev-placer 2>/dev/null\n./ev-placer "$@"\n',
    'Run demo.command': '#!/bin/bash\ncd "$(dirname "$0")"\nxattr -d com.apple.quarantine ./ev-placer 2>/dev/null\n./ev-placer dry\n',
  },
};

run('node', ['scripts/embed.mjs']);
// Stamp the release version into the app (CI sets EV_VERSION, e.g. 0.3.17).
const versionFile = path.join(root, 'src', 'version.js');
const versionSrc = fs.readFileSync(versionFile, 'utf8');
if (process.env.EV_VERSION) fs.writeFileSync(versionFile, versionSrc.replace(/VERSION = '[^']*'/, `VERSION = '${process.env.EV_VERSION}'`));
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
// Stage in a local temp dir: some synced/network folders drop the executable bit.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-placer-build-'));
for (const t of TARGETS) {
  if (only && only !== t.name) continue;
  const dir = path.join(stage, `ev-placer-${t.name}`);
  fs.mkdirSync(dir, { recursive: true });
  // Optional: BUN_RUNTIMES=<dir> holding <dir>/<bun target minus "bun-">/package/bin/bun[.exe]
  // (from `npm pack @oven/bun-windows-x64@<bun version>`; darwin-arm64 is published as bun-darwin-aarch64), for builds behind a proxy.
  const rt = process.env.BUN_RUNTIMES && path.join(process.env.BUN_RUNTIMES, t.bun.replace('bun-', ''), 'package', 'bin', t.exe.endsWith('.exe') ? 'bun.exe' : 'bun');
  run('bun', ['build', 'src/index.js', '--compile', `--target=${t.bun}`, ...(rt ? ['--compile-executable-path', rt] : []), '--outfile', path.join(dir, t.exe)]);
  const os = t.name.startsWith('win') ? 'win' : 'mac';
  for (const [f, body] of Object.entries(LAUNCHERS[os])) fs.writeFileSync(path.join(dir, f), body, { mode: 0o755 });
  fs.copyFileSync(path.join(root, 'README.md'), path.join(dir, 'README.md'));
  fs.chmodSync(path.join(dir, t.exe), 0o755); // zip keeps this, so it runs right after unzipping
  run('zip', ['-qry', path.join(dist, `ev-placer-${t.name}.zip`), `ev-placer-${t.name}`], stage);
  // The bare binary is what the self-updater downloads (src/update.js assetName).
  fs.copyFileSync(path.join(dir, t.exe), path.join(dist, t.asset));
  console.log(`built dist/ev-placer-${t.name}.zip and dist/${t.asset}`);
}
fs.rmSync(stage, { recursive: true, force: true });
fs.writeFileSync(versionFile, versionSrc); // leave the source tree unchanged
