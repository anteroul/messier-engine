// Drives the real editor UI in headless Chromium (WebGPU) against a Vite dev
// server and checks editor state after each interaction. Screenshots go to
// tests/.out/. Run via `npm run test:ui` (see tests/ui/run.mjs).
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const OUT = process.env.OUT_DIR;
const URL = process.env.APP_URL;
let failures = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Files of a .zip (stored or deflated entries), by name. */
function unzip(buf) {
  const files = {};
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  let at = buf.readUInt32LE(end + 16);
  for (let i = buf.readUInt16LE(end + 10); i > 0; i--) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = method === 8 ? inflateRawSync(data) : data;
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return files;
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--window-size=1400,820',
    // Puppeteer's input events count as user gestures, but don't depend on that for sound.
    '--autoplay-policy=no-user-gesture-required'],
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
// The caret lives in the transparent textarea, so the highlight underneath must use the exact same font.
const fonts = await state(() => [document.querySelector('.code-input'), document.querySelector('.code-highlight code')].map((e) => getComputedStyle(e).font));
check('code highlight font matches textarea', fonts[0] === fonts[1], JSON.stringify(fonts));
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

// --- Hierarchy multi-selection and context menu
// Rows are rebuilt whenever the hierarchy changes, so find the row and its position right before each click.
const rowClick = async (name, opts = {}) => {
  const [x, y] = await page.evaluate((n) => {
    const r = [...document.querySelectorAll('.tree-row')].find((e) => e.querySelector('.tree-name').textContent === n);
    r.scrollIntoView({ block: 'nearest' });
    const b = r.getBoundingClientRect();
    return [b.left + 40, b.top + b.height / 2];
  }, name);
  if (opts.mod) await page.keyboard.down(opts.mod);
  await page.mouse.click(x, y, { button: opts.button ?? 'left' });
  if (opts.mod) await page.keyboard.up(opts.mod);
  await sleep(30);
};
const selNames = () => state(() => window.editor.selection.items.map((o) => o.name));
const menuItem = (label) => page.evaluateHandle((l) => [...document.querySelectorAll('.context-menu-item')].find((i) => i.querySelector('.context-menu-label').textContent === l), label);
const menuOpen = () => state(() => document.querySelectorAll('.context-menu').length);
const combo = async (key, ...mods) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of mods.reverse()) await page.keyboard.up(m);
  await sleep(30);
};

await rowClick('Gold Sphere');
await rowClick('Torus', { mod: 'Control' });
check('ctrl+click adds to the selection', JSON.stringify(await selNames()) === '["Gold Sphere","Torus"]');
await rowClick('Floor');
await rowClick('Gold Sphere', { mod: 'Shift' });
check('shift+click selects a range', JSON.stringify(await selNames()) === '["Floor","Spinning Cube","Gold Sphere"]', JSON.stringify(await selNames()));
await rowClick('Spinning Cube', { button: 'right' });
check('right-click on a selected item keeps the multi-selection', (await menuOpen()) === 1 && (await selNames()).length === 3);
const menuState = await state(() => [...document.querySelectorAll('.context-menu-item')].map((i) => `${i.textContent}${i.getAttribute('aria-disabled') ? '!' : ''}`));
check('menu shows shortcuts and disables what does not apply', menuState.includes('UndoCtrl+Z') && menuState.includes('PasteCtrl+V!') && menuState.includes('✓Visible'), menuState.join(' | '));
await page.keyboard.press('Escape');
await sleep(30);
check('Esc closes the menu', (await menuOpen()) === 0);

await rowClick('Plastic Sphere', { button: 'right' });
check('right-click on an unselected item selects only it', JSON.stringify(await selNames()) === '["Plastic Sphere"]');
await (await menuItem('Duplicate')).click();
await sleep(30);
check('menu Duplicate', (await menuOpen()) === 0 && JSON.stringify(await selNames()) === '["Plastic Sphere (1)"]');
await combo('KeyZ', 'Control');
check('undo duplicate', (await state(() => !window.engine.scene.findByName('Plastic Sphere (1)'))) && JSON.stringify(await selNames()) === '["Plastic Sphere"]');

// Shortcuts while the hierarchy has focus (no menu): copy two objects, paste, undo.
await rowClick('Gold Sphere');
await rowClick('Torus', { mod: 'Control' });
await combo('KeyC', 'Control');
await combo('KeyV', 'Control');
check('ctrl+c / ctrl+v in the hierarchy', JSON.stringify(await selNames()) === '["Gold Sphere (1)","Torus (1)"]', JSON.stringify(await selNames()));
await combo('KeyZ', 'Control');
check('paste undoes in one step', (await state(() => !window.engine.scene.findByName('Gold Sphere (1)') && !window.engine.scene.findByName('Torus (1)'))));

// Visible toggle with a mixed selection shows all; one undo restores both.
await state(() => { window.engine.scene.findByName('Torus').visible = false; });
await rowClick('Gold Sphere', { button: 'right' });
check('mixed visibility shows an indeterminate mark', (await state(() => [...document.querySelectorAll('.context-menu-item')].find((i) => i.textContent.includes('Visible')).getAttribute('aria-checked'))) === 'mixed');
await (await menuItem('Visible')).click();
await sleep(30);
check('Visible on a mixed selection shows all', (await state(() => window.engine.scene.findByName('Torus').visible && window.engine.scene.findByName('Gold Sphere').visible)));
await combo('KeyZ', 'Control');
check('undo visibility', (await state(() => !window.engine.scene.findByName('Torus').visible && window.engine.scene.findByName('Gold Sphere').visible)));
await state(() => { window.engine.scene.findByName('Torus').visible = true; });

// Create over empty space (root) and keyboard navigation into the submenu.
const empty = await page.$eval('#hierarchy', (e) => { e.scrollTop = e.scrollHeight; const r = e.getBoundingClientRect(); return [r.left + 60, r.bottom - 12]; });
await sleep(30);
await page.mouse.click(empty[0], empty[1], { button: 'right' });
await sleep(30);
check('right-click on empty space opens the menu', (await menuOpen()) === 1);
// Walk down to Create; every stop must be an enabled item (disabled ones like Paste are skipped).
const visited = [];
let menuFocus = '';
for (let i = 0; i < 6 && menuFocus !== 'Create'; i++) {
  await page.keyboard.press('ArrowDown');
  const f = await state(() => ({ label: document.activeElement?.querySelector('.context-menu-label')?.textContent, disabled: document.activeElement?.getAttribute('aria-disabled') === 'true' }));
  visited.push(f);
  menuFocus = f.label;
}
check('arrow keys never stop on disabled items', visited.every((v) => !v.disabled), JSON.stringify(visited));
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter'); // Empty
await sleep(30);
check('keyboard: arrows skip disabled items, Right opens Create, Enter picks Empty', menuFocus === 'Create' && (await state(() => window.editor.selected?.name === 'Empty' && window.editor.selected.parent === window.engine.scene.root)), String(menuFocus));
await combo('KeyZ', 'Control');

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
// The demo's own scripts, then those of its game scenes.
const DEMO_SCRIPTS = 'Hover,Carousel,LapFlash,Arcade,ArcadeLink,NeonRun,Topple,Starfall,GameManager,PlayerBall,FollowCamera,GemSpawner,Gem,Spark,Sentinel,ScorePips,ScoreHud';
check('scripts autosave', (await autosaved())?.scripts.map((x) => x.name).join() === `${DEMO_SCRIPTS},EmptyScript`);

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
// --- 2D: world-space text and shapes, a HUD label edited in the inspector and dragged in the viewport
await page.keyboard.press('Escape');
await page.click('.add-menu summary');
await page.click('[data-action="add-ellipse"]');
await sleep(50);
await page.click('.add-menu summary');
await page.click('[data-action="add-text"]');
await sleep(50);
const worldText = await state(() => {
  const o = window.editor.selected;
  const t = o.components.find((c) => 'fontSize' in c);
  const [x0, , x1] = t.localBounds();
  return { name: o.name, space: t.space, sized: x1 - x0 > 0.3 };
});
check('Add > Text creates world-space text', worldText.name === 'Text' && worldText.space === 'world' && worldText.sized, JSON.stringify(worldText));
await page.click('.add-menu summary');
await page.click('[data-action="add-screen-text"]');
await sleep(50);
const hudPanel = await page.$eval('#inspector', (e) => e.innerText);
check('Add > Screen Text shows the Text 2D inspector', hudPanel.includes('Text 2D') && hudPanel.includes('Anchor') && hudPanel.includes('Outline width'));
await page.focus('#inspector textarea');
await page.keyboard.down('Control');
await page.keyboard.press('KeyA');
await page.keyboard.up('Control');
await page.keyboard.type('Score 42');
await page.keyboard.press('Enter');
await page.keyboard.type('Lives 3');
const hudText = await state(() => window.editor.selected.components.find((c) => 'fontSize' in c).text);
check('inspector edits text live (multi-line)', hudText === 'Score 42\nLives 3', JSON.stringify(hudText));
await page.$eval('#inspector textarea', (e) => e.blur());
await sleep(100);
const canvasBox = await state(() => {
  const r = document.getElementById('gpu-canvas').getBoundingClientRect();
  return [r.left, r.top];
});
// The label's top-left corner is 16 px in from the viewport's; grab it inside the first line.
await page.mouse.move(canvasBox[0] + 40, canvasBox[1] + 30);
await page.mouse.down();
await page.mouse.move(canvasBox[0] + 70, canvasBox[1] + 50, { steps: 4 });
await page.mouse.move(canvasBox[0] + 100, canvasBox[1] + 70, { steps: 4 });
await page.mouse.up();
const dragged = await state(() => [...window.editor.selected.transform.position]);
check('drag moves a selected HUD element in pixels', dragged[0] === 76 && dragged[1] === -56, dragged.join(','));
await page.$eval('#gpu-canvas', (e) => e.focus());
await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
check('undo HUD drag', (await state(() => window.editor.selected.transform.position.join())) === '16,-16,0');
await page.keyboard.press('Escape');
await page.mouse.click(canvasBox[0] + 40, canvasBox[1] + 30);
await sleep(50);
check('click picks HUD text', (await state(() => window.editor.selected?.name)) === 'Screen Text');
await sleep(150);
await page.screenshot({ path: `${OUT}/ui-2d.png` });
const atlasUsed = await state(() => window.engine.renderer.stats.elements2D >= 5);
check('2D elements render (sign, title, ellipse, text, HUD)', atlasUsed);

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
check('autosave restores after reload', restored.x === 7.25 && restored.lanternMeshes === 4 && restored.scripts === `${DEMO_SCRIPTS},EmptyScript,Walker` && restored.name === 'Demo', JSON.stringify(restored));
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
check('new scene', fresh.options === 7 && fresh.objects === 'Sun,Main Camera' && !fresh.canUndo, JSON.stringify(fresh));

// --- The Gem Rush demo game plays in the editor: keys roll the ball, gems spawn, no script errors
const gemRush = await state(() => window.editor.project.project.scenes.find((s) => s.name === 'Gem Rush')?.id);
await page.select('.scene-select', gemRush);
await sleep(300);
await page.evaluate(() => document.getElementById('gpu-canvas').focus());
await page.keyboard.press('KeyP');
await page.keyboard.down('KeyW');
await sleep(1500);
await page.keyboard.up('KeyW');
const gameNames = DEMO_SCRIPTS.split(',').slice(3);
const game = await page.evaluate((names) => ({
  playing: window.engine.playing,
  gems: window.engine.scene.getGroup('gems').length,
  z: window.engine.scene.findByName('Player').transform.position[2],
  errors: window.engine.scene.scripts.scripts.filter((s) => names.includes(s.name)).flatMap((s) => s.diagnostics.map((d) => `${s.name}:${d.line} ${d.message}`)),
}), gameNames);
await page.screenshot({ path: `${OUT}/ui-gem-rush.png` });
await page.keyboard.press('Escape');
await sleep(200);
check('Gem Rush plays', game.playing && game.gems > 0 && game.z < 4.5 && game.errors.length === 0, JSON.stringify(game));

// --- The showcase games play too. Look at their screenshots after changing them.
const sceneId = (name) => page.evaluate((n) => window.editor.project.project.scenes.find((s) => s.name === n)?.id, name);
const scriptErrors = () => page.evaluate((names) => window.engine.scene.scripts.scripts.filter((s) => names.includes(s.name))
  .flatMap((s) => s.diagnostics.map((d) => `${s.name}:${d.line} ${d.message}`)), gameNames);
for (const [name, object, key] of [['Neon Run', 'Ship', 'KeyD'], ['Topple', 'Turret', 'Space'], ['Starfall', 'Ship', 'Space']]) {
  await page.select('.scene-select', await sceneId(name));
  await sleep(300);
  await page.evaluate(() => document.getElementById('gpu-canvas').focus());
  await page.keyboard.press('KeyP');
  await sleep(600);
  await page.keyboard.down(key);
  await sleep(900);
  await page.keyboard.up(key);
  await sleep(1200);
  const played = await page.evaluate((o) => ({
    playing: window.engine.playing, found: !!window.engine.scene.findByName(o), camera: window.engine.viewObject?.name, sounds: window.audio.activeVoices,
  }), object);
  const errors = await scriptErrors();
  await page.screenshot({ path: `${OUT}/ui-${name.toLowerCase().replace(' ', '-')}.png` });
  await page.keyboard.press('Escape');
  await sleep(200);
  check(`${name} plays`, played.playing && played.found && !!played.camera && errors.length === 0, JSON.stringify({ played, errors }));
  // Neon Run's engine drones all the time; the other two make sounds when firing, a moment ago.
  if (name === 'Neon Run') check('Neon Run is heard', played.sounds > 0, JSON.stringify(played));
}
check('Stop silences the game', (await state(() => window.audio.activeVoices)) === 0);

// The Arcade menu starts the chosen game through sceneManager, and Backspace in a game comes back.
await page.select('.scene-select', await sceneId('Arcade'));
await sleep(300);
await page.evaluate(() => document.getElementById('gpu-canvas').focus());
await page.keyboard.press('KeyP');
await sleep(500);
await page.keyboard.press('ArrowRight');
await sleep(1200);
await page.screenshot({ path: `${OUT}/ui-arcade.png` });
const menu = await state(() => window.engine.scene.findByName('Status')?.components.find((c) => 'text' in c)?.text);
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.engine.scene.findByName('Turret'), { timeout: 5000 }).catch(() => {});
const launched = await state(() => ({ playing: window.engine.playing, topple: !!window.engine.scene.findByName('Turret') }));
await page.keyboard.press('Backspace');
await page.waitForFunction(() => window.engine.scene.findByName('Stands'), { timeout: 5000 }).catch(() => {});
await sleep(300);
const back = await state(() => ({ playing: window.engine.playing, arcade: !!window.engine.scene.findByName('Stands') }));
const arcadeErrors = await scriptErrors();
await page.keyboard.press('Escape');
await sleep(200);
check('Arcade starts the chosen game', menu === 'Enter: play Topple' && launched.playing && launched.topple, JSON.stringify({ menu, launched }));
check('Backspace returns to the Arcade', back.playing && back.arcade && arcadeErrors.length === 0, JSON.stringify({ back, arcadeErrors }));
check('Stop returns to the edited scene', (await state(() => !window.engine.playing && window.editor.project.currentScene.name)) === 'Arcade');
await page.select('.scene-select', firstScene);
await sleep(300);
check('switch back to first scene', (await state(() => window.engine.scene.findByName('Torus')?.transform.position[0])) === 7.25);

// --- Sound files import as project assets, with an object playing them
{
  const rate = 8000, n = 800;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + n * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), 44 + i * 2);
  const file = `${OUT}/beep.wav`;
  writeFileSync(file, wav);
  const input = await page.$('#import-input');
  await input.uploadFile(file);
  await page.waitForFunction(() => window.engine.scene.findByName('beep'), { timeout: 5000 }).catch(() => {});
  await sleep(200);
  const imported = await state(() => {
    const obj = window.engine.scene.findByName('beep');
    const src = obj?.components.find((c) => 'playOnStart' in c);
    return {
      duration: src?.clip?.duration,
      ref: src?.clip?.ref,
      assets: window.editor.project.audioAssets().map((a) => a.name),
      selected: window.editor.selected?.name,
    };
  });
  check('import a sound file', Math.abs(imported.duration - 0.1) < 0.01 && imported.ref?.asset && imported.assets.join() === 'beep' && imported.selected === 'beep',
    JSON.stringify(imported));
  await page.click('.audio-preview');
  await sleep(50);
  check('inspector previews the sound', (await state(() => window.audio.activeVoices)) > 0);
  await page.select('.audio-clip', 'synth:laser');
  await sleep(50);
  check('clip picker switches to a synthesized sound', (await state(() => window.engine.scene.findByName('beep').components.find((c) => 'playOnStart' in c).clip.sfx?.wave)) === 'saw');
  await page.click('.audio-vary');
  await sleep(50);
  check('Vary makes a variation', (await state(() => window.engine.scene.findByName('beep').components.find((c) => 'playOnStart' in c).clip.sfx?.frequency)) !== 1500);
  await page.screenshot({ path: `${OUT}/ui-audio.png` });
  // Back to the imported file, so the saved project below carries it.
  await page.select('.audio-clip', `asset:${imported.ref.asset}`);
  await sleep(50);
}

// --- Sky: a gradient from the inspector, then a dropped 2:1 image becomes the sky (and saves with the project)
{
  await state(() => window.editor.select(null));
  await sleep(100);
  await page.select('.sky-mode', 'gradient');
  await sleep(300);
  const gradient = await state(() => ({ mode: window.engine.scene.sky.mode, rows: document.querySelectorAll('#inspector .section').length }));
  await page.screenshot({ path: `${OUT}/ui-sky-gradient.png` });
  check('inspector switches the sky to a gradient', gradient.mode === 'gradient', JSON.stringify(gradient));
  // A panorama made in the page: blue above the horizon, warm below, a bright band at the horizon.
  await state(async () => {
    const c = new OffscreenCanvas(256, 128);
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, '#1d4fb8');
    grad.addColorStop(0.48, '#f2c48a');
    grad.addColorStop(0.52, '#7a5a3a');
    grad.addColorStop(1, '#2a2018');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 128);
    const blob = await c.convertToBlob({ type: 'image/png' });
    await window.editor.importFiles([new File([blob], 'sunset.png', { type: 'image/png' })]);
  });
  await sleep(400);
  const imageSky = await state(() => ({
    mode: window.engine.scene.sky.mode,
    name: window.engine.scene.sky.texture?.name,
    asset: window.engine.scene.sky.texture?.ref?.asset,
    shown: document.querySelector('.sky-image-name')?.textContent,
  }));
  await page.screenshot({ path: `${OUT}/ui-sky-image.png` });
  check('a dropped panorama becomes the sky', imageSky.mode === 'image' && imageSky.name === 'sunset' && !!imageSky.asset && imageSky.shown === 'sunset',
    JSON.stringify(imageSky));
  // Shortcuts are off while a select has focus.
  await page.evaluate(() => document.getElementById('gpu-canvas').focus());
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyZ');
  await page.keyboard.up('Control');
  await sleep(100);
  check('undo restores the previous sky', (await state(() => window.engine.scene.sky.mode)) === 'gradient');
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyZ');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await sleep(100);
}

// --- Project folders. Headless Chromium has no folder picker, so the picker hands out a folder in the origin-private
// file system: a real FileSystemDirectoryHandle. window.__fs reads and writes it the way a file manager or VS Code would.
await state(async () => {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry('ui-project', { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle('ui-project', { create: true });
  window.showDirectoryPicker = async () => dir;
  const at = async (path, create) => {
    const parts = path.split('/').filter(Boolean);
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create });
    return [d, parts.at(-1)];
  };
  window.__fs = {
    async write(path, data) {
      const [d, name] = await at(path, true);
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(data);
      await w.close();
    },
    async text(path) {
      const [d, name] = await at(path, false);
      return (await (await d.getFileHandle(name)).getFile()).text();
    },
    async list(path) {
      const [d] = await at(`${path}/x`, false);
      const out = [];
      for await (const [n] of d.entries()) out.push(n);
      return out.sort();
    },
    async png(w, h, color) {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      g.fillStyle = color;
      g.fillRect(0, 0, w, h);
      return c.convertToBlob({ type: 'image/png' });
    },
  };
});
const until = (fn, arg) => page.waitForFunction(fn, { timeout: 6000 }, arg).catch(() => {});

// Save during Play: stops Play first and saves the edit-time scene. A project kept in the browser is saved to a folder.
const rotBefore = await state(() => [...window.engine.scene.findByName('Spinning Cube').transform.rotation]);
await page.evaluate(() => document.getElementById('gpu-canvas').focus());
await page.keyboard.press('KeyP');
await sleep(400);
await page.keyboard.down('Control');
await page.keyboard.press('KeyS');
await page.keyboard.up('Control');
await until(() => window.editor.project.folderName === 'ui-project');
const saved = await state(async () => {
  const { editor, engine } = window;
  const main = JSON.parse(await window.__fs.text('scenes/Main.messier'));
  return {
    folder: editor.project.folderName,
    playing: engine.playing,
    dirty: editor.project.dirty,
    scenes: (await window.__fs.list('scenes')).length,
    // The script types (.messier/, tsconfig.json) follow a moment later; checked below.
    top: (await window.__fs.list('')).filter((n) => !n.startsWith('.') && n !== 'tsconfig.json'),
    scene: editor.project.sceneId,
    rot: main.objects.find((o) => o.name === 'Spinning Cube').rotation,
  };
});
// The dev server builds messier.d.ts on the first request, which takes a moment.
await until(async () => (await window.__fs.text('tsconfig.json').catch(() => '')) !== '');
const typeFiles = await state(async () => {
  const types = await window.__fs.text('.messier/messier.d.ts').catch(() => '');
  return { types: types.includes('declare module "messier"'), tsconfig: (await window.__fs.text('tsconfig.json').catch(() => '')).includes('messier.d.ts') };
});
check('a saved project folder gets the script types for code editors', typeFiles.types && typeFiles.tsconfig, JSON.stringify(typeFiles));
check('Ctrl+S during Play stops and saves to a project folder', saved.folder === 'ui-project' && !saved.playing && !saved.dirty && saved.scenes === 7 &&
  saved.top.join() === 'assets,project.json,scenes,scripts' && saved.scene === 'scenes/Main.messier' && saved.rot.every((v, i) => Math.abs(v - rotBefore[i]) < 1e-6),
  JSON.stringify(saved));

// Files put into assets/ from outside show up and load; a changed file reloads where it's used.
await state(async () => window.__fs.write('assets/painted.png', await window.__fs.png(32, 16, '#e04040')));
await until(() => window.editor.project.assets.some((a) => a.path === 'painted.png') && document.querySelector('.asset-row[title^="assets/painted.png"]'));
const painted = await state(() => {
  const a = window.editor.project.assets.find((x) => x.path === 'painted.png');
  const tex = a && window.editor.project.texture(a.id);
  if (tex) window.editor.setTexture(window.engine.scene.findByName('Crate 1'), tex);
  return { id: a?.id, width: tex?.source.width, row: !!document.querySelector('.asset-row[title^="assets/painted.png"]') };
});
check('an image added to assets/ appears and loads', !!painted.id && painted.width === 32 && painted.row, JSON.stringify(painted));
await state(async () => window.__fs.write('assets/painted.png', await window.__fs.png(64, 32, '#40e040')));
await until(() => window.engine.scene.findByName('Crate 1').material.baseColorTexture?.source.width === 64);
const repainted = await state(() => ({
  width: window.engine.scene.findByName('Crate 1').material.baseColorTexture?.source.width,
  sameId: window.editor.project.assets.find((x) => x.path === 'painted.png')?.id,
}));
check('a changed image reloads on the objects using it', repainted.width === 64 && repainted.sameId === painted.id, JSON.stringify(repainted));

// A model with its .mtl, copied in from outside, then dragged from the Assets panel into the viewport.
await state(async () => {
  for (const f of ['icosahedron.obj', 'icosahedron.mtl']) await window.__fs.write(`assets/gem/${f}`, await (await fetch(`models/${f}`)).blob());
});
await until(() => window.editor.project.assets.some((a) => a.path === 'gem/icosahedron.obj'));
const dropped = await state(() => {
  const asset = window.editor.project.assets.find((a) => a.path === 'gem/icosahedron.obj');
  const canvas = document.getElementById('gpu-canvas');
  const r = canvas.getBoundingClientRect();
  const before = window.engine.scene.rootObjects.length;
  const dt = new DataTransfer();
  dt.setData('application/x-messier-asset', asset.id);
  canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: r.left + r.width * 0.3, clientY: r.top + r.height * 0.8, bubbles: true, cancelable: true }));
  return {
    companions: asset.files.map((f) => f.name).join(),
    added: window.engine.scene.rootObjects.length - before,
    selected: window.editor.selected?.name,
    meshes: window.editor.selected ? window.editor.selected.children.filter((c) => c.mesh).length : 0,
  };
});
await sleep(200);
await page.screenshot({ path: `${OUT}/ui-assets.png` });
check('a model added to assets/ can be dragged into the scene', dropped.companions === 'icosahedron.obj,icosahedron.mtl' && dropped.added === 1 &&
  dropped.selected === 'icosahedron' && dropped.meshes > 0, JSON.stringify(dropped));

// Scripts are files: edited on disk they hot-swap; made in the editor they're written.
await state(() => window.__fs.write('scripts/Hover.ts', "import { Script } from 'messier';\nexport default class Hover extends Script {\n  size = 9;\n}\n"));
await until(() => window.engine.scene.scripts.get('Hover')?.defaults.size === 9);
await state(() => window.editor.createScript('FromEditor'));
await until(async () => (await window.__fs.list('scripts')).includes('FromEditor.ts'));
const scriptSync = await state(async () => ({
  hover: window.engine.scene.scripts.get('Hover')?.defaults.size,
  written: (await window.__fs.list('scripts')).includes('FromEditor.ts'),
}));
check('scripts sync with their files both ways', scriptSync.hover === 9 && scriptSync.written, JSON.stringify(scriptSync));
await sleep(1500); // let the scene with the dropped model reach the disk

// Export to Folder writes a copy (script types included) and the editor stays with its project.
const exported = await state(async () => {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry('ui-export', { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle('ui-export', { create: true });
  const picker = window.showDirectoryPicker;
  window.showDirectoryPicker = async () => dir;
  const ok = await window.editor.project.exportToFolder();
  window.showDirectoryPicker = picker;
  const names = [];
  for await (const [n] of dir.entries()) names.push(n);
  const scenes = [];
  for await (const [n] of (await dir.getDirectoryHandle('scenes')).entries()) scenes.push(n);
  const types = await (await (await dir.getDirectoryHandle('.messier')).getFileHandle('messier.d.ts')).getFile();
  return { ok, names: names.sort().join(), scenes: scenes.length, types: types.size > 10000, still: window.editor.project.folderName };
});
check('Export to Folder writes a copy with the script types', exported.ok && exported.names === '.messier,assets,project.json,scenes,scripts,tsconfig.json' &&
  exported.scenes === 7 && exported.types && exported.still === 'ui-project', JSON.stringify(exported));

// The next visit reopens the folder (no prompt: the browser still allows it).
await page.reload({ waitUntil: 'networkidle0' });
await until(() => window.editor?.project.folderName === 'ui-project' && window.engine.scene.findByName('icosahedron'));
const reopened = await state(() => ({
  folder: window.editor.project.folderName,
  model: !!window.engine.scene.findByName('icosahedron'),
  texture: window.engine.scene.findByName('Crate 1')?.material.baseColorTexture?.source.width,
  hover: window.engine.scene.scripts.get('Hover')?.defaults.size,
  rows: document.querySelectorAll('.asset-row').length,
}));
check('a reload reopens the project folder', reopened.folder === 'ui-project' && reopened.model && reopened.texture === 64 && reopened.hover === 9 && reopened.rows >= 5,
  JSON.stringify(reopened));

// Single-file projects from before project folders still open (in the browser).
const opened = await state(async () => {
  const { editor, engine } = window;
  const bytes = editor.project.project.encode();
  await editor.project.openFile(new File([bytes], 'Old.messier'));
  return {
    folder: editor.project.folderName,
    name: editor.project.project.name,
    scenes: editor.project.project.scenes.length,
    x: engine.scene.findByName('Torus')?.transform.position[0],
    beep: engine.scene.findByName('beep')?.components.find((c) => 'playOnStart' in c)?.clip?.duration,
    sky: `${engine.scene.sky.mode}:${engine.scene.sky.texture?.name}`,
  };
});
check('an old single-file project opens', opened.folder === null && opened.name === 'Demo' && opened.scenes === 7 && opened.x === 7.25 &&
  Math.abs(opened.beep - 0.1) < 0.01 && opened.sky === 'image:sunset', JSON.stringify(opened));

// --- Build: the Build Settings dialog picks and orders scenes; the .zip holds a page that plays them
// Downloads are captured instead of saved (set up again here: the reload above cleared it).
await state(() => {
  window.__downloads = [];
  HTMLAnchorElement.prototype.click = function () {
    window.__downloads.push({ href: this.href, name: this.download });
  };
});
await page.evaluate(() => document.getElementById('gpu-canvas').focus());
await page.keyboard.down('Control');
await page.keyboard.down('Shift');
await page.keyboard.press('KeyB');
await page.keyboard.up('Shift');
await page.keyboard.up('Control');
await sleep(100);
const rows = () => page.$$eval('.build-scene', (els) => els.map((e) => `${e.querySelector('.build-name').textContent}:${e.querySelector('.build-index').textContent}`).join());
check('Ctrl+Shift+B opens build settings', (await page.$eval('#build-dialog', (e) => !e.hidden)) && (await rows()) === 'Arcade:0,Neon Run:1,Topple:2,Starfall:3,Gem Rush:4,Main:,Scene 1:5', await rows());
await page.click('.build-scene:nth-child(6) input[type=checkbox]');
await page.click('.build-scene:nth-child(7) input[type=checkbox]');
await page.click('.build-scene:nth-child(6) .build-move-up');
await sleep(50);
check('reorder, include and exclude scenes', (await rows()) === 'Arcade:0,Neon Run:1,Topple:2,Starfall:3,Main:4,Gem Rush:5,Scene 1:', await rows());
await page.screenshot({ path: `${OUT}/ui-build-dialog.png` });
await state(() => (window.__downloads = []));
await page.click('.build-run');
await page.waitForFunction(() => window.__downloads.length > 0, { timeout: 15000 }).catch(() => {});
const built = await state(async () => {
  const dl = window.__downloads[0];
  if (!dl) return null;
  return { name: dl.name, bytes: Array.from(new Uint8Array(await (await fetch(dl.href)).arrayBuffer())) };
});
check('Build downloads a zip', built?.name === 'Demo.zip', built?.name);
const entries = built ? unzip(Buffer.from(built.bytes)) : {};
check('zip holds index.html', Object.keys(entries).join() === 'index.html', Object.keys(entries).join());
await page.keyboard.press('Escape');
check('Esc closes build settings', await page.$eval('#build-dialog', (e) => e.hidden));
await page.click('.btn[data-action="build-settings"]');
check('the toolbar Build button opens build settings', await page.$eval('#build-dialog', (e) => !e.hidden));
await page.keyboard.press('Escape');
check('build settings are saved with the project', (await state(() => window.editor.project.project.manifest().build.scenes.map((s) => s.enabled).join())) === 'true,true,true,true,true,true,false');

if (entries['index.html']) {
  mkdirSync(`${OUT}/game`, { recursive: true });
  writeFileSync(`${OUT}/game/index.html`, entries['index.html']);
  const gamePage = await browser.newPage();
  const gameErrors = [];
  gamePage.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') gameErrors.push(`${m.type()}: ${m.text()}`);
  });
  gamePage.on('pageerror', (e) => gameErrors.push(`pageerror: ${e.message}`));
  await gamePage.goto(`file://${OUT}/game/index.html`);
  await gamePage.waitForFunction(() => window.engine?.playing && window.engine.scene.findByName('Stands'), { timeout: 15000 }).catch(() => {});
  // The build starts in the Arcade. Left from the first stand wraps to the last one, Gem Rush.
  await sleep(500);
  await gamePage.keyboard.press('ArrowLeft');
  await sleep(1200);
  await gamePage.screenshot({ path: `${OUT}/ui-game-arcade.png` });
  await gamePage.keyboard.press('Enter');
  await gamePage.waitForFunction(() => window.engine.scene.findByName('Player'), { timeout: 5000 }).catch(() => {});
  await gamePage.keyboard.down('KeyW');
  await sleep(1500);
  await gamePage.keyboard.up('KeyW');
  const run = await gamePage.evaluate(() => ({
    title: document.title,
    playing: window.engine?.playing,
    scenes: window.sceneManager ? [...Array(window.sceneManager.sceneCount)].map((_, i) => window.sceneManager.sceneName(i)).join() : null,
    gems: window.engine?.scene.getGroup('gems').length,
    // The ball can pick up the only gem on the field just as this runs: a collected one counts too.
    points: window.engine?.scene.findByName('Game')?.components.find((c) => 'points' in c)?.points,
    z: window.engine?.scene.findByName('Player')?.transform.position[2],
    rendered: window.engine?.renderer.stats.drawCalls ?? window.engine?.renderer.stats,
  }));
  await gamePage.screenshot({ path: `${OUT}/ui-game.png` });
  check('built game starts a game from its menu scene', run.title === 'Demo' && run.playing && run.scenes === 'Arcade,Neon Run,Topple,Starfall,Main,Gem Rush' && (run.gems > 0 || run.points > 0) && run.z < 4.5, JSON.stringify(run));
  await gamePage.keyboard.press('Backspace');
  await gamePage.waitForFunction(() => window.engine.scene.findByName('Stands'), { timeout: 5000 }).catch(() => {});
  check('built game: Backspace returns to the menu', await gamePage.evaluate(() => window.sceneManager.activeSceneName === 'Arcade'));
  for (const name of ['Neon Run', 'Topple', 'Starfall']) {
    const ok = await gamePage.evaluate(async (n) => {
      await window.sceneManager.loadScene(n);
      await new Promise((r) => setTimeout(r, 1500));
      return window.sceneManager.activeSceneName === n && window.engine.playing && !!window.engine.viewObject;
    }, name);
    await gamePage.screenshot({ path: `${OUT}/ui-game-${name.toLowerCase().replace(' ', '-')}.png` });
    check(`built game plays ${name}`, ok);
  }
  const loaded = await gamePage.evaluate(async () => {
    const scene = await window.sceneManager.loadScene('Main');
    await new Promise((r) => setTimeout(r, 300));
    return { same: scene === window.engine.scene, index: window.sceneManager.activeSceneIndex, lantern: !!window.engine.scene.findByName('Lantern') };
  });
  await gamePage.screenshot({ path: `${OUT}/ui-game-main.png` });
  check('built game loads its other scene (with an imported model)', loaded.same && loaded.index === 4 && loaded.lantern, JSON.stringify(loaded));
  // Main has the EmptyScript that the scripting checks above made throw: games report script errors on the console.
  const unexpected = gameErrors.filter((e) => !/^error: EmptyScript\.ts:\d+: Error: kaboom \(on Empty\)$/.test(e));
  check('built game reports script errors on the console', gameErrors.length > unexpected.length);
  check('built game: no other console errors/warnings', unexpected.length === 0, unexpected.join(' | '));
  await gamePage.close();
}

// --- ☰ menu: rename the open scene in place, delete it
await page.click('.file-menu summary');
await sleep(100);
await page.screenshot({ path: `${OUT}/ui-file-menu.png` });
check('menu shows the open scene name', (await page.$eval('.scene-name', (e) => e.value)) === (await state(() => window.editor.project.currentScene.name)));
await page.click('.scene-name', { clickCount: 3 });
await page.keyboard.type('Arena');
await page.keyboard.press('Enter');
await sleep(100);
const renamed = await state(() => ({
  name: window.editor.project.currentScene.name,
  option: document.querySelector('.scene-select').selectedOptions[0]?.text,
  menuOpen: document.querySelector('.file-menu').open,
}));
check('Enter in the menu renames the scene', renamed.name === 'Arena' && renamed.option === 'Arena' && !renamed.menuOpen, JSON.stringify(renamed));
const scenesBefore = await state(() => window.editor.project.project.scenes.length);
await page.click('.file-menu summary');
await page.click('[data-action="delete-scene"]');
await sleep(300);
const sceneDeleted = await state(() => ({
  scenes: window.editor.project.project.scenes.map((s) => s.name).join(),
  field: document.querySelector('.scene-name').value,
  current: window.editor.project.currentScene.name,
}));
check('Delete Scene removes the open scene', sceneDeleted.scenes.split(',').length === scenesBefore - 1 && !sceneDeleted.scenes.includes('Arena') &&
  sceneDeleted.field === sceneDeleted.current, JSON.stringify(sceneDeleted));

check('no console errors/warnings', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
