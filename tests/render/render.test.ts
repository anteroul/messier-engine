// Headless renderer smoke test: runs the real engine through Dawn (the
// `webgpu` npm package) on the machine's GPU, checks math / loaders / picking /
// gizmo logic, renders the demo scene and writes tests/.out/frame.png.
// Run via `npm run test:render` (see tests/render/run.mjs).
import { create, globals } from 'webgpu';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const ROOT = process.env.PROJECT_ROOT!;
const OUT = process.env.OUT_DIR!;


Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });
(globalThis as any).window = globalThis;
(globalThis as any).devicePixelRatio = 1;
(globalThis as any).createImageBitmap = async () => {
  throw new Error('createImageBitmap unavailable headless');
};

const engine = await import('@root/src/engine/index.ts');
const { Gizmo } = await import('@root/src/editor/gizmo.ts');
const { buildDemoScene } = await import('@root/src/demo.ts');
const { Renderer, Scene, Camera, CameraComponent, GameObject, OverlayBuilder, loadGLTF, loadOBJ, quat, mat4, vec3, raycastScene, worldBounds, boxCorners } = engine;

let failures = 0;
const check = (name: string, ok: boolean, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
  if (!ok) failures++;
};

// ---- math
{
  const q = quat.fromEulerDeg(30, -45, 60);
  const e = quat.toEulerDeg(q);
  check('euler roundtrip', Math.abs(e[0] - 30) < 1e-4 && Math.abs(e[1] + 45) < 1e-4 && Math.abs(e[2] - 60) < 1e-4, e.map((x: number) => x.toFixed(3)).join(','));
  const m = mat4.fromTRS([1, 2, 3], q, [2, 3, 4]);
  const d = mat4.decompose(m);
  const qd = d.r[3] < 0 ? d.r.map((x: number) => -x) : d.r;
  check('decompose', vec3.equals(d.t, [1, 2, 3], 1e-5) && vec3.equals(d.s, [2, 3, 4], 1e-5) && qd.every((v: number, i: number) => Math.abs(v - q[i]) < 1e-5));
  const inv = mat4.invert(m)!;
  const id = mat4.multiply(m, inv);
  check('invert', id.every((v: number, i: number) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-5));
  const r = quat.rotateVec3(quat.fromAxisAngle([0, 1, 0], Math.PI / 2), [1, 0, 0]);
  check('rotateVec3', vec3.equals(r, [0, 0, -1], 1e-6), r.join(','));
  const lr = quat.lookRotation([1, -1, 0]);
  const f = quat.rotateVec3(lr, [0, 0, -1]);
  check('lookRotation', vec3.equals(f, vec3.normalize([1, -1, 0]), 1e-5));
  const o = mat4.orthoReversedZ(-2, 2, -1, 1, 0.5, 20);
  const zn = vec3.transformPoint(o, [0, 0, -0.5])[2], zf = vec3.transformPoint(o, [0, 0, -20])[2];
  check('orthoReversedZ', Math.abs(zn - 1) < 1e-6 && Math.abs(zf) < 1e-6, `${zn}, ${zf}`);
}

// ---- cameras: active camera selection, view from the owning object, orthographic rays
{
  const s = new Scene();
  const a = s.add(new GameObject('A'));
  a.camera = new CameraComponent();
  const rig = s.add(new GameObject('Rig'));
  rig.transform.position = [0, 2, 0];
  rig.transform.rotation = quat.fromEulerDeg(0, 90, 0);
  const b = rig.add(new GameObject('B'));
  b.camera = new CameraComponent({ projection: 'orthographic', orthoSize: 3, priority: 1 });
  b.transform.position = [0, 0, 5];
  s.updateMatrices();
  check('active camera by priority', s.activeCamera() === b);
  b.visible = false;
  check('hidden camera inactive', s.activeCamera() === a);
  b.visible = true;
  const view = b.camera.applyTo(new Camera(), b.worldMatrix, 4);
  // The rig's 90° yaw turns B's local +Z offset into world +X and its -Z view direction into world -X.
  const ok = vec3.equals(view.position, [5, 2, 0], 1e-5) && vec3.equals(view.forward(), [-1, 0, 0], 1e-5) && vec3.equals(view.target, [1, 2, 0], 1e-5);
  check('camera view from object', ok && view.orthographic && view.orthoSize === 3, `${view.position} → ${view.target}`);
  view.aspect = 2;
  const r1 = view.screenRay(0, 0, 200, 100), r2 = view.screenRay(200, 100, 200, 100);
  check('orthographic rays parallel', vec3.equals(r1.dir, r2.dir, 1e-4) && Math.abs(r1.origin[1] - r2.origin[1] - 6) < 1e-3, `${r1.origin} / ${r2.origin}`);
  check('orthographic world per pixel', Math.abs(view.worldPerPixel([0, 0, 0], 100) - 0.06) < 1e-9);
  const copy = b.clone();
  check('camera clone', copy.camera !== b.camera && copy.camera.projection === 'orthographic' && copy.camera.priority === 1);
}

// ---- physics (CPU only): resting contacts, stacking, bouncing, sleeping
{
  const { GameObject, RigidBody, fitCollider, createCube, createSphere, createPlane } = engine;
  const body = (name: string, mesh: any, pos: number[], type = 'dynamic', opts: any = {}) => {
    const o = new GameObject(name);
    o.mesh = mesh;
    o.transform.position = pos;
    o.rigidBody = new RigidBody(type, opts);
    fitCollider(o.rigidBody, mesh);
    Object.assign(o.rigidBody, opts);
    return o;
  };
  const world = new Scene();
  world.add(body('Floor', createPlane(30, 1), [0, 0, 0], 'static'));
  const box = world.add(body('Box', createCube(1), [0, 2, 0]));
  box.transform.setEulerDeg(25, 10, 15);
  const ball = world.add(body('Ball', createSphere(0.5), [3, 3, 0], 'dynamic', { shape: 'sphere' }));
  const bouncy = world.add(body('Bouncy', createSphere(0.5), [-3, 3, 0], 'dynamic', { shape: 'sphere', restitution: 0.8 }));
  const stack = [0, 1, 2].map((i) => world.add(body(`Stack ${i}`, createCube(1), [0, 0.5 + i, 4])));
  const pushed = world.add(body('Pushed', createCube(1), [-4, 0.5, 4], 'dynamic', { velocity: [3, 0, 0] }));
  world.physics.reset(world);
  let bounced = false, apex = 0;
  for (let i = 0; i < 360; i++) {
    world.update(1 / 60, i / 60, true);
    if (bouncy.rigidBody.velocity[1] > 0.5) bounced = true;
    if (bounced) apex = Math.max(apex, bouncy.transform.position[1]);
  }
  const p = (o: any) => o.transform.position;
  const up = (o: any) => Math.max(...[[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((a) => Math.abs(quat.rotateVec3(o.transform.rotation, a)[1])));
  const finite = [box, ball, bouncy, pushed, ...stack].every((o) => [...p(o), ...o.transform.rotation].every(Number.isFinite));
  check('physics finite', finite);
  check('physics box lands flat', Math.abs(p(box)[1] - 0.5) < 0.03 && up(box) > 0.999, `y=${p(box)[1].toFixed(4)} up=${up(box).toFixed(5)}`);
  check('physics sphere rests', Math.abs(p(ball)[1] - 0.5) < 0.03 && Math.abs(p(ball)[0] - 3) < 1e-3, p(ball).map((x: number) => x.toFixed(4)).join(','));
  check('physics restitution bounces', apex > 1.4 && apex < 3, `apex=${apex.toFixed(3)}`);
  const top = p(stack[2]);
  check('physics stack is stable', Math.abs(top[1] - 2.5) < 0.05 && Math.hypot(top[0], top[2] - 4) < 0.05, top.map((x: number) => x.toFixed(4)).join(','));
  check('physics friction stops slide', pushed.rigidBody.velocity[0] < 1e-3 && p(pushed)[0] > -3.6 && p(pushed)[0] < -2.5, `x=${p(pushed)[0].toFixed(3)}`);
  const awake = [box, ...stack].filter((o: any) => !o.rigidBody.sleeping);
  check('physics bodies sleep', awake.length === 0, awake.map((o: any) => `${o.name} v=${vec3.length(o.rigidBody.velocity).toFixed(4)} w=${vec3.length(o.rigidBody.angularVelocity).toFixed(4)}`).join('; '));
}

// ---- TypeScript type stripper: compare against esbuild on a corpus and on the repo's own sources
{
  const esbuild = await import('esbuild');
  const { readdirSync, statSync } = await import('node:fs');
  const { CORPUS } = await import('./ts-corpus');
  const { stripTypes, TranspileError } = engine;
  const tsconfigRaw = { compilerOptions: { useDefineForClassFields: true, verbatimModuleSyntax: true, target: 'es2022' } };
  // minifyIdentifiers is left off: esbuild picks short names by character frequency, which types change.
  const min = async (code: string, loader: 'js' | 'ts') => (await esbuild.transform(code, { loader, minifySyntax: true, minifyWhitespace: true, tsconfigRaw, target: 'es2022' })).code;
  const compare = async (src: string): Promise<string | null> => {
    let out: string;
    try {
      out = stripTypes(src).code;
    } catch (e: any) {
      return `strip error: ${e.message} @${e.line}:${e.column}`;
    }
    if (out.length !== src.length || out.split('\n').length !== src.split('\n').length) return 'positions not preserved';
    let mine: string;
    try {
      mine = await min(out, 'js');
    } catch (e: any) {
      return `invalid JS: ${e.errors?.[0]?.text} @${e.errors?.[0]?.location?.line}`;
    }
    return mine === (await min(src, 'ts')) ? null : 'output differs from esbuild';
  };
  const corpusFails: string[] = [];
  for (const [i, src] of CORPUS.entries()) {
    const r = await compare(src);
    if (r) corpusFails.push(`#${i} ${r}`);
  }
  check('ts strip corpus matches esbuild', corpusFails.length === 0, corpusFails.join('; ') || `${CORPUS.length} snippets`);
  // Parameter properties aren't erasable, so files using them are skipped.
  const walk = (d: string): string[] => readdirSync(d).flatMap((f: string) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : f.endsWith('.ts') ? [`${d}/${f}`] : []));
  const srcFails: string[] = [];
  let compared = 0;
  for (const f of walk(ROOT + '/src')) {
    const src = readFileSync(f, 'utf8');
    try {
      stripTypes(src);
    } catch (e) {
      if (e instanceof TranspileError && e.message.startsWith('Parameter properties')) continue;
    }
    compared++;
    const r = await compare(src);
    if (r) srcFails.push(`${f.slice(ROOT.length + 1)}: ${r}`);
  }
  check('ts strip engine sources match esbuild', srcFails.length === 0 && compared >= 15, srcFails.join('; ') || `${compared} files`);
  const errorAt = (src: string) => {
    try {
      stripTypes(src);
      return 'no error';
    } catch (e: any) {
      return `${e.line}:${e.column}`;
    }
  };
  check(
    'ts strip rejects non-erasable syntax',
    errorAt('let a = 1;\nenum E { A }') === '2:1' && errorAt('namespace N { }') === '1:1' && errorAt('class A {\n  constructor(private x: number) {}\n}') === '2:15' && errorAt('@dec class A {}') === '1:1',
    [errorAt('let a = 1;\nenum E { A }'), errorAt('class A {\n  constructor(private x: number) {}\n}')].join(' '),
  );
  check('ts strip reports syntax errors', errorAt('function f(a: number {\n}') === '1:22' && errorAt('let s = "abc') === '1:9', `${errorAt('function f(a: number {\n}')} ${errorAt('let s = "abc')}`);
}

// ---- behaviour scripts: compile, parameters, runtime errors, hot reload
{
  const { GameObject, ScriptAsset } = engine;
  const source = `import { Script, vec3, type Vec3 } from 'messier';

export default class Mover extends Script {
  speed: number = 2;
  private steps = 0;
  _internal = 1;
  label = 'not a number';

  update(dt: number): void {
    this.steps++;
    const p: Vec3 = this.object.transform.position;
    this.object.transform.position = vec3.add(p, [this.speed * dt, 0, 0]);
    if (p[0] > 1) (null as any).boom();
  }
}
`;
  const world = new Scene();
  const asset = world.scripts.add(new ScriptAsset('Mover', source));
  const ok = asset.compile();
  check('script compiles', ok && asset.diagnostics.length === 0, JSON.stringify(asset.diagnostics));
  check('script fields become params', JSON.stringify(asset.defaults) === '{"speed":2}', JSON.stringify(asset.defaults));
  const obj = world.add(new GameObject('Mover obj'));
  const b = obj.attachComponent(asset.create({ speed: 4 }));
  check('script param overrides', b.params.speed === 4 && Object.keys(b.params).join() === 'speed' && b.clone().params.speed === 4);
  const reported: any[] = [];
  world.scripts.onRuntimeError = (_s: any, d: any) => reported.push(d);
  // 0.4 per step; the 4th update moves to 1.6 and then throws, which pauses the behaviour.
  for (let i = 0; i < 10; i++) world.update(0.1, i * 0.1, true);
  const x = obj.transform.position[0];
  check('script runs and pauses on error', b.error !== null && Math.abs(x - 1.6) < 1e-6 && reported.length === 1, `x=${x} err=${b.error?.message}`);
  check('script runtime error maps to source line', b.error?.line === 13 && reported[0]?.object === 'Mover obj', `line ${b.error?.line}:${b.error?.column}`);

  // A broken edit keeps the last good class; a fixed one hot-swaps and keeps instance state.
  asset.source = source.replace('this.steps++;', 'this.steps++ +;');
  check('script compile error keeps old class', !asset.compile() && asset.compileError?.message !== undefined && asset.ctor !== null);
  asset.source = source.replace('if (p[0] > 1) (null as any).boom();', 'this.object.transform.position[1] = this.steps;');
  check('script recompiles', asset.compile());
  world.update(0.1, 1, true);
  const steps = (b as any).steps;
  check('script hot reload keeps state', b.error === null && steps === 5 && obj.transform.position[1] === 5, `steps=${steps} y=${obj.transform.position[1]}`);

  // Scripts reach their scene through the hierarchy.
  const probe = world.scripts.add(new ScriptAsset('SceneProbe', `import { Script } from 'messier';
export default class SceneProbe extends Script {
  update(): void { this.object.transform.position[2] = this.scene.findByName('Mover obj') ? 7 : -1; }
}
`));
  check('scene probe compiles', probe.compile(), JSON.stringify(probe.diagnostics));
  const holder = world.add(new GameObject('Holder'));
  const nested = holder.add(new GameObject('Nested'));
  const pb = nested.attachComponent(probe.create());
  world.update(0.1, 1.1, true);
  check('script sees its scene', nested.transform.position[2] === 7 && nested.scene === world, `z=${nested.transform.position[2]} err=${pb.error?.message}`);
  world.remove(holder);
  check('detached object has no scene', nested.scene === null && new GameObject().scene === null);

  // A start() that threw is re-run after the fix instead of resuming the half-started instance.
  const starter = world.scripts.add(new ScriptAsset('Starter', `import { Script } from 'messier';
export default class Starter extends Script {
  target: any = null;
  start(): void { this.target = this.find('Taget')!; this.target.name; }
  update(): void { this.target.transform.position[0] = 9; }
}
`));
  check('starter compiles', starter.compile(), JSON.stringify(starter.diagnostics));
  const starterObj = world.add(new GameObject('Starter obj'));
  const sb = starterObj.attachComponent(starter.create());
  const target = world.add(new GameObject('Target'));
  world.update(0.1, 1.15, true);
  check('script start() error pauses', sb.error !== null);
  starter.source = starter.source.replace("'Taget'", "'Target'");
  starter.compile();
  world.update(0.1, 1.2, true);
  check('fixed start() re-runs on hot swap', sb.error === null && target.transform.position[0] === 9, `err=${sb.error?.message}`);

  // Field initializers can't reach the scene yet; the compile error says so.
  const early = new ScriptAsset('Early', `import { Script } from 'messier';
export default class Early extends Script {
  cam = this.scene.activeCamera();
}
`);
  check('scene in field initializer explains itself', !early.compile() && /start\(\) on/.test(early.compileError?.message ?? ''), early.compileError?.message);

  const bad = (src: string) => {
    const a = new ScriptAsset('Bad', src);
    a.compile();
    return a.compileError?.message ?? 'none';
  };
  const forms = new ScriptAsset('Forms', `import * as M from 'messier';
import { Script as Base, type GameObject } from 'messier';
export const K: number = 3;
export function helper<T>(x: T): T { return x; }
export interface Shape { k: number }
export default class extends Base { k = helper(K) * (M.DEG2RAD > 0 ? 1 : 0); }
`);
  check('script module forms', forms.compile() && forms.defaults.k === 3, JSON.stringify(forms.diagnostics));
  check(
    'script rejects bad modules',
    bad(`import { Nope } from 'messier';`).includes("'Nope' is not exported") &&
      bad(`import { x } from 'fs';`).includes('only import') &&
      bad(`const a = 1;`).includes('export default') &&
      bad(`export default class A {}`).includes('extends Script'),
  );
}

// ---- fake canvas
const W = 960, H = 540;
let current: GPUTexture | null = null;
let device: GPUDevice | null = null;
const fakeContext = {
  configure(cfg: GPUCanvasConfiguration) {
    device = cfg.device;
    (fakeContext as any).format = cfg.format;
  },
  getCurrentTexture() {
    current ??= device!.createTexture({ size: [W, H], format: (fakeContext as any).format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    return current;
  },
};
const canvas: any = { clientWidth: W, clientHeight: H, width: 0, height: 0, getContext: () => fakeContext };

const renderer = await Renderer.create(canvas);
const errors: string[] = [];
renderer.device.addEventListener('uncapturederror', (e: any) => errors.push(e.error.message));

// ---- scene
const scene = new Scene();
buildDemoScene(scene);
const resolver = (dir: string) => async (uri: string) => {
  const b = readFileSync(`${dir}/${uri}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const glbBytes = readFileSync(ROOT + '/public/models/lantern.glb');
const lantern = await loadGLTF(glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength), 'lantern', resolver(ROOT + '/public/models'));
lantern.transform.position = [3.5, 0, 2.5];
scene.add(lantern);
let lanternMeshes = 0, lanternLights = 0;
lantern.traverse((o: any) => {
  if (o.mesh) lanternMeshes++;
  if (o.light) lanternLights++;
});
check('glTF hierarchy', lanternMeshes === 4 && lanternLights === 1, `${lanternMeshes} meshes, ${lanternLights} lights`);
const ico = await loadOBJ(readFileSync(ROOT + '/public/models/icosahedron.obj', 'utf8'), 'icosahedron', resolver(ROOT + '/public/models'));
ico.transform.position = [-3.2, 0.9, -3];
scene.add(ico);
check('OBJ groups/materials', ico.children.length === 2 && ico.children[0].material.name === 'Crystal', `${ico.children.length} children`);
{
  // Minimal glTF with an orthographic and a perspective camera (no buffers needed).
  const json = {
    asset: { version: '2.0' },
    cameras: [
      { type: 'perspective', perspective: { yfov: Math.PI / 3, znear: 0.2 } },
      { type: 'orthographic', orthographic: { xmag: 4, ymag: 2, znear: 0.5, zfar: 50 } },
    ],
    nodes: [{ name: 'P', camera: 0 }, { name: 'O', camera: 1, translation: [0, 1, 0] }],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  const root = await loadGLTF(bytes.buffer, 'cams', async () => new ArrayBuffer(0));
  const p = root.children[0].camera, o = root.children[1].camera;
  check('glTF cameras', Math.abs(p.fovDeg - 60) < 1e-6 && p.near === 0.2 && p.far === 1000 && o.projection === 'orthographic' && o.orthoSize === 2 && o.far === 50,
    JSON.stringify([p, o]));
}
check('OBJ triangles', ico.children.reduce((n: number, c: any) => n + c.mesh.triangleCount, 0) === 20);

// ---- scene & project persistence
{
  const { Project, ProjectResources, ScriptAsset, Mesh, serializeScene, applySceneData, loadModelAsset } = engine;
  const src = new Scene();
  buildDemoScene(src);
  for (const s of src.scripts.scripts) s.compile();
  const { model, asset } = await loadModelAsset('lantern.glb', glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength), resolver(ROOT + '/public/models'));
  src.add(model);
  const gold = src.findByName('Gold Sphere');
  gold.material.roughness = 0.77;
  gold.transform.scale = [1, 2, 3];
  src.ambientIntensity = 0.5;
  src.physics.gravity = [0, -5, 0];
  const glow = src.findByName('Glow Orb');
  glow.behaviours[0].params.size = 1.25; // a script override
  const saveWarnings: string[] = [];
  const data = serializeScene(src, saveWarnings);

  const project = new Project();
  project.name = 'Test';
  project.scenes = [{ id: 'a', name: 'Main', data }];
  project.startScene = 'a';
  project.scripts = src.scripts.scripts.map((s: any) => ({ name: s.name, source: s.source }));
  project.assets = [asset, { id: 'unused', name: 'unused', files: [{ name: 'x.obj', bytes: new Uint8Array(8) }] }];
  const decoded = Project.decode(project.encode());
  check('project encode/decode', decoded.name === 'Test' && decoded.scenes.length === 1 && decoded.assets.length === 1 &&
    decoded.assets[0].files[0].bytes.byteLength === glbBytes.byteLength && decoded.scripts.map((s: any) => s.name).join() === 'Hover',
    `${decoded.assets.length} assets, files ${decoded.assets[0]?.files.map((f: any) => `${f.name}:${f.bytes.byteLength}`).join(' ')}`);

  const dst = new Scene();
  for (const s of decoded.scripts) dst.scripts.add(new ScriptAsset(s.name, s.source)).compile();
  const res = new ProjectResources(decoded);
  const loadWarnings: string[] = [];
  await res.prepare(decoded.scenes[0].data, loadWarnings);
  applySceneData(dst, decoded.scenes[0].data, res, loadWarnings);
  const resaved = JSON.stringify(serializeScene(dst));
  let meshes = 0, lights = 0;
  dst.findByName('Lantern')?.traverse((o: any) => {
    if (o.mesh) meshes++;
    if (o.light) lights++;
  });
  const cubes = [dst.findByName('Crate 1'), dst.findByName('Crate 2')];
  check('scene round-trip', saveWarnings.length === 0 && loadWarnings.length === 0 && resaved === JSON.stringify(data),
    [...saveWarnings, ...loadWarnings].join('; ') || (resaved === JSON.stringify(data) ? `${resaved.length} chars` : 'resaved scene differs'));
  check('scene round-trip values', dst.findByName('Gold Sphere').material.roughness === 0.77 && vec3.equals(dst.findByName('Gold Sphere').transform.scale, [1, 2, 3]) &&
    dst.ambientIntensity === 0.5 && dst.physics.gravity[1] === -5 && dst.findByName('Glow Orb').behaviours[0].params.size === 1.25 &&
    dst.findByName('Main Camera').camera.fovDeg === 50 && cubes[0].mesh === cubes[1].mesh);
  check('scene round-trip asset meshes', meshes === 4 && lights === 1, `${meshes} meshes, ${lights} lights`);

  // Problems are reported, not thrown.
  const runtime = new Scene();
  const custom = new GameObject('Custom');
  custom.mesh = Mesh.fromArrays('tri', [0, 0, 0, 1, 0, 0, 0, 1, 0], null, null, null);
  runtime.add(custom);
  const runtimeWarnings: string[] = [];
  const runtimeData = serializeScene(runtime, runtimeWarnings);
  runtimeData.objects.push({ name: 'Broken', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], visible: true, castShadows: true,
    mesh: { asset: 'gone', index: 0 }, behaviours: [{ script: 'Missing', enabled: true, overrides: {} }, { type: 'Nope', enabled: true, params: {} }] });
  const brokenScene = new Scene();
  const brokenWarnings: string[] = [];
  const brokenRes = new ProjectResources(new Project());
  await brokenRes.prepare(runtimeData, brokenWarnings);
  applySceneData(brokenScene, runtimeData, brokenRes, brokenWarnings);
  const broken = brokenScene.findByName('Broken');
  check('scene load problems are warnings', runtimeWarnings.length === 1 && !!broken && broken.mesh === null && broken.behaviours.length === 0 && brokenWarnings.length === 4,
    [...runtimeWarnings, ...brokenWarnings].join('; '));
  let newer = '';
  try {
    applySceneData(new Scene(), { ...data, version: 99 }, res);
  } catch (err) {
    newer = (err as Error).message;
  }
  check('newer scene version is rejected', /newer/.test(newer), newer);
}

// ---- keyboard input: edge state lasts one update, axes, and a script reading it
{
  const { GameObject, ScriptAsset, InputState, input } = engine;
  const k = new InputState();
  k.keyDown('KeyW');
  k.keyDown('KeyW'); // auto-repeat
  const first = k.isDown('KeyW') && k.pressed('KeyW', 'KeyX') && k.axis('vertical') === 1 && k.axis('horizontal') === 0;
  k.endFrame();
  const held = k.isDown('KeyW') && !k.pressed('KeyW');
  k.keyDown('KeyS'); // both sides cancel
  const cancel = k.axis('vertical') === 0;
  k.keyUp('KeyW');
  k.keyUp('KeyS');
  const up = !k.isDown('KeyW') && k.released('KeyW') && k.axis(['KeyQ'], ['KeyE']) === 0;
  k.keyDown('Space');
  k.keyUp('Space'); // a tap between two frames still counts as pressed once
  const tap = k.pressed('Space') && !k.isDown('Space');
  k.endFrame();
  k.keyDown('ArrowLeft');
  k.reset();
  check('input state', first && held && cancel && up && tap && !k.pressed('Space') && k.keys.length === 0, JSON.stringify({ first, held, cancel, up, tap }));

  const world = new Scene();
  const asset = world.scripts.add(new ScriptAsset('Player', `import { Script, input } from 'messier';
export default class Player extends Script {
  speed = 2;
  jumps = 0;
  update(dt: number): void {
    const p = this.object.transform.position;
    this.object.transform.position = [p[0] + input.axis('horizontal') * this.speed * dt, p[1], p[2] - input.axis('vertical') * this.speed * dt];
    if (input.pressed('Space')) this.jumps++;
  }
}
`));
  check('input script compiles', asset.compile(), JSON.stringify(asset.diagnostics));
  const obj = world.add(new GameObject('Player'));
  const b = obj.attachComponent(asset.create());
  input.reset();
  input.keyDown('KeyD');
  input.keyDown('ArrowUp');
  input.keyDown('Space');
  for (let i = 0; i < 5; i++) {
    world.update(0.1, i * 0.1, true);
    input.endFrame(); // what Engine.step does
  }
  input.reset();
  const [x, , z] = obj.transform.position;
  const jumps = (b as any).jumps;
  check('input drives a script', Math.abs(x - 1) < 1e-6 && Math.abs(z + 1) < 1e-6 && jumps === 1 && !b.error, `x=${x} z=${z} jumps=${jumps}`);
}

// Animate a bit so behaviours run.
for (let i = 0; i < 30; i++) scene.update(1 / 60, i / 60, true);
{
  const glow = scene.findByName('Glow Orb');
  const hover = glow.behaviours[0];
  check('demo script runs', hover?.typeName === 'Hover' && !hover.error && Math.abs(glow.transform.position[0] - -1) > 0.05, glow.transform.position.map((v: number) => v.toFixed(3)).join(','));
}

const camera = new Camera();
camera.aspect = W / H;

// ---- raycast through the screen-space position of the spinning cube
const cube = scene.findByName('Spinning Cube');
const sp = camera.worldToScreen(cube.worldPosition(), W, H)!;
const hit = raycastScene(scene, camera.screenRay(sp[0], sp[1], W, H));
check('raycast picks cube', hit?.object === cube, hit?.object.name ?? 'none');

// ---- gizmo drag along X moves the cube along X only
{
  const g = new Gizmo(camera);
  const start = cube.worldPosition();
  const size = camera.worldPerPixel(start, H) * 110;
  const tip = camera.worldToScreen(vec3.add(start, [size * 0.6, 0, 0]), W, H)!;
  const picked = g.pick(cube, tip[0], tip[1], W, H);
  check('gizmo pick X', picked === 0, String(picked));
  g.begin(0, cube, camera.screenRay(tip[0], tip[1], W, H), tip[0], tip[1], H);
  const target = camera.worldToScreen(vec3.add(start, [size * 0.6 + 2, 0, 0]), W, H)!;
  g.update(cube, camera.screenRay(target[0], target[1], W, H), target[0], target[1]);
  g.end();
  const moved = vec3.sub(cube.worldPosition(), start);
  check('gizmo translate X', Math.abs(moved[0] - 2) < 1e-3 && Math.abs(moved[1]) < 1e-6 && Math.abs(moved[2]) < 1e-6, moved.map((x: number) => x.toFixed(4)).join(','));
  // put it back
  cube.setWorldPosition(start);
  scene.updateMatrices();
}

// ---- overlay: selection box + gizmo + light icons
const overlay = new OverlayBuilder();
overlay.begin(camera, H);
const g = new Gizmo(camera);
const sel = scene.findByName('Gold Sphere');
const b = worldBounds(sel)!;
overlay.wireBox(boxCorners(b.min, b.max), [1, 0.6, 0.15, 0.9], 1.5, true);
g.draw(overlay, sel, H);
scene.traverse((o: any) => {
  if (o.light) overlay.diamond([o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]], overlay.pixelSize([o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]]) * 7, [1, 1, 0.6, 1], true);
});

{
  // Through the demo's scene camera, perspective and orthographic.
  const main = scene.activeCamera();
  check('demo has a camera', main?.name === 'Main Camera', main?.name ?? 'none');
  const view = new Camera();
  renderer.device.pushErrorScope('validation');
  main.camera.applyTo(view, main.worldMatrix);
  renderer.render(scene, view, { time: 0.5 });
  main.camera.projection = 'orthographic';
  main.camera.applyTo(view, main.worldMatrix);
  renderer.render(scene, view, { time: 0.5 });
  main.camera.projection = 'perspective';
  const err = await renderer.device.popErrorScope();
  check('render through scene camera', !err, err?.message ?? '');
}

renderer.device.pushErrorScope('validation');
const stats = renderer.render(scene, camera, { grid: true, overlay, time: 0.5 });
const validation = await renderer.device.popErrorScope();
check('render validation', !validation, validation?.message ?? '');
check('render stats', stats.drawCalls > 10 && stats.lights >= 7 && stats.shadowCasters > 0, JSON.stringify(stats));

// ---- read back
const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
const buf = renderer.device.createBuffer({ size: bytesPerRow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const enc = renderer.device.createCommandEncoder();
enc.copyTextureToBuffer({ texture: current! }, { buffer: buf, bytesPerRow }, [W, H]);
renderer.device.queue.submit([enc.finish()]);
await buf.mapAsync(GPUMapMode.READ);
const src = new Uint8Array(buf.getMappedRange());
const bgra = (fakeContext as any).format === 'bgra8unorm';
const raw = Buffer.alloc((W * 4 + 1) * H);
let lit = 0;
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  for (let x = 0; x < W; x++) {
    const s = y * bytesPerRow + x * 4, d = y * (W * 4 + 1) + 1 + x * 4;
    raw[d] = src[s + (bgra ? 2 : 0)];
    raw[d + 1] = src[s + 1];
    raw[d + 2] = src[s + (bgra ? 0 : 2)];
    raw[d + 3] = 255;
    if (src[s] + src[s + 1] + src[s + 2] > 120) lit++;
  }
}
check('frame has content', lit > W * H * 0.05, `${((lit / (W * H)) * 100).toFixed(1)}% bright pixels`);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (t: string, data: Buffer) => {
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(t), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([l, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(`${OUT}/frame.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));

await new Promise((r) => setTimeout(r, 100));
check('no uncaptured GPU errors', errors.length === 0, errors.join(' | '));
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
