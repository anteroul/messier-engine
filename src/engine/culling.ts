// Frustum culling: the six planes of a view-projection matrix, and a test of a transformed box against them.
// Works for any projection here (perspective or orthographic, reversed-Z or not): they all map the visible volume
// to -w ≤ x ≤ w, -w ≤ y ≤ w, 0 ≤ z ≤ w.

import type { Mat4, Vec3 } from './math';

/** Six planes, four floats each (a, b, c, d): a point is inside when a·x + b·y + c·z + d ≥ 0 for all of them. */
export type FrustumPlanes = Float32Array;

/**
 * The world-space planes of `viewProj`'s visible volume: left, right, bottom, top, then the two depth planes. Not
 * normalized (boxOutsideFrustum doesn't need it).
 */
export function frustumPlanes(viewProj: Readonly<Mat4>, out: FrustumPlanes = new Float32Array(24)): FrustumPlanes {
  const m = viewProj;
  for (let i = 0; i < 4; i++) {
    // Rows of the column-major matrix: clip.x, clip.y, clip.z and clip.w as functions of the world position.
    const x = m[i * 4], y = m[i * 4 + 1], z = m[i * 4 + 2], w = m[i * 4 + 3];
    out[i] = w + x;
    out[4 + i] = w - x;
    out[8 + i] = w + y;
    out[12 + i] = w - y;
    out[16 + i] = z;
    out[20 + i] = w - z;
  }
  return out;
}

/**
 * Whether the box `min`…`max`, transformed by `world`, lies entirely outside one of the planes. Conservative the
 * usual way: a box near a corner of the frustum can pass while being outside, never the other way around.
 */
export function boxOutsideFrustum(planes: FrustumPlanes, world: Readonly<Mat4>, min: Readonly<Vec3>, max: Readonly<Vec3>): boolean {
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
  const ex = (max[0] - min[0]) / 2, ey = (max[1] - min[1]) / 2, ez = (max[2] - min[2]) / 2;
  const w = world;
  // The box's center in world space.
  const wx = w[0] * cx + w[4] * cy + w[8] * cz + w[12];
  const wy = w[1] * cx + w[5] * cy + w[9] * cz + w[13];
  const wz = w[2] * cx + w[6] * cy + w[10] * cz + w[14];
  for (let p = 0; p < 24; p += 4) {
    const a = planes[p], b = planes[p + 1], c = planes[p + 2];
    // How far the box reaches along the plane's normal: its half extents along its three (transformed) axes.
    const r =
      ex * Math.abs(a * w[0] + b * w[1] + c * w[2]) +
      ey * Math.abs(a * w[4] + b * w[5] + c * w[6]) +
      ez * Math.abs(a * w[8] + b * w[9] + c * w[10]);
    if (a * wx + b * wy + c * wz + planes[p + 3] + r < 0) return true;
  }
  return false;
}

/** Whether the sphere at `center` with `radius` lies entirely outside one of the planes. */
export function sphereOutsideFrustum(planes: FrustumPlanes, center: Readonly<Vec3>, radius: number): boolean {
  for (let p = 0; p < 24; p += 4) {
    const a = planes[p], b = planes[p + 1], c = planes[p + 2];
    // The planes aren't normalized: scale the radius instead of the distance.
    if (a * center[0] + b * center[1] + c * center[2] + planes[p + 3] < -radius * Math.hypot(a, b, c)) return true;
  }
  return false;
}
