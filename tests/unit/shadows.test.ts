import { check, eq } from './harness';
import { Camera } from '@root/src/engine/camera.ts';
import { vec3, type Mat4, type Vec3 } from '@root/src/engine/math.ts';
import { MAX_SHADOW_CASCADES, computeCascades } from '@root/src/engine/shadows.ts';

// Cascaded shadow maps: the splits, the boxes around each slice, and their stability as the camera moves.

const SIZE = 2048;
const camera = () => Object.assign(new Camera(), { position: [3, 4, 10] as Vec3, target: [0, 0, 0] as Vec3, fovDeg: 60, aspect: 16 / 9, near: 0.1, far: 500 });
const sun = vec3.normalize([0.4, -1, 0.3]);

/** The corners of the camera's view between depths `n` and `f`. */
function sliceCorners(cam: Camera, n: number, f: number): Vec3[] {
  const fwd = vec3.normalize(vec3.sub(cam.target, cam.position));
  const right = vec3.normalize(vec3.cross(fwd, cam.up));
  const up = vec3.cross(right, fwd);
  const tanY = Math.tan((cam.fovDeg * Math.PI) / 360), tanX = tanY * cam.aspect;
  const out: Vec3[] = [];
  for (const d of [n, f]) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        out.push(vec3.addScaled(vec3.addScaled(vec3.addScaled(cam.position, fwd, d), right, sx * d * tanX), up, sy * d * tanY));
      }
    }
  }
  return out;
}
const inside = (viewProj: Mat4, p: Vec3) => {
  const c = vec3.transformPoint(viewProj, p);
  return Math.abs(c[0]) <= 1 + 1e-4 && Math.abs(c[1]) <= 1 + 1e-4 && c[2] >= 0 && c[2] <= 1;
};

{
  const cam = camera();
  const cs = computeCascades(cam, sun, 60, 4, SIZE);
  eq('one cascade per layer asked for', cs.length, 4);
  check('they end farther and farther, the last at the shadow distance', cs.every((c, i) => i === 0 || c.far > cs[i - 1].far) && cs[3].far === 60,
    cs.map((c) => c.far.toFixed(2)).join());
  check('near cascades are smaller, so their texels are too', cs.every((c, i) => i === 0 || c.texel > cs[i - 1].texel), cs.map((c) => c.texel.toFixed(4)).join());
  const worst = cs.map((c, i) => Math.max(...sliceCorners(cam, i ? cs[i - 1].far : cam.near, c.far).map((p) => { const q = vec3.transformPoint(c.viewProj, p); return Math.max(Math.abs(q[0]), Math.abs(q[1]), q[2] < 0 ? 2 : q[2]); })));
  check('each box holds its whole slice of the view', worst.every((w) => w <= 1 + 1e-4), worst.map((w) => w.toFixed(5)).join());
  const caster = vec3.addScaled(cam.position, vec3.normalize(vec3.sub(cam.target, cam.position)), 2);
  check('casters toward the light, past the slice, still land in the map', inside(cs[0].viewProj, vec3.addScaled(caster, sun, -40)));

  eq('the count is clamped', [computeCascades(cam, sun, 60, 9, SIZE).length, computeCascades(cam, sun, 60, 0, SIZE).length], [MAX_SHADOW_CASCADES, 1]);
  eq('one cascade covers the whole distance', computeCascades(cam, sun, 60, 1, SIZE)[0].far, 60);
  eq('it never reaches past the camera\'s far plane', computeCascades(Object.assign(camera(), { far: 30 }), sun, 60, 2, SIZE)[1].far, 30);
}

// Turning the camera keeps every box's size; moving it shifts the boxes by whole texels, so shadow edges hold still.
{
  const a = computeCascades(camera(), sun, 60, 4, SIZE);
  const turned = camera();
  turned.target = [4, -1, 2];
  const b = computeCascades(turned, sun, 60, 4, SIZE);
  eq('turning the camera keeps the sizes', b.map((c) => c.radius), a.map((c) => c.radius));
  const moved = camera();
  moved.position = [3.0123, 4, 10.0456];
  moved.target = [0.0123, 0, 0.0456];
  const m = computeCascades(moved, sun, 60, 4, SIZE);
  const shiftInTexels = m.map((c, i) => {
    // Where the world origin lands in each map, in texels: the shift between the two must be whole.
    const p = vec3.transformPoint(c.viewProj, [0, 0, 0]), q = vec3.transformPoint(a[i].viewProj, [0, 0, 0]);
    return [((p[0] - q[0]) * SIZE) / 2, ((p[1] - q[1]) * SIZE) / 2];
  });
  check('moving the camera shifts the maps by whole texels', shiftInTexels.every(([x, y]) => Math.abs(x - Math.round(x)) < 0.01 && Math.abs(y - Math.round(y)) < 0.01),
    JSON.stringify(shiftInTexels));
}

// An orthographic camera's slices are boxes of constant width.
{
  const cam = Object.assign(camera(), { orthographic: true, orthoSize: 6 });
  const cs = computeCascades(cam, sun, 40, 3, SIZE);
  const fwd = vec3.normalize(vec3.sub(cam.target, cam.position));
  const right = vec3.normalize(vec3.cross(fwd, cam.up)), up = vec3.cross(right, fwd);
  const corners = (n: number, f: number) => [n, f].flatMap((d) => [-1, 1].flatMap((sx) => [-1, 1].map((sy) =>
    vec3.addScaled(vec3.addScaled(vec3.addScaled(cam.position, fwd, d), right, sx * 6 * cam.aspect), up, sy * 6))));
  check('orthographic: each box holds its slice', cs.every((c, i) => corners(i ? cs[i - 1].far : cam.near, c.far).every((p) => inside(c.viewProj, p))));
}
