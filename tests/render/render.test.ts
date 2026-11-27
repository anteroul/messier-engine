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
  const { Project, ProjectResources, ScriptAsset, Mesh, serializeScene, applySceneData, loadModelAsset, AudioSource, AudioClip, SFX_PRESETS } = engine;
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
  glow.attachComponent(new AudioSource({ clip: AudioClip.synth({ ...SFX_PRESETS.laser, frequency: 900 }), volume: 0.4, maxDistance: 25 }));
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
    decoded.assets[0].files[0].bytes.byteLength === glbBytes.byteLength && decoded.scripts.map((s: any) => s.name).join() === 'Hover,Carousel,LapFlash',
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
    dst.findByName('Main Camera').camera.fovDeg === 50 && cubes[0].mesh === cubes[1].mesh &&
    dst.findByName('Glow Orb').getComponent(AudioSource).clip.sfx.frequency === 900 && dst.findByName('Glow Orb').getComponent(AudioSource).maxDistance === 25);
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

// ---- engine frame order: fixed steps → update → lateUpdate → render → deferred destroys
{
  const { Engine, Behaviour, GameObject, Time } = engine;
  // Its own canvas: the shared fake context is bound to the main renderer's device.
  let tex: GPUTexture | null = null;
  let dev: GPUDevice | null = null;
  let fmt: GPUTextureFormat = 'bgra8unorm';
  const ctx = {
    configure(cfg: GPUCanvasConfiguration) {
      dev = cfg.device;
      fmt = cfg.format;
    },
    getCurrentTexture() {
      return (tex ??= dev!.createTexture({ size: [64, 64], format: fmt, usage: GPUTextureUsage.RENDER_ATTACHMENT }));
    },
  };
  const eng = await Engine.create({ clientWidth: 64, clientHeight: 64, width: 0, height: 0, getContext: () => ctx } as any);
  const order: string[] = [];
  class Probe extends Behaviour {
    fixedUpdate() { order.push('fixed'); }
    update() { order.push('update'); }
    lateUpdate() { order.push('late'); GameObject.destroy(this.gameObject); }
    onDestroy() { order.push('destroy'); }
  }
  eng.scene.add(new GameObject('probe')).addComponent(Probe);
  eng.onBeforeRender(() => order.push('render'));
  eng.setPlaying(true);
  (eng as any).step(2.5 / 60);
  check('engine frame order', order.join() === 'fixed,fixed,update,late,render,destroy' && Time.frameCount === 1, order.join());
  eng.setPlaying(false);
}

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

// ---- skies: an image sky (its GPU texture made here, as Node can't decode images), then the gradient for frame.png
{
  const { Texture } = engine;
  const device = renderer.device;
  const pano = device.createTexture({
    size: [64, 32], format: 'rgba8unorm-srgb', mipLevelCount: 7,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const px = new Uint8Array(64 * 32 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256));
  device.queue.writeTexture({ texture: pano }, px, { bytesPerRow: 64 * 4 }, [64, 32]);
  const texture = new Texture({ width: 64, height: 32 } as ImageBitmap, 'pano');
  texture.gpu = pano;
  device.pushErrorScope('validation');
  Object.assign(scene.sky, { mode: 'image', texture, rotation: 90 });
  renderer.render(scene, camera, { time: 0.5 });
  scene.sky.mode = 'gradient';
  const err = await device.popErrorScope();
  check('image sky renders', !err, err?.message ?? '');
  check('the scene\'s sky is drawn', renderer.stats.drawCalls > 0);
}

// ---- material maps: normal, metallic-roughness, occlusion and emissive textures (GPU textures made here, as above).
// A cube of studs: metal studs on rough plastic, occluded around them, with glowing seams between the tiles. It stays in frame.png.
{
  const { Texture, Material, GameObject, createCube } = engine;
  const device = renderer.device;
  const N = 64, CELL = 16;
  const map = (name: string, linear: boolean, texel: (x: number, y: number) => number[]) => {
    const gpu = device.createTexture({
      size: [N, N], format: linear ? 'rgba8unorm' : 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const px = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) px.set(texel(x, y).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)), (y * N + x) * 4);
    device.queue.writeTexture({ texture: gpu }, px, { bytesPerRow: N * 4 }, [N, N]);
    const t = new Texture({ width: N, height: N } as ImageBitmap, name);
    if (linear) t.gpuLinear = gpu;
    else t.gpu = gpu;
    return t;
  };
  // Offset from the stud centre in -1…1 (y up, like the normal map's +Y), and distance.
  const stud = (x: number, y: number) => {
    const dx = ((x % CELL) + 0.5) / CELL * 2 - 1, dy = -(((y % CELL) + 0.5) / CELL * 2 - 1);
    return { dx, dy, r: Math.hypot(dx, dy) };
  };
  const normalTexture = map('studs-normal', true, (x, y) => {
    const { dx, dy, r } = stud(x, y);
    const n = r < 0.75 ? [dx * 0.8, dy * 0.8, Math.sqrt(Math.max(0, 1 - 0.64 * r * r))] : [0, 0, 1];
    return [n[0] * 0.5 + 0.5, n[1] * 0.5 + 0.5, n[2] * 0.5 + 0.5, 1];
  });
  const orm = map('studs-orm', true, (x, y) => {
    const { r } = stud(x, y);
    return r < 0.75 ? [1, 0.25, 1, 1] : [r > 0.9 ? 0.1 : 0.5, 0.8, 0, 1];
  });
  const emissiveTexture = map('studs-glow', false, (x, y) => (x % CELL === 0 || y % CELL === 0 ? [1, 1, 1, 1] : [0, 0, 0, 1]));
  const mat = new Material('Studs', { baseColor: [0.25, 0.3, 0.8, 1], metallic: 1, roughness: 1, emissive: [1, 0.35, 0.1] });
  Object.assign(mat, { normalTexture, metallicRoughnessTexture: orm, occlusionTexture: orm, emissiveTexture });
  const studs = new GameObject('Studs');
  studs.mesh = createCube(1);
  studs.material = mat;
  studs.transform.position = [-2.4, 0.5, 4.4];
  studs.transform.setEulerDeg(0, 30, 0);
  scene.add(studs);
  device.pushErrorScope('validation');
  renderer.render(scene, camera, { time: 0.5 });
  mat.normalTexture = null; // and without a normal map (the flag path)
  renderer.render(scene, camera, { time: 0.5 });
  mat.normalTexture = normalTexture;
  const err = await device.popErrorScope();
  check('material maps render', !err, err?.message ?? '');
}

// ---- 2D: Node has no OffscreenCanvas, so glyphs come from a stand-in rasterizer (a box per letter, a ring for 'O')
// that still goes through the distance field, atlas upload and SDF shader. The demo's world-space sign shows them.
{
  const { fontAtlas, draw2d, Shape2D, Text2D } = engine;
  fontAtlas.setRasterizer({
    glyph(ch: string, _font: unknown, px: number, pad: number) {
      const adv = 0.62 * px;
      if (ch === ' ') return { width: 0, height: 0, coverage: [], originX: 0, originY: 0, advance: adv };
      const w = Math.round(0.5 * px), h = Math.round(0.7 * px), W = w + pad * 2, H = h + pad * 2;
      const cov = new Float32Array(W * H);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const ring = ch === 'O' && x > w * 0.25 && x < w * 0.75 && y > h * 0.2 && y < h * 0.8;
        cov[(y + pad) * W + x + pad] = ring ? 0 : 1;
      }
      return { width: W, height: H, coverage: cov, originX: pad, originY: pad + h, advance: adv };
    },
    metrics: (_f: unknown, px: number) => ({ ascent: 0.8 * px, descent: 0.2 * px }),
  });
  const hud = new GameObject('HUD');
  hud.attachComponent(new Shape2D({ space: 'screen', anchor: 'top-left', width: 220, height: 56, cornerRadius: 10, fillColor: [0, 0, 0, 0.55], strokeWidth: 2, strokeColor: [0.13, 0.83, 0.93, 1] }));
  hud.transform.position = [126, -44, 0];
  const label = new GameObject('Label');
  label.attachComponent(new Text2D({ space: 'screen', anchor: 'top-left', text: 'SCORE O', fontSize: 28, outlineWidth: 3, order: 1 }));
  label.transform.position = [126, -44, 0];
  scene.add(hud);
  scene.add(label);
  // Immediate mode on top: a star polygon and a line.
  const star: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 18 : 40;
    star.push([W - 70 + Math.cos(a) * r, 70 + Math.sin(a) * r]);
  }
  draw2d.polygon(star, { fill: '#ffcc33', stroke: '#000', strokeWidth: 2 });
  draw2d.line(W - 140, 130, W - 10, 130, '#ff4466', 4);
  draw2d.text('draw2d', W - 75, 140, { size: 18, align: 'center', color: '#ffffff' });
}

renderer.device.pushErrorScope('validation');
const stats = renderer.render(scene, camera, { grid: true, overlay, time: 0.5, draw2d: engine.draw2d });
const validation = await renderer.device.popErrorScope();
check('render validation', !validation, validation?.message ?? '');
check('render stats', stats.drawCalls > 10 && stats.lights >= 7 && stats.shadowCasters > 0, JSON.stringify(stats));
check('2D elements drawn', stats.elements2D === 4, String(stats.elements2D));

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
{
  // The top middle of the frame is sky near the horizon: a bright blue-gray, not the dark flat background.
  const s = 3 * bytesPerRow + (W >> 1) * 4;
  const [r, b] = bgra ? [src[s + 2], src[s]] : [src[s], src[s + 2]];
  check('gradient sky fills the background', b > 100 && b > r, `r=${r} b=${b}`);
}

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

// ---- mesh pipeline variants: every variant builds; alpha-tested materials cast shadows with holes.
// A quad with a checkerboard alpha (its GPU texture made here, as Node can't decode images) hangs over the ground
// under a sun shining straight down; the camera looks from below the quad's height, so the shadow's checker pattern
// is in plain view. Saved as alpha-shadow.png.
{
  const { Material, Light, Texture, createPlane } = engine;
  const device = renderer.device;
  const keys = renderer.meshVariantKeys();
  device.pushErrorScope('validation');
  for (const key of keys) renderer.meshPipelines.get(key);
  const variantErr = await device.popErrorScope();
  check('every mesh pipeline variant builds', !variantErr && keys.every((k: any) => renderer.meshPipelines.has(k)), variantErr?.message ?? `${keys.length} variants`);

  const N = 8; // checker cells per side
  const checkerTex = device.createTexture({ size: [N, N], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const cells = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) cells.set([255, 255, 255, ((i % N) + Math.floor(i / N)) % 2 ? 255 : 0], i * 4);
  device.queue.writeTexture({ texture: checkerTex }, cells, { bytesPerRow: N * 4 }, [N, N]);
  const checker = new Texture({ width: N, height: N } as ImageBitmap, 'checker');
  checker.gpu = checkerTex;

  const s = new Scene();
  // One cascade, so each caster is drawn into the shadow map once.
  s.shadowDistance = 12;
  s.shadowCascades = 1;
  const ground = new GameObject('Ground');
  ground.mesh = createPlane(12);
  ground.material = new Material('ground', { baseColor: [0.8, 0.8, 0.8, 1], roughness: 0.9 });
  ground.castShadows = false;
  const fence = new GameObject('Fence');
  fence.mesh = createPlane(4);
  fence.material = Object.assign(new Material('fence', { baseColor: [0.9, 0.5, 0.2, 1], doubleSided: true }), { baseColorTexture: checker, alphaCutoff: 0.5 });
  fence.transform.position = [0, 1.5, 0];
  const sun = new GameObject('Sun');
  sun.light = new Light('directional', [1, 1, 1], 3);
  sun.light.castShadows = true;
  sun.transform.rotation = quat.lookRotation([0, -1, 0]);
  s.add(ground);
  s.add(fence);
  s.add(sun);
  s.updateMatrices();
  const cam = new Camera();
  cam.position = [0, 0.9, 6.5];
  cam.target = [0, 0, -0.5];
  cam.aspect = W / H;

  const bpr = Math.ceil((W * 4) / 256) * 256;
  const readFrame = async () => {
    const out = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = device.createCommandEncoder();
    e.copyTextureToBuffer({ texture: current! }, { buffer: out, bytesPerRow: bpr }, [W, H]);
    device.queue.submit([e.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(out.getMappedRange()).slice();
    out.destroy();
    return px;
  };
  // Brightness of the ground under the middle of each checker cell (the border cells left out: shadow filtering).
  // Plane UVs run at half the world size, so the 4 m quad shows the checker twice: cells of 2 / N m.
  const cell = 2 / N, count = Math.round(4 / cell);
  const groundUnderCells = (px: Uint8Array) => {
    const out: number[] = [];
    const vp = cam.viewProjection();
    for (let i = 1; i < count - 1; i++) {
      for (let j = 1; j < count - 1; j++) {
        const p = cam.worldToScreen([-2 + (i + 0.5) * cell, 0, -2 + (j + 0.5) * cell], W, H, vp)!;
        const o = Math.round(p[1]) * bpr + Math.round(p[0]) * 4;
        out.push(px[o] + px[o + 1] + px[o + 2]);
      }
    }
    return out;
  };
  device.pushErrorScope('validation');
  const stats = renderer.render(s, cam, { time: 0 });
  const alphaErr = await device.popErrorScope();
  const masked = groundUnderCells(await readFrame());
  const maskedPx = await readFrame();
  fence.material.alphaCutoff = 0; // the opaque variant: a solid shadow
  renderer.render(s, cam, { time: 0 });
  const solid = groundUnderCells(await readFrame());
  const lo = Math.min(...solid), hi = Math.max(...masked);
  const lit = (v: number[]) => v.filter((x) => x > (lo + hi) / 2).length;
  check('alpha-tested shadows render', !alphaErr && stats.shadowCasters === 1, alphaErr?.message ?? JSON.stringify(stats));
  check('an alpha-tested caster\'s shadow has holes', hi - lo > 90 && Math.abs(lit(masked) / masked.length - 0.5) < 0.1,
    `${lit(masked)} of ${masked.length} cells lit, range ${lo}..${hi}`);
  check('with no alpha cutoff the shadow is solid', lit(solid) === 0, `${lit(solid)} of ${solid.length} cells lit`);

  const bgra = (fakeContext as any).format === 'bgra8unorm';
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = y * bpr + x * 4, d = y * (W * 4 + 1) + 1 + x * 4;
      raw[d] = maskedPx[o + (bgra ? 2 : 0)];
      raw[d + 1] = maskedPx[o + 1];
      raw[d + 2] = maskedPx[o + (bgra ? 0 : 2)];
      raw[d + 3] = 255;
    }
  }
  writeFileSync(`${OUT}/alpha-shadow.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// ---- culling and instancing: cubes that look alike draw as one batch, each at its own place; the ones outside
// the view (or the shadow map) are left out, and that changes nothing on screen.
{
  const { Material, Light, createCube, createPlane } = engine;
  const device = renderer.device;
  const s = new Scene();
  s.shadowDistance = 20;
  s.shadowCascades = 1;
  s.background = [0, 0, 0];
  const ground = new GameObject('Ground');
  ground.mesh = createPlane(30);
  ground.material = new Material('ground', { baseColor: [0.02, 0.02, 0.02, 1], roughness: 1 });
  ground.castShadows = false;
  s.add(ground);
  const sun = new GameObject('Sun');
  sun.light = new Light('directional', [1, 1, 1], 1);
  sun.light.castShadows = true;
  sun.transform.rotation = quat.lookRotation([0, -1, 0]);
  s.add(sun);
  const mesh = createCube(0.6);
  const cube = (name: string, x: number, z: number) => {
    const o = new GameObject(name);
    o.mesh = mesh;
    // A material of its own, like a duplicated object has: they batch because they look the same.
    o.material = new Material(name, { baseColor: [1, 1, 1, 1], unlit: true });
    o.transform.position = [x, 0.5, z];
    s.add(o);
    return o;
  };
  const xs = [-3, -1.5, 0, 1.5, 3];
  xs.forEach((x, i) => cube(`Seen ${i}`, x, 0));
  cube('Behind', 0, 30); // behind the camera, outside the cascade's box
  cube('Left', -60, 0);
  cube('Right', 60, 0);
  const red = cube('Red', 0, -2.5);
  red.material!.baseColor = [1, 0, 0, 1];
  s.updateMatrices();
  const cam = new Camera();
  cam.position = [0, 3, 9];
  cam.target = [0, 0.5, 0];
  cam.aspect = W / H;

  const bpr = Math.ceil((W * 4) / 256) * 256;
  const readFrame = async () => {
    const out = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = device.createCommandEncoder();
    e.copyTextureToBuffer({ texture: current! }, { buffer: out, bytesPerRow: bpr }, [W, H]);
    device.queue.submit([e.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(out.getMappedRange()).slice();
    out.destroy();
    return px;
  };
  const at = (px: Uint8Array, p: [number, number, number]) => {
    const [x, y] = cam.worldToScreen(p, W, H)!;
    const o = Math.round(y) * bpr + Math.round(x) * 4;
    return px[o] + px[o + 1] + px[o + 2];
  };

  device.pushErrorScope('validation');
  const culled = { ...renderer.render(s, cam, { time: 0 }) };
  const culledPx = await readFrame();
  renderer.frustumCulling = false;
  const all = { ...renderer.render(s, cam, { time: 0 }) };
  const allPx = await readFrame();
  renderer.frustumCulling = true;
  const err = await device.popErrorScope();

  // Ground, the white cubes, the red one.
  check('look-alike meshes draw as one instanced batch', !err && culled.drawCalls === 3 && culled.instances === 7,
    err?.message ?? JSON.stringify(culled));
  check('meshes outside the view are culled', culled.culled === 3 && all.culled === 0 && all.instances === 10 && all.drawCalls === 3,
    `${JSON.stringify(culled)} / ${JSON.stringify(all)}`);
  check('shadow casters outside the shadow map are culled', culled.shadowCasters === 6 && all.shadowCasters === 9,
    `${culled.shadowCasters} / ${all.shadowCasters}`);
  const centers = xs.map((x) => at(culledPx, [x, 0.5, 0]));
  const gaps = [-2.25, -0.75, 0.75, 2.25].map((x) => at(culledPx, [x, 0.5, 0]));
  check('every instance is drawn at its own transform', Math.min(...centers) > 600 && Math.max(...gaps) < 150,
    `cubes ${centers.join()} gaps ${gaps.join()}`);
  let differing = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W * 4; x++) if (culledPx[y * bpr + x] !== allPx[y * bpr + x]) differing++;
  check('culling leaves the frame unchanged', differing === 0, `${differing} differing bytes`);
}

// ---- transparency: blended materials are drawn after the opaque ones, back to front, whatever the scene's order.
// Unlit panes in front of a white wall and of the empty background.
{
  const { Material, createPlane } = engine;
  const device = renderer.device;
  const upright = quat.fromEulerDeg(90, 0, 0);
  const build = (order: string[]) => {
    const s = new Scene();
    s.background = [0, 0, 1];
    const make: Record<string, () => void> = {
      wall: () => pane('Wall', new Material('wall', { baseColor: [1, 1, 1, 1], unlit: true }), -1.5, -2, 3),
      red: () => pane('Red', new Material('red', { baseColor: [1, 0, 0, 0.5], unlit: true, blend: 'alpha' }), 0, 0, 6),
      green: () => pane('Green', new Material('green', { baseColor: [0, 1, 0, 0.5], unlit: true, blend: 'alpha' }), 0, 1, 2),
      glow: () => pane('Glow', new Material('glow', { baseColor: [0, 0.2, 0, 1], unlit: true, blend: 'additive' }), -1.5, 2, 1),
    };
    const pane = (name: string, material: any, x: number, z: number, size: number) => {
      const o = new GameObject(name);
      o.mesh = createPlane(size);
      o.material = material;
      o.material.doubleSided = true;
      o.transform.position = [x, 0, z];
      o.transform.rotation = upright;
      s.add(o);
    };
    for (const name of order) make[name]();
    s.updateMatrices();
    return s;
  };
  const cam = new Camera();
  cam.position = [0, 0, 10];
  cam.target = [0, 0, 0];
  cam.aspect = W / H;
  const bpr = Math.ceil((W * 4) / 256) * 256;
  const bgra = (fakeContext as any).format === 'bgra8unorm';
  const readFrame = async () => {
    const out = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = device.createCommandEncoder();
    e.copyTextureToBuffer({ texture: current! }, { buffer: out, bytesPerRow: bpr }, [W, H]);
    device.queue.submit([e.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(out.getMappedRange()).slice();
    out.destroy();
    return px;
  };
  const rgb = (px: Uint8Array, p: [number, number, number]) => {
    const [x, y] = cam.worldToScreen(p, W, H)!;
    const o = Math.round(y) * bpr + Math.round(x) * 4;
    return [px[o + (bgra ? 2 : 0)], px[o + 1], px[o + (bgra ? 0 : 2)]];
  };
  device.pushErrorScope('validation');
  const stats = { ...renderer.render(build(['wall', 'red', 'green', 'glow']), cam, { time: 0 }) };
  const a = await readFrame();
  renderer.render(build(['glow', 'green', 'red', 'wall']), cam, { time: 0 });
  const b = await readFrame();
  const err = await device.popErrorScope();
  check('blended meshes render', !err && stats.drawCalls === 4, err?.message ?? JSON.stringify(stats));
  let differing = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W * 4; x++) if (a[y * bpr + x] !== b[y * bpr + x]) differing++;
  check('the scene\'s order doesn\'t change a blended frame', differing === 0, `${differing} differing bytes`);
  const overWall = rgb(a, [-1.5, 1.2, 0]), overBoth = rgb(a, [-0.5, 0.5, 0]), overNothing = rgb(a, [2.4, 2.4, 0]);
  const redOverWall = rgb(a, [-2.2, -1.2, 0]), glow = rgb(a, [-1.5, 0, 2]);
  // Unlit colors are tone mapped like everything else: linear 1 shows as about 231, 0.5 as about 205.
  check('a half-transparent pane lets the wall behind it through', redOverWall[0] > 220 && redOverWall[1] > 120 && redOverWall[1] < redOverWall[0] - 10 && redOverWall[1] === redOverWall[2],
    redOverWall.join());
  check('the nearer pane is blended last', overBoth[1] > overBoth[0] && overBoth[0] > 60, overBoth.join());
  check('over nothing, a pane blends with the background', overNothing[0] > 100 && overNothing[1] < 5 && overNothing[2] > 100 && overNothing[2] < 160, overNothing.join());
  check('additive materials only add light', glow[1] > overWall[1] - 1 && glow[0] >= redOverWall[0] - 1, `${glow.join()} over ${overWall.join()}`);
}

// ---- cascaded shadows: posts at growing distances under a slanted sun each cast a shadow toward the camera's side,
// one post per cascade; past the shadow distance there are none. Saved as cascades.png.
{
  const { Material, Light, createCube, createPlane } = engine;
  const device = renderer.device;
  const s = new Scene();
  s.background = [0, 0, 0];
  s.ambientIntensity = 0.05;
  s.shadowDistance = 70;
  const ground = new GameObject('Ground');
  ground.mesh = createPlane(300);
  ground.material = new Material('ground', { baseColor: [0.6, 0.6, 0.6, 1], roughness: 1 });
  ground.castShadows = false;
  s.add(ground);
  const sun = new GameObject('Sun');
  sun.light = new Light('directional', [1, 1, 1], 3);
  sun.light.castShadows = true;
  // Travelling toward -x and down: a post 2 m tall shades the ground up to 1 m past its -x side.
  sun.transform.rotation = quat.lookRotation(vec3.normalize([-0.5, -1, 0]));
  s.add(sun);
  const post = createCube(1);
  // View depths of about 3.6, 7.6, 16.5 and 27 m: one per cascade (they end near 4.6, 10, 21 and 70 m).
  const distances = [1, 5, 14, 25];
  distances.forEach((d, i) => {
    const o = new GameObject(`Post ${i}`);
    o.mesh = post;
    o.material = new Material('post', { baseColor: [0.6, 0.6, 0.6, 1] });
    o.transform.position = [0, 1, 8 - d];
    o.transform.scale = [1, 2, 1];
    s.add(o);
  });
  s.updateMatrices();
  // Low, wide and off to the shaded side, so the nearest shadow is in view and no post hides another's.
  const cam = new Camera();
  cam.position = [-4, 3, 10];
  cam.target = [0, 0, -20];
  cam.fovDeg = 90;
  cam.aspect = W / H;
  const bpr = Math.ceil((W * 4) / 256) * 256;
  const px = new Uint8Array(bpr * H);
  const readInto = async (into: Uint8Array) => {
    const out = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = device.createCommandEncoder();
    e.copyTextureToBuffer({ texture: current! }, { buffer: out, bytesPerRow: bpr }, [W, H]);
    device.queue.submit([e.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    into.set(new Uint8Array(out.getMappedRange()));
    out.destroy();
  };
  device.pushErrorScope('validation');
  const stats = { ...renderer.render(s, cam, { time: 0 }) };
  await readInto(px);
  const err = await device.popErrorScope();
  const lum = (p: [number, number, number]) => {
    const [x, y] = cam.worldToScreen(p, W, H)!;
    if (x < 0 || y < 0 || x >= W || y >= H) return -1;
    const o = Math.round(y) * bpr + Math.round(x) * 4;
    return px[o] + px[o + 1] + px[o + 2];
  };
  const bgra = (fakeContext as any).format === 'bgra8unorm';
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = y * bpr + x * 4, d = y * (W * 4 + 1) + 1 + x * 4;
      raw[d] = px[o + (bgra ? 2 : 0)];
      raw[d + 1] = px[o + 1];
      raw[d + 2] = px[o + (bgra ? 0 : 2)];
      raw[d + 3] = 255;
    }
  }
  writeFileSync(`${OUT}/cascades.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  // Per post: the ground in its shadow, half a metre past its -x side, and the lit ground a metre and a half behind.
  const shading = () => distances.map((d) => [lum([-1, 0, 8 - d]), lum([-1, 0, 6.5 - d])]);
  const pairs = shading();
  check('cascaded shadows render', !err && stats.shadowCasters >= 4, err?.message ?? JSON.stringify(stats));
  check('every post within the shadow distance casts a shadow, in each cascade',
    pairs.every(([shade, lit]) => shade >= 0 && shade < lit * 0.6), pairs.map((p) => p.join('/')).join(' '));
  s.shadowDistance = 10;
  renderer.render(s, cam, { time: 0 });
  await readInto(px);
  const near = shading();
  check('past the shadow distance there are none', near[1][0] < near[1][1] * 0.6 && near[2][0] > near[2][1] * 0.9 && near[3][0] > near[3][1] * 0.9,
    near.map((p) => p.join('/')).join(' '));
  s.shadowDistance = 70;
  s.shadowCascades = 1;
  const one = { ...renderer.render(s, cam, { time: 0 }) };
  check('fewer cascades, fewer shadow casters drawn', one.shadowCasters < stats.shadowCasters, `${one.shadowCasters} < ${stats.shadowCasters}`);
}

// ---- point and spot light shadows: a light beside a block shades the ground behind it; the ground as far from the
// light on its other side is lit. Saved as light-shadows.png (the spot light's frame).
{
  const { Material, Light, createCube, createPlane } = engine;
  const device = renderer.device;
  const bpr = Math.ceil((W * 4) / 256) * 256;
  const cam = new Camera();
  cam.position = [0, 12, 9];
  cam.target = [0, 0, 0];
  cam.aspect = W / H;
  const px = new Uint8Array(bpr * H);
  const readInto = async () => {
    const out = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = device.createCommandEncoder();
    e.copyTextureToBuffer({ texture: current! }, { buffer: out, bytesPerRow: bpr }, [W, H]);
    device.queue.submit([e.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    px.set(new Uint8Array(out.getMappedRange()));
    out.destroy();
  };
  const lum = (p: [number, number, number]) => {
    const [x, y] = cam.worldToScreen(p, W, H)!;
    const o = Math.round(y) * bpr + Math.round(x) * 4;
    return px[o] + px[o + 1] + px[o + 2];
  };
  // The light at x = 0, 3 m up; a block 2 m tall from x = 1 to 2 shades the ground from x = 2 to 4.
  const build = (type: 'point' | 'spot', castShadows: boolean) => {
    const s = new Scene();
    s.background = [0, 0, 0];
    s.ambientIntensity = 0;
    const ground = new GameObject('Ground');
    ground.mesh = createPlane(20);
    ground.material = new Material('ground', { baseColor: [0.7, 0.7, 0.7, 1], roughness: 1 });
    ground.castShadows = false;
    s.add(ground);
    const block = new GameObject('Block');
    block.mesh = createCube(1);
    block.material = new Material('block', { baseColor: [0.7, 0.7, 0.7, 1] });
    block.transform.position = [1.5, 1, 0];
    block.transform.scale = [1, 2, 1];
    s.add(block);
    const lamp = new GameObject('Lamp');
    lamp.light = new Light(type, [1, 1, 1], 60);
    lamp.light.range = 15;
    lamp.light.outerAngle = 70;
    lamp.light.innerAngle = 60;
    lamp.light.castShadows = castShadows;
    lamp.transform.position = [0, 3, 0];
    lamp.transform.rotation = quat.lookRotation([0, -1, 0]);
    s.add(lamp);
    s.updateMatrices();
    return s;
  };
  device.pushErrorScope('validation');
  const results: Record<string, number[]> = {};
  let spotStats: any = null;
  for (const type of ['point', 'spot'] as const) {
    for (const shadows of [true, false]) {
      const stats = { ...renderer.render(build(type, shadows), cam, { time: 0 }) };
      if (type === 'spot' && shadows) spotStats = stats;
      await readInto();
      // Behind the block, and as far from the light on the other side (toward the camera too, for good measure).
      results[`${type} ${shadows}`] = [lum([3, 0, 0]), lum([-3, 0, 0]), lum([0, 0, 3])];
      if (type === 'spot' && shadows) {
        const raw = Buffer.alloc((W * 4 + 1) * H);
        const bgra = (fakeContext as any).format === 'bgra8unorm';
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const o = y * bpr + x * 4, d = y * (W * 4 + 1) + 1 + x * 4;
            raw[d] = px[o + (bgra ? 2 : 0)];
            raw[d + 1] = px[o + 1];
            raw[d + 2] = px[o + (bgra ? 0 : 2)];
            raw[d + 3] = 255;
          }
        }
        writeFileSync(`${OUT}/light-shadows.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
      }
    }
  }
  const err = await device.popErrorScope();
  const show = JSON.stringify(results);
  check('point and spot light shadows render', !err && spotStats?.shadowCasters === 1, err?.message ?? JSON.stringify(spotStats));
  for (const type of ['point', 'spot']) {
    const [behind, other, front] = results[`${type} true`];
    const [behindOff] = results[`${type} false`];
    check(`a ${type} light's shadow falls behind the block`, behind < other * 0.4 && Math.abs(other - front) < other * 0.1, show);
    check(`a ${type} light without shadows lights it`, behindOff > other * 0.9, show);
  }
}

// ---- image-based lighting: a gradient sky is baked into the environment cubes when it changes, the brightest texel
// of the capture looks toward the sun (so the faces are laid out as WebGPU samples them), rougher mips are smoother,
// irradiance comes from where the sky is bright, and the BRDF table has its known corners. Saved as ibl.png: metal and
// plastic spheres from mirror to rough.
{
  const { Material, Light, createSphere, createPlane } = engine;
  const device = renderer.device;
  const env = (renderer as any).environment;
  const half = (h: number) => {
    const e = (h >> 10) & 31, m = h & 1023, sgn = h & 32768 ? -1 : 1;
    return sgn * (e === 0 ? (m / 1024) * 2 ** -14 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15));
  };
  /** Every texel of one mip of a 6-layer rgba16float texture, as [face][y][x] → rgb. */
  const readCube = async (texture: GPUTexture, mip: number, size: number) => {
    const bpr = Math.max(256, Math.ceil((size * 8) / 256) * 256);
    const out = device.createBuffer({ size: bpr * size * 6, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = device.createCommandEncoder();
    e.copyTextureToBuffer({ texture, mipLevel: mip }, { buffer: out, bytesPerRow: bpr, rowsPerImage: size }, [size, size, 6]);
    device.queue.submit([e.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    const u16 = new Uint16Array(out.getMappedRange().slice(0));
    out.destroy();
    const faces: number[][][][] = [];
    for (let f = 0; f < 6; f++) {
      const rows: number[][][] = [];
      for (let y = 0; y < size; y++) {
        const row: number[][] = [];
        for (let x = 0; x < size; x++) {
          const o = (f * bpr * size + y * bpr + x * 8) / 2;
          row.push([half(u16[o]), half(u16[o + 1]), half(u16[o + 2])]);
        }
        rows.push(row);
      }
      faces.push(rows);
    }
    return faces;
  };
  // cube.wgsl's mapping, for checking it against what WebGPU samples.
  const cubeDir = (face: number, u: number, v: number): [number, number, number] => {
    const d: [number, number, number][] = [[1, -v, -u], [-1, -v, u], [u, 1, v], [u, -1, -v], [u, -v, 1], [-u, -v, -1]];
    return vec3.normalize(d[face]);
  };
  const lum = (c: number[]) => c[0] + c[1] + c[2];

  const s = new Scene();
  Object.assign(s.sky, { mode: 'gradient', top: [0.1, 0.2, 0.6], horizon: [0.4, 0.45, 0.5], ground: [0.02, 0.02, 0.02], sunGlow: 2 });
  const sun = new GameObject('Sun');
  sun.light = new Light('directional', [1, 0.9, 0.8], 3);
  s.add(sun);
  const floor = new GameObject('Floor');
  floor.mesh = createPlane(30);
  floor.material = new Material('floor', { baseColor: [0.3, 0.3, 0.3, 1], roughness: 0.8 });
  s.add(floor);
  const sphere = createSphere(0.45, 48, 24);
  for (let i = 0; i < 6; i++) {
    for (const [row, metal] of [[0, 1], [1, 0]] as const) {
      const o = new GameObject(`Ball ${i}`);
      o.mesh = sphere;
      o.material = new Material('ball', { baseColor: metal ? [0.95, 0.8, 0.5, 1] : [0.7, 0.1, 0.1, 1], metallic: metal, roughness: i / 5 });
      o.transform.position = [(i - 2.5) * 1.1, 0.5, row * -1.2];
      s.add(o);
    }
  }
  const cam = new Camera();
  cam.position = [0, 2.2, 5.5];
  cam.target = [0, 0.4, -0.6];
  cam.aspect = W / H;

  const brightestToward = async (dir: [number, number, number]) => {
    sun.transform.rotation = quat.lookRotation(vec3.scale(dir, -1));
    s.updateMatrices();
    renderer.render(s, cam, { time: 0 });
    const faces = await readCube(env.env, 0, 128);
    let best = -1, at: [number, number, number] = [0, 0, 0];
    faces.forEach((rows, f) => rows.forEach((row, y) => row.forEach((c, x) => {
      if (lum(c) > best) {
        best = lum(c);
        at = cubeDir(f, ((x + 0.5) / 128) * 2 - 1, ((y + 0.5) / 128) * 2 - 1);
      }
    })));
    return (Math.acos(Math.min(1, vec3.dot(at, vec3.normalize(dir)))) * 180) / Math.PI;
  };
  device.pushErrorScope('validation');
  const bakes0 = env.bakes;
  const off = [await brightestToward([0.85, 0.3, 0.43]), await brightestToward([-0.3, 0.45, -0.84]), await brightestToward([0.2, 0.9, 0.1])];
  check('the capture is brightest toward the sun, on any face', off.every((a) => a < 3), off.map((a) => a.toFixed(1) + '°').join(' '));
  check('each sky change bakes it again', env.bakes === bakes0 + 3, `${env.bakes - bakes0}`);
  renderer.render(s, cam, { time: 0 });
  s.sky.lighting = 0.5;
  renderer.render(s, cam, { time: 0 });
  check('an unchanged sky, or only its lighting strength, is not baked again', env.bakes === bakes0 + 3, `${env.bakes - bakes0}`);
  s.sky.lighting = 1;

  const sharp = (await readCube(env.specular, 0, 128)).flat(2), rough = (await readCube(env.specular, 5, 4)).flat(2);
  const stats = (texels: number[][]) => {
    const l = texels.map(lum), mean = l.reduce((a, b) => a + b, 0) / l.length;
    return { mean, spread: Math.sqrt(l.reduce((a, b) => a + (b - mean) ** 2, 0) / l.length) / mean };
  };
  const a = stats(sharp), b = stats(rough);
  check('rougher mips are smoother, with about the same light', b.spread < a.spread * 0.7 && Math.abs(b.mean / a.mean - 1) < 0.35,
    `spread ${a.spread.toFixed(3)} → ${b.spread.toFixed(3)}, mean ${a.mean.toFixed(3)} → ${b.mean.toFixed(3)}`);
  const irr = await readCube(env.irradiance, 0, 32);
  const up = lum(irr[2][16][16]), down = lum(irr[3][16][16]);
  check('irradiance comes from the bright sky, not the dark ground', up > down * 3 && Number.isFinite(up), `up ${up.toFixed(3)} down ${down.toFixed(3)}`);

  const err = await device.popErrorScope();
  check('image-based lighting bakes without errors', !err, err?.message);

  // A second look at the table, through a small compute readback of its corners.
  {
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var lut: texture_2d<f32>;
      @group(0) @binding(1) var<storage, read_write> out: array<vec4f, 3>;
      @compute @workgroup_size(1) fn main() {
        out[0] = textureLoad(lut, vec2u(63u, 0u), 0);
        out[1] = textureLoad(lut, vec2u(63u, 63u), 0);
        out[2] = textureLoad(lut, vec2u(0u, 63u), 0);
      }` });
    const pipe = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const buf = device.createBuffer({ size: 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 48, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = device.createCommandEncoder();
    const p = e.beginComputePass();
    p.setPipeline(pipe);
    p.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: env.brdfView }, { binding: 1, resource: { buffer: buf } }] }));
    p.dispatchWorkgroups(1);
    p.end();
    e.copyBufferToBuffer(buf, 0, read, 0, 48);
    device.queue.submit([e.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const v = new Float32Array(read.getMappedRange().slice(0));
    read.destroy();
    const [smooth, roughHead, roughGrazing] = [[v[0], v[1]], [v[4], v[5]], [v[8], v[9]]];
    check('the BRDF table: a smooth surface seen head-on reflects F0 as is', smooth[0] > 0.9 && smooth[1] < 0.05, smooth.map((x) => x.toFixed(3)).join());
    // Reference values from integrating the same BRDF numerically (Monte Carlo, 200k samples) at those texel centers.
    const near = (got: number[], want: number[]) => got.every((x, i) => Math.abs(x - want[i]) < 0.02);
    check('…and a rough one as numerical integration says, head-on and at grazing angles', near(roughHead, [0.315, 0]) && near(roughGrazing, [0.594, 0.02]),
      `${roughHead.map((x) => x.toFixed(3))} / ${roughGrazing.map((x) => x.toFixed(3))}`);
  }

  // The picture: the sun low behind the camera's right shoulder.
  sun.transform.rotation = quat.lookRotation(vec3.normalize([-0.5, -0.45, -0.75]));
  s.updateMatrices();
  renderer.render(s, cam, { time: 0 });
  const bpr = Math.ceil((W * 4) / 256) * 256;
  const out = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const e = device.createCommandEncoder();
  e.copyTextureToBuffer({ texture: current! }, { buffer: out, bytesPerRow: bpr }, [W, H]);
  device.queue.submit([e.finish()]);
  await out.mapAsync(GPUMapMode.READ);
  const px = new Uint8Array(out.getMappedRange().slice(0));
  out.destroy();
  const bgra = (fakeContext as any).format === 'bgra8unorm';
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = y * bpr + x * 4, d = y * (W * 4 + 1) + 1 + x * 4;
      raw[d] = px[o + (bgra ? 2 : 0)];
      raw[d + 1] = px[o + 1];
      raw[d + 2] = px[o + (bgra ? 0 : 2)];
      raw[d + 3] = 255;
    }
  }
  writeFileSync(`${OUT}/ibl.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// ---- profiler: CPU sections from the renderer, and GPU time per frame graph pass where the device can time them
{
  const { profiler } = engine;
  const device = renderer.device;
  profiler.enabled = true;
  device.pushErrorScope('validation');
  for (let i = 0; i < 3; i++) {
    profiler.begin('render');
    renderer.render(scene, camera, { grid: true, overlay, time: 0.5 });
    profiler.end();
    profiler.endFrame(16);
  }
  const profErr = await device.popErrorScope();
  await device.queue.onSubmittedWorkDone();
  for (let i = 0; i < 20 && profiler.gpuSupported && profiler.gpu.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  profiler.enabled = false;
  const names = profiler.sections.map((s: any) => `${s.depth}:${s.name}`);
  check('profiler: the renderer reports its CPU sections', !profErr && names.join() === '0:render,1:prepare,2:cull + batch,1:2D,1:passes' && profiler.cpuMs > 0,
    profErr?.message ?? `${names.join()} ${profiler.cpuMs.toFixed(2)} ms`);
  const gpuNames = profiler.gpu.map((g: any) => g.name).join();
  if (profiler.gpuSupported) {
    check('profiler: GPU time per pass', gpuNames === 'shadow 0,shadow 1,shadow 2,shadow 3,light shadow 0,main,tonemap,overlay' && profiler.gpu.every((g: any) => g.ms >= 0) && profiler.gpuMs > 0,
      profiler.gpu.map((g: any) => `${g.name} ${g.ms.toFixed(3)} ms`).join(', '));
  } else {
    console.log('SKIP profiler: GPU time per pass (no timestamp-query on this device)');
  }
}

await new Promise((r) => setTimeout(r, 100));
check('no uncaptured GPU errors', errors.length === 0, errors.join(' | '));
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
