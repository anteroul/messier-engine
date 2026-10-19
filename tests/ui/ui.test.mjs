// Drives the real editor UI in headless Chromium (WebGPU) against a Vite dev
// server and checks editor state after each interaction. Screenshots go to
// tests/.out/. Run via `npm run test:ui` (see tests/ui/run.mjs).
import puppeteer from 'puppeteer-core';

const OUT = process.env.OUT_DIR;
const URL = process.env.APP_URL;
let failures = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--window-size=1400,820'],
  defaultViewport: { width: 1400, height: 820 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.editor && window.engine.scene.findByName('Lantern') && window.engine.scene.findByName('icosahedron'), { timeout: 15000 });
await sleep(500);

/** Viewport-page coordinates of a world point. */
const screenOf = (expr) =>
  page.evaluate((expr) => {
    const { engine } = window;
    const canvas = document.getElementById('gpu-canvas');
    const r = canvas.getBoundingClientRect();
    const p = new Function('engine', `return ${expr}`)(engine);
    const s = engine.camera.worldToScreen(p, canvas.clientWidth, canvas.clientHeight);
    return [r.left + s[0], r.top + s[1]];
  }, expr);
const state = (fn) => page.evaluate(fn);

// --- Click-select
const [sx, sy] = await screenOf(`engine.scene.findByName('Plastic Sphere').worldPosition()`);
await page.mouse.click(sx, sy);
await sleep(100);
check('click selects object', (await state(() => window.editor.selected?.name)) === 'Plastic Sphere');
const inspectorText = await page.$eval('#inspector', (e) => e.innerText);
check('inspector shows transform + material', inspectorText.includes('Position') && inspectorText.includes('Roughness'));
check('hierarchy highlights selection', (await page.$eval('.tree-row.selected .tree-name', (e) => e.textContent)) === 'Plastic Sphere');

// --- Gizmo drag along X
const before = await state(() => [...window.editor.selected.transform.position]);
const handle = await screenOf(`(() => { const o = engine.scene.findByName('Plastic Sphere'); const c = o.worldPosition(); const s = engine.camera.worldPerPixel(c, document.getElementById('gpu-canvas').clientHeight) * 110 * 0.55; return [c[0] + s, c[1], c[2]]; })()`);
const target = await screenOf(`(() => { const o = engine.scene.findByName('Plastic Sphere'); const c = o.worldPosition(); const s = engine.camera.worldPerPixel(c, document.getElementById('gpu-canvas').clientHeight) * 110 * 0.55; return [c[0] + s + 1.5, c[1], c[2]]; })()`);
await page.mouse.move(handle[0], handle[1]);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(handle[0] + ((target[0] - handle[0]) * i) / 10, handle[1] + ((target[1] - handle[1]) * i) / 10);
await page.mouse.up();
const after = await state(() => [...window.editor.selected.transform.position]);
const dx = after[0] - before[0];
check('gizmo drag moves along X', Math.abs(dx - 1.5) < 0.05 && Math.abs(after[1] - before[1]) < 1e-4 && Math.abs(after[2] - before[2]) < 1e-4, `dx=${dx.toFixed(3)}`);
const inspectorX = await page.$eval('#inspector .vec-field input', (e) => parseFloat(e.value));
check('inspector live-updates during drag', Math.abs(inspectorX - after[0]) < 1e-3, String(inspectorX));

// --- Undo / redo
await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
const undone = await state(() => [...window.editor.selected.transform.position]);
check('undo restores position', Math.abs(undone[0] - before[0]) < 1e-5);
await page.keyboard.down('Control');
await page.keyboard.down('Shift');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Shift');
await page.keyboard.up('Control');
check('redo re-applies', Math.abs((await state(() => window.editor.selected.transform.position[0])) - after[0]) < 1e-5);

// --- Inspector numeric edit
const yInput = (await page.$$('#inspector .vec-field input'))[1];
await yInput.click({ clickCount: 3 });
await yInput.type('2.5');
await page.keyboard.press('Enter');
check('inspector edit sets Y', Math.abs((await state(() => window.editor.selected.transform.position[1])) - 2.5) < 1e-6);

// --- Rotate mode via keyboard + inspector rotation field
await page.$eval('#gpu-canvas', (e) => e.focus());
await page.keyboard.press('KeyE');
check('E switches to rotate', (await state(() => window.editor.gizmo.mode)) === 'rotate');
await page.keyboard.press('KeyW');

// --- Add menu
await page.click('summary.btn');
await page.click('[data-action="add-cube"]');
await sleep(100);
check('Add > Cube creates and selects', (await state(() => window.editor.selected?.name)) === 'Cube');
check('hierarchy lists new cube', (await page.$$eval('.tree-name', (els) => els.map((e) => e.textContent))).includes('Cube'));
check('menu closed after choice', (await page.$('details.menu[open]')) === null);

// --- Add light, change type in inspector
await page.click('summary.btn');
await page.click('[data-action="add-point"]');
await sleep(50);
await page.select('#inspector select', 'spot');
await sleep(50);
check('light type change via inspector', (await state(() => window.editor.selected.light.type)) === 'spot' && (await page.$eval('#inspector', (e) => e.innerText.includes('Outer angle'))));

// --- Duplicate + delete + undo
await page.$eval('#gpu-canvas', (e) => e.focus());
await page.keyboard.down('Control');
await page.keyboard.press('KeyD');
await page.keyboard.up('Control');
check('duplicate', (await state(() => window.editor.selected?.name)) === 'Point Light copy');
await page.keyboard.press('Delete');
check('delete', (await state(() => !window.engine.scene.findByName('Point Light copy'))));
await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
check('undo delete', (await state(() => !!window.engine.scene.findByName('Point Light copy'))));

// --- Play mode runs behaviours and restores on stop
const rot0 = await state(() => [...window.engine.scene.findByName('Spinning Cube').transform.rotation]);
await page.click('[data-action="play"]');
await sleep(800);
const rot1 = await state(() => [...window.engine.scene.findByName('Spinning Cube').transform.rotation]);
check('play animates behaviours', rot0.some((v, i) => Math.abs(v - rot1[i]) > 1e-3));
await page.screenshot({ path: `${OUT}/ui-playing.png` });
await page.click('[data-action="play"]');
await sleep(50);
const rot2 = await state(() => [...window.engine.scene.findByName('Spinning Cube').transform.rotation]);
check('stop restores transforms', rot0.every((v, i) => Math.abs(v - rot2[i]) < 1e-6));

await state(() => { window.engine.scene.findByName('Lantern').transform.position = [2.6, 0, 3.4]; });
await sleep(100);
await page.$eval('#gpu-canvas', (e) => e.focus());
await page.keyboard.press('KeyH');
check('H hides helpers', (await state(() => window.editor.showHelpers)) === false);
// --- Select lantern via click (top-level first, then drill down)
const [lx, ly] = await screenOf(`engine.scene.findByName('Glass').worldPosition()`);
await page.mouse.click(lx, ly);
await sleep(50);
const first = await state(() => window.editor.selected?.name);
await page.mouse.click(lx, ly);
await sleep(50);
const second = await state(() => window.editor.selected?.name);
check('click selects model root then drills down', first === 'Lantern' && second === 'Pole', `${first} -> ${second}`);

// --- Hierarchy re-parent via API path (DnD is hard to synthesise) keeps world position
const kept = await state(() => {
  const ed = window.editor;
  const cube = ed.engine.scene.findByName('Cube');
  const rig = ed.engine.scene.findByName('Light Rig');
  const wp = cube.worldPosition();
  ed.reparent(cube, rig);
  const wp2 = cube.worldPosition();
  return Math.hypot(wp[0] - wp2[0], wp[1] - wp2[1], wp[2] - wp2[2]);
});
check('reparent keeps world position', kept < 1e-4, kept.toExponential(2));

await page.mouse.click(lx, ly);
await sleep(300);
await page.screenshot({ path: `${OUT}/ui-final.png` });
const stats = await page.$eval('#stats', (e) => e.textContent);
check('stats overlay', /fps/.test(stats), stats);
check('no console errors/warnings', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
