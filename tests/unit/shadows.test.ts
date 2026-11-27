import { check, eq } from './harness';
import { Camera } from '@root/src/engine/camera.ts';
import { vec3, type Mat4, type Vec3 } from '@root/src/engine/math.ts';
import { MAX_SHADOW_CASCADES, assignLocalShadows, computeCascades, localShadowViews, type LocalShadowLight } from '@root/src/engine/shadows.ts';
import { frustumPlanes, sphereOutsideFrustum } from '@root/src/engine/culling.ts';

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

// ---- point and spot lights

const clip = (m: Mat4, p: Vec3) => {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w, w];
};
const seen = (m: Mat4, p: Vec3) => {
  const [x, y, z, w] = clip(m, p);
  return w > 0 && Math.abs(x) <= 1 && Math.abs(y) <= 1 && z >= 0 && z <= 1;
};

{
  const spot: LocalShadowLight = { type: 'spot', position: [1, 4, 2], direction: vec3.normalize([0, -1, 0.2]), range: 10, outerAngle: 30 };
  const s = localShadowViews(spot, 3, 1024);
  eq('a spot light takes one layer, where it was told', [s.layer, s.views.length], [3, 1]);
  const along = (d: number, sideways: number) => vec3.addScaled(vec3.addScaled(spot.position as Vec3, spot.direction as Vec3, d), [1, 0, 0], sideways);
  check('a spot light\'s view holds its cone, out to its range', [along(1, 0), along(9.5, 0), along(5, 5 * Math.tan((29 * Math.PI) / 180))].every((p) => seen(s.views[0], p)));
  check('…and nothing behind it or past its range', !seen(s.views[0], along(-1, 0)) && !seen(s.views[0], along(10.5, 0)));
  check('its texel grows with the cone', localShadowViews({ ...spot, outerAngle: 60 }, 0, 1024).texelPerDistance > s.texelPerDistance);

  const point: LocalShadowLight = { type: 'point', position: [0, 2, 0], direction: [0, 0, -1], range: 8, outerAngle: 30 };
  const p = localShadowViews(point, 0, 1024);
  eq('a point light takes six layers', p.views.length, 6);
  // The shader picks a face by the major axis (+x, −x, +y, −y, +z, −z); every direction must land well inside it.
  let worst = 0, bad = 0;
  for (let i = 0; i < 2000; i++) {
    const d = vec3.normalize([Math.sin(i * 12.9898) * 2 - 1, Math.sin(i * 78.233) * 2 - 1, Math.sin(i * 37.719) * 2 - 1]);
    const a = d.map(Math.abs);
    const face = a[0] >= a[1] && a[0] >= a[2] ? (d[0] > 0 ? 0 : 1) : a[1] >= a[2] ? (d[1] > 0 ? 2 : 3) : d[2] > 0 ? 4 : 5;
    const [x, y, z, w] = clip(p.views[face], vec3.addScaled(point.position as Vec3, d, 4));
    worst = Math.max(worst, Math.abs(x), Math.abs(y));
    if (w <= 0 || z < 0 || z > 1) bad++;
  }
  check('every direction lands on its face, with a border for filtering', bad === 0 && worst < 1 - 2 / 1024, `${bad} bad, worst ${worst}`);
}

{
  const cam = camera();
  const planes = frustumPlanes(cam.viewProjection());
  check('spheres outside the view are found', sphereOutsideFrustum(planes, [0, 0, 30], 5) && !sphereOutsideFrustum(planes, [0, 0, 0], 1) &&
    !sphereOutsideFrustum(planes, [0, 0, 18], 9));
  const light = (type: 'point' | 'spot', x: number, z: number, range = 4): LocalShadowLight =>
    ({ type, position: [x, 1, z], direction: [0, -1, 0], range, outerAngle: 30 });
  const lights = [light('point', 0, -10), null, light('point', 0, 0), light('spot', 2, 2), light('point', 2, -2), light('spot', 0, 40), light('spot', -3, -20)];
  const got = assignLocalShadows(lights, cam.position, planes, 12, 1024).map((s) => (s ? s.layer : null));
  // Nearest (to the edge of its range) first: the spot at (2, 2) (layer 0), the point at the origin (1–6), the point at
  // (2, −2) and the far one (7–12 would be needed past what's left: none), the spot at z = −20 (7); none for the one
  // past the camera's view or the light without shadows.
  eq('layers go to visible lights, nearest first, while they fit', got, [null, null, 1, 0, null, null, 7]);
  eq('a light that doesn\'t fit leaves room for smaller ones',
    assignLocalShadows([light('point', 0, 0), light('point', 1, 0), light('spot', 2, -10)], cam.position, planes, 8, 1024).map((s) => (s ? s.layer : null)),
    [null, 0, 6]);
}
