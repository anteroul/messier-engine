import { vec3, type Vec3, type Vec4 } from './math';
import type { Camera } from './camera';

/** Floats per overlay vertex: position(3) + color(4). */
export const OVERLAY_STRIDE_FLOATS = 7;

/**
 * Immediate-mode builder for editor helper geometry. Lines are expanded on the
 * CPU into camera-facing ribbons with a constant on-screen pixel width.
 * `depth` geometry is occluded by the scene; `top` geometry is always visible.
 */
export class OverlayBuilder {
  readonly depth: number[] = [];
  readonly top: number[] = [];
  private camera: Camera | null = null;
  private viewportHeight = 1;

  begin(camera: Camera, viewportHeight: number): void {
    this.depth.length = 0;
    this.top.length = 0;
    this.camera = camera;
    this.viewportHeight = viewportHeight;
  }

  get isEmpty(): boolean {
    return this.depth.length === 0 && this.top.length === 0;
  }

  pixelSize(p: Readonly<Vec3>): number {
    return this.camera ? this.camera.worldPerPixel(p, this.viewportHeight) : 0.01;
  }

  triangle(a: Readonly<Vec3>, b: Readonly<Vec3>, c: Readonly<Vec3>, color: Readonly<Vec4>, onTop = false): void {
    const out = onTop ? this.top : this.depth;
    for (const p of [a, b, c]) out.push(p[0], p[1], p[2], color[0], color[1], color[2], color[3]);
  }

  /** Line segment with a constant on-screen width in pixels. */
  line(a: Readonly<Vec3>, b: Readonly<Vec3>, color: Readonly<Vec4>, widthPx = 2, onTop = false): void {
    if (!this.camera) return;
    const cam = this.camera.position;
    const dir = vec3.sub(b, a);
    if (vec3.length(dir) < 1e-9) return;
    const sideAt = (p: Readonly<Vec3>) => {
      let side = vec3.cross(dir, vec3.sub(cam, p));
      if (vec3.length(side) < 1e-9) side = vec3.cross(dir, [0, 1, 0]);
      return vec3.scale(vec3.normalize(side), (this.pixelSize(p) * widthPx) / 2);
    };
    const sa = sideAt(a), sb = sideAt(b);
    const a0 = vec3.sub(a, sa), a1 = vec3.add(a, sa);
    const b0 = vec3.sub(b, sb), b1 = vec3.add(b, sb);
    this.triangle(a0, a1, b1, color, onTop);
    this.triangle(a0, b1, b0, color, onTop);
  }

  polyline(points: Readonly<Vec3>[], color: Readonly<Vec4>, widthPx = 2, onTop = false, closed = false): void {
    for (let i = 0; i < points.length - 1; i++) this.line(points[i], points[i + 1], color, widthPx, onTop);
    if (closed && points.length > 2) this.line(points[points.length - 1], points[0], color, widthPx, onTop);
  }

  /** Circle in the plane perpendicular to `normal`. */
  circle(center: Readonly<Vec3>, normal: Readonly<Vec3>, radius: number, color: Readonly<Vec4>, widthPx = 2, onTop = false, segments = 64): void {
    this.polyline(circlePoints(center, normal, radius, segments), color, widthPx, onTop, true);
  }

  cone(base: Readonly<Vec3>, tip: Readonly<Vec3>, radius: number, color: Readonly<Vec4>, onTop = false, segments = 12): void {
    const axis = vec3.sub(tip, base);
    const ring = circlePoints(base, axis, radius, segments);
    for (let i = 0; i < segments; i++) {
      const p0 = ring[i], p1 = ring[(i + 1) % segments];
      this.triangle(p0, p1, tip, color, onTop);
      this.triangle(p1, p0, base, color, onTop);
    }
  }

  /** Axis-aligned cube centered at `center`. */
  cube(center: Readonly<Vec3>, half: number, color: Readonly<Vec4>, onTop = false): void {
    const c = (sx: number, sy: number, sz: number): Vec3 => [center[0] + sx * half, center[1] + sy * half, center[2] + sz * half];
    const quads: Vec3[][] = [
      [c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1)],
      [c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1)],
      [c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1)],
      [c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)],
      [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)],
      [c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1), c(1, -1, -1)],
    ];
    for (const q of quads) {
      this.triangle(q[0], q[1], q[2], color, onTop);
      this.triangle(q[0], q[2], q[3], color, onTop);
    }
  }

  /** Small octahedron, used as a light icon. */
  diamond(center: Readonly<Vec3>, radius: number, color: Readonly<Vec4>, onTop = false): void {
    const [x, y, z] = center;
    const pts: Vec3[] = [[x + radius, y, z], [x, y, z + radius], [x - radius, y, z], [x, y, z - radius]];
    const top: Vec3 = [x, y + radius, z], bottom: Vec3 = [x, y - radius, z];
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      this.triangle(a, b, top, color, onTop);
      this.triangle(b, a, bottom, color, onTop);
    }
  }

  /** Wireframe box from 8 corners ordered as produced by boxCorners(). */
  wireBox(corners: Vec3[], color: Readonly<Vec4>, widthPx = 1.5, onTop = false): void {
    const edges = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, b] of edges) this.line(corners[a], corners[b], color, widthPx, onTop);
  }
}

export function boxCorners(min: Readonly<Vec3>, max: Readonly<Vec3>): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) out.push([i & 4 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 1 ? max[2] : min[2]]);
  return out;
}

export function circlePoints(center: Readonly<Vec3>, normal: Readonly<Vec3>, radius: number, segments: number): Vec3[] {
  const n = vec3.normalize(normal);
  const ref: Vec3 = Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const u = vec3.normalize(vec3.cross(n, ref));
  const v = vec3.cross(n, u);
  const pts: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(vec3.add(center, vec3.add(vec3.scale(u, Math.cos(a) * radius), vec3.scale(v, Math.sin(a) * radius))));
  }
  return pts;
}
