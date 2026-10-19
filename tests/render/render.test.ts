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
const { Renderer, Scene, Camera, OverlayBuilder, loadGLTF, loadOBJ, quat, mat4, vec3, raycastScene, worldBounds, boxCorners } = engine;

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
check('OBJ triangles', ico.children.reduce((n: number, c: any) => n + c.mesh.triangleCount, 0) === 20);

// Animate a bit so behaviours run.
scene.traverse((o: any) => o.behaviours.forEach((b: any) => b.start(o)));
for (let i = 0; i < 30; i++) scene.update(1 / 60, i / 60, true);

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
