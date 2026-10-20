// Starts a Vite dev server for the app, runs ui.test.mjs against it with
// headless Chromium, then shuts the server down.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = resolve(here, '../.out');
mkdirSync(out, { recursive: true });

const PORT = Number(process.env.UI_TEST_PORT ?? 5199);
const url = `http://localhost:${PORT}/`;

function findChromium() {
  const env = process.env.MESSIER_CHROMIUM ?? process.env.CHROMIUM;
  if (env) return env;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']) {
    const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const chromium = findChromium();
if (!chromium) {
  console.error('No Chromium found. Set MESSIER_CHROMIUM or use `nix develop .#tests`.');
  process.exit(1);
}
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
if (!existsSync(viteBin)) {
  console.error('Run `npm install` in the project root first.');
  process.exit(1);
}

const vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
let status = 1;
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('Vite dev server did not start');
    await new Promise((r) => setTimeout(r, 250));
  }
  const res = spawnSync(process.execPath, [resolve(here, 'ui.test.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, APP_URL: url, OUT_DIR: out, CHROMIUM: chromium },
  });
  status = res.status ?? 1;
} finally {
  vite.kill();
}
process.exit(status);
