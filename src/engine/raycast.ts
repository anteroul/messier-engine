import { mat4, vec3, type Vec3 } from './math';
import type { Ray } from './camera';
import type { GameObject, Scene } from './scene';
import { VERTEX_STRIDE_FLOATS } from './mesh';
import { Renderer2D } from './shapes2d';

export interface RaycastHit {
  object: GameObject;
  distance: number;
  point: Vec3;
}

/** Slab test. Returns the entry distance or null. */
export function rayAABB(origin: Readonly<Vec3>, dir: Readonly<Vec3>, min: Readonly<Vec3>, max: Readonly<Vec3>): number | null {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-12) {
      if (origin[i] < min[i] || origin[i] > max[i]) return null;
      continue;
    }
    const inv = 1 / dir[i];
    let t1 = (min[i] - origin[i]) * inv;
    let t2 = (max[i] - origin[i]) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return Math.max(tmin, 0);
}

/** Möller–Trumbore, double sided. */
export function rayTriangle(o: Readonly<Vec3>, d: Readonly<Vec3>, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = vec3.sub(b, a), e2 = vec3.sub(c, a);
  const p = vec3.cross(d, e2);
  const det = vec3.dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const s = vec3.sub(o, a);
  const u = vec3.dot(s, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = vec3.cross(s, e1);
  const v = vec3.dot(d, q) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = vec3.dot(e2, q) * inv;
  return t > 1e-6 ? t : null;
}

export function raySphere(origin: Readonly<Vec3>, dir: Readonly<Vec3>, center: Readonly<Vec3>, radius: number): number | null {
  const oc = vec3.sub(origin, center);
  const b = vec3.dot(oc, dir);
  const c = vec3.dot(oc, oc) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -b + Math.sqrt(disc) >= 0 ? 0 : null;
}

/** Ray against one mesh object (AABB pre-test, then exact triangles). `dir` must be normalized. */
export function raycastObject(obj: GameObject, ray: Ray): number | null {
  const mesh = obj.mesh;
  if (!mesh) return null;
  const inv = mat4.invert(obj.worldMatrix);
  if (!inv) return null;
  // Same parameter t in local and world space, because the map is affine.
  const lo = vec3.transformPoint(inv, ray.origin);
  const ld = vec3.transformDir(inv, ray.dir);
  if (rayAABB(lo, ld, mesh.boundsMin, mesh.boundsMax) === null) return null;
  const v = mesh.vertices, idx = mesh.indices;
  const p = (i: number): Vec3 => [v[i * VERTEX_STRIDE_FLOATS], v[i * VERTEX_STRIDE_FLOATS + 1], v[i * VERTEX_STRIDE_FLOATS + 2]];
  let best: number | null = null;
  for (let t = 0; t < idx.length; t += 3) {
    const hit = rayTriangle(lo, ld, p(idx[t]), p(idx[t + 1]), p(idx[t + 2]));
    if (hit !== null && (best === null || hit < best)) best = hit;
  }
  return best;
}

/**
 * Ray against an object's world-space 2D renderers (Shape2D, Text2D): their bounds rectangle on the local XY plane.
 * Screen-space ones aren't in the world; see pickScreen2D().
 */
export function raycast2D(obj: GameObject, ray: Ray): number | null {
  let best: number | null = null;
  for (const r of obj.getComponents(Renderer2D)) {
    if (!r.enabled || r.space !== 'world') continue;
    const inv = mat4.invert(obj.worldMatrix);
    if (!inv) return null;
    const lo = vec3.transformPoint(inv, ray.origin);
    const ld = vec3.transformDir(inv, ray.dir);
    if (Math.abs(ld[2]) < 1e-12) continue;
    const t = -lo[2] / ld[2];
    if (t < 0) continue;
    const x = lo[0] + ld[0] * t, y = lo[1] + ld[1] * t;
    const [x0, y0, x1, y1] = r.localBounds();
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && (best === null || t < best)) best = t;
  }
  return best;
}

/**
 * The topmost visible screen-space 2D renderer whose bounds contain the viewport point (CSS pixels, y down), or null.
 */
export function pickScreen2D(scene: Scene, x: number, y: number, width: number, height: number): Renderer2D | null {
  let best: Renderer2D | null = null;
  const m = new Float32Array(16);
  for (const r of scene.query(Renderer2D)) {
    if (r.space !== 'screen' || (best && r.order < best.order)) continue;
    // Invert the 2D part of the local → pixel map.
    r.targetMatrix(width, height, m);
    const det = m[0] * m[5] - m[1] * m[4];
    if (Math.abs(det) < 1e-12) continue;
    const dx = x - m[12], dy = y - m[13];
    const u = (m[5] * dx - m[4] * dy) / det, v = (m[0] * dy - m[1] * dx) / det;
    const [x0, y0, x1, y1] = r.localBounds();
    // Later ones draw on top at equal order.
    if (u >= x0 && u <= x1 && v >= y0 && v <= y1) best = r;
  }
  return best;
}

/** Closest visible mesh (or world-space 2D) hit in the scene. */
export function raycastScene(scene: Scene, ray: Ray, filter?: (o: GameObject) => boolean): RaycastHit | null {
  let best: RaycastHit | null = null;
  const visit = (o: GameObject) => {
    if (!o.visible) return;
    if ((o.mesh || o.getComponent(Renderer2D)) && (!filter || filter(o))) {
      const t = minHit(raycastObject(o, ray), raycast2D(o, ray));
      if (t !== null && (!best || t < best.distance)) best = { object: o, distance: t, point: vec3.addScaled(ray.origin, ray.dir, t) };
    }
    for (const c of o.children) visit(c);
  };
  for (const c of scene.root.children) visit(c);
  return best;
}

const minHit = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

/** World-space AABB of an object and all its descendants' meshes and world-space 2D renderers, or null if none. */
export function worldBounds(obj: GameObject): { min: Vec3; max: Vec3 } | null {
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  const add = (o: GameObject, lo: Readonly<Vec3>, hi: Readonly<Vec3>) => {
    for (let i = 0; i < 8; i++) {
      const corner: Vec3 = [i & 4 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 1 ? hi[2] : lo[2]];
      const w = vec3.transformPoint(o.worldMatrix, corner);
      min = vec3.min(min, w);
      max = vec3.max(max, w);
    }
    any = true;
  };
  obj.traverse((o) => {
    if (o.mesh) add(o, o.mesh.boundsMin, o.mesh.boundsMax);
    for (const r of o.getComponents(Renderer2D)) {
      if (r.space !== 'world') continue;
      const [x0, y0, x1, y1] = r.localBounds();
      add(o, [x0, y0, 0], [x1, y1, 0]);
    }
  });
  return any ? { min, max } : null;
}
