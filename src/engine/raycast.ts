import { mat4, vec3, type Vec3 } from './math';
import type { Ray } from './camera';
import type { GameObject, Scene } from './scene';
import { VERTEX_STRIDE_FLOATS } from './mesh';

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

/** Closest visible mesh hit in the scene. */
export function raycastScene(scene: Scene, ray: Ray, filter?: (o: GameObject) => boolean): RaycastHit | null {
  let best: RaycastHit | null = null;
  const visit = (o: GameObject) => {
    if (!o.visible) return;
    if (o.mesh && (!filter || filter(o))) {
      const t = raycastObject(o, ray);
      if (t !== null && (!best || t < best.distance)) best = { object: o, distance: t, point: vec3.addScaled(ray.origin, ray.dir, t) };
    }
    for (const c of o.children) visit(c);
  };
  for (const c of scene.root.children) visit(c);
  return best;
}

/** World-space AABB of an object and all its descendants' meshes, or null if none. */
export function worldBounds(obj: GameObject): { min: Vec3; max: Vec3 } | null {
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  obj.traverse((o) => {
    if (!o.mesh) return;
    const m = o.mesh;
    for (let i = 0; i < 8; i++) {
      const corner: Vec3 = [i & 4 ? m.boundsMax[0] : m.boundsMin[0], i & 2 ? m.boundsMax[1] : m.boundsMin[1], i & 1 ? m.boundsMax[2] : m.boundsMin[2]];
      const w = vec3.transformPoint(o.worldMatrix, corner);
      min = vec3.min(min, w);
      max = vec3.max(max, w);
    }
    any = true;
  });
  return any ? { min, max } : null;
}
