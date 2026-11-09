// Where config.json / state.json / extension live.
// Running from source: the project folder. Running as a packaged executable:
// the folder the executable sits in, so everything stays together on any OS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
// Compiled binaries run from Bun's virtual filesystem: /$bunfs/... (Mac/Linux) or B:\~BUN\... (Windows).
export const isPackaged = /\$bunfs|~BUN/.test(here) || !fs.existsSync(here);
export const appDir = process.env.EV_PLACER_HOME
  || (isPackaged ? path.dirname(process.execPath) : path.resolve(path.dirname(here), '..'));
