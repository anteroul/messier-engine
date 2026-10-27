// Boots the editor in headless Chromium (WebGPU on Vulkan), optionally runs JS in the page, takes a screenshot
// and reports console errors. Run inside `nix develop .#tests` from the repo root; see SKILL.md.
//
//   node .claude/skills/run/shot.mjs [--url URL] [--out PATH] [--eval JS]... [--wait MS] [--size WxH]
//
// Without --url it starts its own Vite dev server. Each --eval is an async function body with `engine` and
// `editor` in scope; its return value is printed as JSON. Every run uses a fresh profile, so the demo scene loads
// instead of an IndexedDB autosave.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// puppeteer-core is a dependency of the tests/ package, not of the app.
const puppeteer = createRequire(resolve(root, 'tests/package.json'))('puppeteer-core');

const opts = { url: null, out: resolve(root, 'tests/.out/run.png'), evals: [], wait: 500, size: [1400, 820] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => {
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    return argv[++i];
  };
  if (a === '--url') opts.url = val();
  else if (a === '--out') opts.out = resolve(val());
  else if (a === '--eval') opts.evals.push(val());
  else if (a === '--wait') opts.wait = Number(val());
  else if (a === '--size') opts.size = val().split('x').map(Number);
  else throw new Error(`unknown argument ${a}`);
}

function findChromium() {
  const env = process.env.MESSIER_CHROMIUM ?? process.env.CHROMIUM;
  if (env) return env;
  const r = spawnSync('sh', ['-c', 'command -v chromium || command -v google-chrome-stable'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const chromium = findChromium();
if (!chromium) {
  console.error('No Chromium found. Run inside `nix develop .#tests`.');
  process.exit(1);
}

let vite = null;
let url = opts.url;
if (!url) {
  const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
  if (!existsSync(viteBin)) {
    console.error('Run `npm install` in the repo root first.');
    process.exit(1);
  }
  const port = Number(process.env.RUN_PORT ?? 5198);
  url = `http://localhost:${port}/`;
  vite = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      vite.kill();
      console.error(`Vite dev server did not start on port ${port} (is it already in use? set RUN_PORT)`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const [w, h] = opts.size;
const browser = await puppeteer.launch({
  executablePath: chromium,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', `--window-size=${w},${h}`],
  defaultViewport: { width: w, height: h },
});
const messages = [];
let status = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') messages.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => messages.push(`pageerror: ${e.message}`));

  await page.goto(url, { waitUntil: 'networkidle0' });
  try {
    await page.waitForFunction(() => window.editor && window.engine, { timeout: 15000 });
  } catch {
    const box = await page.$eval('#error', (e) => (e.hidden ? '' : e.innerText)).catch(() => '');
    throw new Error(`editor did not start${box ? `: ${box}` : ''}`);
  }
  await new Promise((r) => setTimeout(r, opts.wait));

  for (const body of opts.evals) {
    const result = await page.evaluate(async (body) => {
      const { engine, editor } = window;
      const value = await new Function('engine', 'editor', `return (async () => { ${body} })()`)(engine, editor);
      return JSON.stringify(value ?? null, (_, v) => (ArrayBuffer.isView(v) ? [...v] : v));
    }, body);
    console.log(`eval: ${result}`);
    // Let a few frames render so the screenshot reflects the change.
    await new Promise((r) => setTimeout(r, 200));
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  await page.screenshot({ path: opts.out });
  console.log(`screenshot: ${opts.out}`);
} catch (err) {
  console.error(`FAIL ${err.message}`);
  status = 1;
} finally {
  await browser.close();
  vite?.kill();
}

if (messages.length) {
  console.log(`console (${messages.length}):`);
  for (const m of messages) console.log(`  ${m}`);
  status = status || 2;
} else {
  console.log('console: clean');
}
process.exit(status);
