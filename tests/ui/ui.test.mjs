// Drives the real editor UI in headless Chromium (WebGPU) against a Vite dev
// server and checks editor state after each interaction. Screenshots go to
// tests/.out/. Run via `npm run test:ui` (see tests/ui/run.mjs).
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

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
await page.click('.add-menu summary');
await page.click('[data-action="add-cube"]');
await sleep(100);
check('Add > Cube creates and selects', (await state(() => window.editor.selected?.name)) === 'Cube');
check('hierarchy lists new cube', (await page.$$eval('.tree-name', (els) => els.map((e) => e.textContent))).includes('Cube'));
check('menu closed after choice', (await page.$('details.menu[open]')) === null);

// --- Rigid body component: add via inspector, undo/redo
await page.click('#inspector .add-rigidbody');
await sleep(50);
check('add rigid body', (await state(() => window.editor.selected.rigidBody?.type)) === 'dynamic' && (await page.$eval('#inspector', (e) => e.innerText.includes('Mass'))));
await sleep(100);
await page.screenshot({ path: `${OUT}/ui-rigidbody.png` });
await page.$eval('#gpu-canvas', (e) => e.focus());
await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
check('undo add rigid body', (await state(() => window.editor.selected.rigidBody)) === null);
await page.keyboard.down('Control');
await page.keyboard.press('KeyY');
await page.keyboard.up('Control');
check('redo add rigid body', (await state(() => !!window.editor.selected.rigidBody)));
await state(() => { window.editor.selected.transform.position[1] = 3; });

// --- Scripts: create from the inspector, edit in the Scripts tab, attach
await page.click('.add-menu summary');
await page.click('[data-action="add-empty"]');
await sleep(50);
await page.select('#inspector select.add-behaviour', 'new-script');
await sleep(300);
const scriptState = () =>
  state(() => {
    const ed = window.editor;
    const s = ed.scripts.current;
    return { view: ed.view, name: s?.name, ok: !!s && s.diagnostics.length === 0, defaults: s?.defaults, status: document.querySelector('.script-status')?.textContent, badge: document.querySelector('.tab-badge')?.textContent };
  });
let ss = await scriptState();
check('new script opens Scripts tab', ss.view === 'scripts' && ss.name === 'EmptyScript' && (await state(() => document.querySelector('.view-tab.active')?.dataset.action)) === 'view-scripts', JSON.stringify(ss));
check('script template compiles', ss.ok && ss.status.includes('Compiled'), ss.status);
/** Puts the caret at the end of the first line containing `text`. */
const caretAfter = (text) =>
  page.evaluate((text) => {
    const ta = document.querySelector('.code-input');
    ta.focus();
    const i = ta.value.indexOf('\n', ta.value.indexOf(text));
    ta.setSelectionRange(i, i);
  }, text);
const lineOf = (text) => state(() => document.querySelector('.code-input').value).then((v) => v.split('\n').find((l) => l.includes(text)));
await caretAfter('speed = 90;');
await page.keyboard.press('Enter');
await page.keyboard.type('rise = 2;');
await caretAfter('update(dt: number, time: number): void {');
await page.keyboard.press('Enter');
await page.keyboard.type('this.object.transform.position[1] = time * this.rise;');
check('editor auto-indents', (await lineOf('rise = 2;')) === '  rise = 2;' && (await lineOf('time * this.rise')) === '    this.object.transform.position[1] = time * this.rise;', JSON.stringify(await lineOf('time * this.rise')));
await caretAfter('rise = 2;');
await page.keyboard.down('Control');
await page.keyboard.press('Slash');
await page.keyboard.up('Control');
const commented = await lineOf('rise = 2;');
await page.keyboard.down('Control');
await page.keyboard.press('Slash');
await page.keyboard.up('Control');
check('Ctrl+/ toggles comment', commented === '  // rise = 2;' && (await lineOf('rise = 2;')) === '  rise = 2;', commented);
await sleep(600);
ss = await scriptState();
check('edits compile live', ss.ok && JSON.stringify(ss.defaults) === '{"speed":90,"rise":2}', JSON.stringify(ss.defaults));
// A syntax error marks the line; the textarea's own undo (kept by execCommand) fixes it.
await caretAfter('rise = 2;');
await page.keyboard.type(')');
await sleep(600);
ss = await scriptState();
const errLine = await state(() => document.querySelector('.code-gutter .ln-error')?.textContent);
const riseLine = await state(() => document.querySelector('.code-input').value.split('\n').findIndex((l) => l.includes('rise = 2;')) + 1);
check('syntax error is marked', !ss.ok && ss.status.startsWith('✗') && ss.badge === '1' && errLine === String(riseLine), `${ss.status} gutter=${errLine} expected=${riseLine}`);
await page.screenshot({ path: `${OUT}/ui-scripts-error.png` });
await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
await sleep(600);
ss = await scriptState();
check('undo in code editor', ss.ok && ss.badge === '' && (await lineOf('rise = 2;')) === '  rise = 2;', ss.status);
await page.screenshot({ path: `${OUT}/ui-scripts.png` });
await page.keyboard.down('Control');
await page.keyboard.press('KeyE');
await page.keyboard.up('Control');
await sleep(100);
const inspectorScript = await page.$eval('#inspector', (e) => e.innerText);
check('Ctrl+E back to scene, script in inspector', (await state(() => window.editor.view)) === 'scene' && inspectorScript.includes('EmptyScript.ts') && inspectorScript.includes('rise'), inspectorScript.slice(-200));

// --- Add light, change type in inspector
await page.click('.add-menu summary');
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
check('duplicate', (await state(() => window.editor.selected?.name)) === 'Point Light (1)');
await page.keyboard.press('Delete');
check('delete', (await state(() => !window.engine.scene.findByName('Point Light (1)'))));
await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
check('undo delete', (await state(() => !!window.engine.scene.findByName('Point Light (1)'))));

// --- Play mode runs behaviours and restores on stop
const rot0 = await state(() => [...window.engine.scene.findByName('Spinning Cube').transform.rotation]);
await page.click('[data-action="play"]');
await sleep(800);
const rot1 = await state(() => [...window.engine.scene.findByName('Spinning Cube').transform.rotation]);
check('play animates behaviours', rot0.some((v, i) => Math.abs(v - rot1[i]) > 1e-3));
const fallen = await state(() => window.engine.scene.findByName('Cube').transform.position[1]);
check('play simulates rigid bodies', Math.abs(fallen - 0.5) < 0.05, `y=${fallen.toFixed(3)}`);
await page.screenshot({ path: `${OUT}/ui-playing.png` });
check('play runs scripts', (await state(() => window.engine.scene.findByName('Empty').transform.position[1])) > 0.5);
check('play looks through the scene camera', (await state(() => window.engine.viewObject?.name)) === 'Main Camera');
await page.click('[data-action="play"]');
await sleep(50);
check('stop returns to the editor camera', (await state(() => window.engine.viewObject)) === null);
const rot2 = await state(() => [...window.engine.scene.findByName('Spinning Cube').transform.rotation]);
check('stop restores transforms', rot0.every((v, i) => Math.abs(v - rot2[i]) < 1e-6));
check('stop restores rigid body pose', (await state(() => window.engine.scene.findByName('Cube').transform.position[1])) === 3);
check('stop restores scripted object', (await state(() => window.engine.scene.findByName('Empty').transform.position[1])) === 0);

// --- Play runs a copy: objects destroyed or created during Play come back / go away on Stop
await page.click('[data-action="play"]');
await sleep(100);
const duringPlay = await state(() => {
  const { engine } = window;
  const GO = engine.scene.root.constructor;
  GO.destroy(engine.scene.findByName('Torus'));
  GO.instantiate(engine.scene.findByName('Ball')).name = 'Spawned';
  return { editing: window.editor.scene === engine.scene };
});
await sleep(100);
const midPlay = await state(() => [!!window.engine.scene.findByName('Torus'), !!window.engine.scene.findByName('Spawned')]);
await page.click('[data-action="play"]');
await sleep(50);
const afterStop = await state(() => [!!window.engine.scene.findByName('Torus'), !!window.engine.scene.findByName('Spawned')]);
check('play runs on a copy that stop discards', duringPlay.editing && midPlay.join() === 'false,true' && afterStop.join() === 'true,false', JSON.stringify({ midPlay, afterStop }));

// --- Script runtime error: reported with its source line, behaviour paused, nothing on the console
await state(() => {
  const ed = window.editor;
  const s = ed.engine.scene.scripts.get('EmptyScript');
  s.source = s.source.replace('this.object.transform.position[1] = time * this.rise;', "if (time > 0.1) throw new Error('kaboom');");
  ed.compileScript(s);
});
await page.click('[data-action="play"]');
await sleep(500);
const rt = await state(() => {
  const s = window.engine.scene.scripts.get('EmptyScript');
  const d = s.diagnostics.find((x) => x.kind === 'runtime');
  const line = s.source.split('\n').findIndex((l) => l.includes('kaboom')) + 1;
  return { msg: d?.message, line: d?.line, expected: line, toast: [...document.querySelectorAll('.toast-error')].some((t) => t.textContent.includes('kaboom')) };
});
check('script runtime error reported', rt.msg === 'Error: kaboom' && rt.line === rt.expected && rt.toast, JSON.stringify(rt));
await page.click('[data-action="play"]');
await sleep(50);
check('play clears old runtime errors', await (async () => {
  await page.click('[data-action="play"]');
  await sleep(50);
  const fresh = await state(() => window.engine.scene.scripts.get('EmptyScript').diagnostics.length === 0);
  await page.click('[data-action="play"]');
  await sleep(50);
  return fresh;
})());

// --- Delete a script (detaches it) and undo from the Scripts tab
await page.click('[data-action="view-scripts"]');
await sleep(100);
await page.evaluate(() => [...document.querySelectorAll('.script-row')].find((r) => r.textContent.includes('EmptyScript'))?.click());
await sleep(50);
await page.click('.delete-script');
await sleep(50);
const afterDelete = await state(() => [!window.engine.scene.scripts.get('EmptyScript'), window.engine.scene.findByName('Empty').behaviours.length]);
await page.$eval('.script-list', (e) => e.focus());
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
await sleep(50);
const afterUndo = await state(() => [!!window.engine.scene.scripts.get('EmptyScript'), window.engine.scene.findByName('Empty').behaviours.length]);
check('delete script detaches, undo restores', afterDelete[0] && afterDelete[1] === 0 && afterUndo[0] && afterUndo[1] === 1, JSON.stringify([afterDelete, afterUndo]));
await page.click('[data-action="view-scene"]');
await sleep(50);
/** The autosaved project manifest from IndexedDB (written about a second after a change). */
const autosaved = () =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('messier');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction('kv').objectStore('kv').get('autosave');
          get.onsuccess = () => resolve(get.result ? JSON.parse(get.result.json) : null);
          get.onerror = () => reject(get.error);
        };
      }),
  );
await sleep(1500);
check('scripts autosave', (await autosaved())?.scripts.map((x) => x.name).join() === 'Hover,Carousel,LapFlash,EmptyScript');

// --- Keyboard input: during Play, keys drive scripts instead of editor shortcuts; Esc stops
await state(() => {
  const ed = window.editor;
  const s = ed.createScript('Walker', `import { Script, input } from 'messier';
export default class Walker extends Script {
  speed = 2;
  update(dt: number): void {
    const p = this.object.transform.position;
    this.object.transform.position = [p[0] + input.axis('horizontal') * this.speed * dt, p[1], p[2]];
  }
}
`);
  ed.compileScript(s);
  const o = ed.engine.scene.findByName('Empty');
  ed.addBehaviour(o, s.create());
  ed.setMode('translate');
});
await page.click('[data-action="play"]');
await sleep(50);
const focused = await state(() => document.activeElement?.id);
const x0 = await state(() => window.engine.scene.findByName('Empty').transform.position[0]);
await page.keyboard.down('KeyD');
await page.keyboard.press('KeyE'); // would switch the gizmo to rotate outside Play
await sleep(400);
await page.keyboard.up('KeyD');
await sleep(50);
const emptyX = () => state(() => window.engine.scene.findByName('Empty').transform.position[0]);
const walk = { x: await emptyX(), mode: await state(() => window.editor.gizmo.mode) };
await sleep(150);
walk.stopped = (await emptyX()) === walk.x; // the key was released
check('play gives the viewport focus', focused === 'gpu-canvas', String(focused));
check('keys drive scripts during play', walk.x - x0 > 0.3 && walk.stopped, JSON.stringify({ x0, ...walk }));
check('editor shortcuts off during play', walk.mode === 'translate', walk.mode);
await page.keyboard.press('Escape');
await sleep(50);
check('Esc stops play', (await state(() => !window.engine.playing)) && (await emptyX()) === x0);
await page.keyboard.press('KeyE');
check('shortcuts back after stop', (await state(() => window.editor.gizmo.mode)) === 'rotate');
await page.keyboard.press('KeyW');

// --- Cameras: add, align to view, look through (C), viewport ignores clicks meanwhile, pick by icon
await page.click('.add-menu summary');
await page.click('[data-action="add-camera"]');
await sleep(100);
const added = await state(() => ({ name: window.editor.selected?.name, camera: !!window.editor.selected?.camera, text: document.getElementById('inspector').innerText }));
check('Add > Camera creates and selects', added.name === 'Camera' && added.camera && added.text.includes('Field of view') && added.text.includes('Main Camera is the active camera'), added.name);
await page.click('#inspector .align-camera');
const alignErr = await state(() => {
  const ed = window.editor;
  const p = ed.selected.worldPosition(), f = ed.selected.forward(), c = ed.camera.position, cf = ed.camera.forward();
  return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) + Math.hypot(f[0] - cf[0], f[1] - cf[1], f[2] - cf[2]);
});
check('align camera to view', alignErr < 1e-4, alignErr.toExponential(2));
await state(() => { window.editor.selected.camera.priority = 1; window.editor.selected.camera.fovDeg = 30; });
await page.$eval('#gpu-canvas', (e) => e.focus());
await page.keyboard.press('KeyC');
await sleep(150);
check('C looks through the active camera', (await state(() => window.engine.viewObject?.name)) === 'Camera');
await page.screenshot({ path: `${OUT}/ui-camera-view.png` });
const editorCam0 = await state(() => [...window.engine.camera.position]);
const box = await page.$eval('#gpu-canvas', (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
await page.mouse.move(box[0], box[1]);
await page.mouse.down();
await page.mouse.move(box[0] + 80, box[1] + 30, { steps: 5 });
await page.mouse.up();
const editorCam1 = await state(() => [...window.engine.camera.position]);
check('camera view ignores viewport drags', editorCam0.every((v, i) => v === editorCam1[i]) && (await state(() => window.editor.selected?.name)) === 'Camera');
await page.keyboard.press('KeyC');
await sleep(50);
check('C returns to the editor camera', (await state(() => window.engine.viewObject)) === null);
await page.keyboard.press('Delete');
// Frame the Main Camera (it's off-screen in the default view), deselect, then click its icon.
await state(() => { const ed = window.editor; ed.select(ed.engine.scene.findByName('Main Camera')); ed.focusSelected(); });
await sleep(800);
await state(() => window.editor.select(null));
const [mcx, mcy] = await screenOf(`(() => {
  const o = engine.scene.findByName('Main Camera'); const p = o.worldPosition();
  const d = engine.overlay.pixelSize(p) * 34 * 0.5; const f = o.forward();
  return [p[0] + f[0] * d, p[1] + f[1] * d, p[2] + f[2] * d];
})()`);
await page.mouse.click(mcx, mcy);
await sleep(50);
check('click camera icon selects camera', (await state(() => window.editor.selected?.name)) === 'Main Camera');
await sleep(100);
await page.screenshot({ path: `${OUT}/ui-camera-helper.png` });
await page.keyboard.press('Escape');
await state(() => { window.editor.camera.position = [7, 5, 9]; window.editor.camera.target = [0, 0.5, 0]; window.editor.controls.syncFromCamera(); });

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
// --- Projects: autosave survives a reload, scenes, Save (download fallback) and Open
page.on('dialog', (d) => void d.accept()); // "Discard unsaved changes?"
await state(() => {
  window.engine.scene.findByName('Torus').transform.position[0] = 7.25;
});
await sleep(1500);
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.editor?.project.sceneId && window.engine.scene.findByName('Torus'), { timeout: 15000 });
await sleep(300);
const restored = await state(() => {
  const { engine, editor } = window;
  let lanternMeshes = 0;
  engine.scene.findByName('Lantern')?.traverse((o) => void (o.mesh && lanternMeshes++));
  return { x: engine.scene.findByName('Torus').transform.position[0], lanternMeshes, scripts: engine.scene.scripts.scripts.map((s) => s.name).join(), name: editor.project.project.name };
});
check('autosave restores after reload', restored.x === 7.25 && restored.lanternMeshes === 4 && restored.scripts === 'Hover,Carousel,LapFlash,EmptyScript,Walker' && restored.name === 'Demo', JSON.stringify(restored));
await page.screenshot({ path: `${OUT}/ui-restored.png` });

const firstScene = await state(() => window.editor.project.sceneId);
await page.click('.file-menu summary');
await page.click('[data-action="new-scene"]');
await sleep(300);
const fresh = await state(() => ({
  options: document.querySelectorAll('.scene-select option').length,
  objects: window.engine.scene.root.children.map((o) => o.name).join(),
  canUndo: window.editor.history.canUndo,
}));
check('new scene', fresh.options === 2 && fresh.objects === 'Sun,Main Camera' && !fresh.canUndo, JSON.stringify(fresh));
await page.select('.scene-select', firstScene);
await sleep(300);
check('switch back to first scene', (await state(() => window.engine.scene.findByName('Torus')?.transform.position[0])) === 7.25);

// Save during Play: stops Play first and saves the edit-time scene. Headless has no file picker here, so Save downloads.
await state(() => {
  Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  window.__downloads = [];
  HTMLAnchorElement.prototype.click = function () {
    window.__downloads.push({ href: this.href, name: this.download });
  };
});
const rotBefore = await state(() => [...window.engine.scene.findByName('Spinning Cube').transform.rotation]);
await page.evaluate(() => document.getElementById('gpu-canvas').focus());
await page.keyboard.press('KeyP');
await sleep(400);
await page.keyboard.down('Control');
await page.keyboard.press('KeyS');
await page.keyboard.up('Control');
await sleep(300);
const saved = await state(async () => {
  const { editor, engine } = window;
  const dl = window.__downloads[0];
  if (!dl) return null;
  const bytes = new Uint8Array(await (await fetch(dl.href)).arrayBuffer());
  const project = editor.project.project.constructor.decode(bytes);
  const scene = project.getScene(editor.project.sceneId).data;
  return {
    name: dl.name,
    playing: engine.playing,
    dirty: editor.project.dirty,
    scenes: project.scenes.length,
    rot: scene.objects.find((o) => o.name === 'Spinning Cube').rotation,
    bytes: Array.from(bytes),
  };
});
check('Ctrl+S during Play stops and saves', saved && saved.name === 'Demo.messier' && !saved.playing && !saved.dirty && saved.scenes === 2 &&
  saved.rot.every((v, i) => Math.abs(v - rotBefore[i]) < 1e-6), JSON.stringify(saved && { ...saved, bytes: saved.bytes.length }));

if (saved) {
  const file = `${OUT}/ui-test.messier`;
  writeFileSync(file, Buffer.from(saved.bytes));
  await state(() => {
    window.editor.project.renameProject('Changed');
    window.engine.scene.findByName('Torus').transform.position[0] = 0;
  });
  const input = await page.$('#import-input');
  await input.uploadFile(file);
  await page.waitForFunction(() => window.editor.project.project.name === 'Demo', { timeout: 10000 }).catch(() => {});
  await sleep(300);
  const opened = await state(() => ({
    name: window.editor.project.project.name,
    scenes: window.editor.project.project.scenes.length,
    x: window.engine.scene.findByName('Torus')?.transform.position[0],
    dirty: window.editor.project.dirty,
  }));
  check('open project file', opened.name === 'Demo' && opened.scenes === 2 && opened.x === 7.25 && !opened.dirty, JSON.stringify(opened));
}

check('no console errors/warnings', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
