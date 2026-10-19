import {
  DEG2RAD,
  circlePoints,
  quat,
  vec3,
  type Camera,
  type GameObject,
  type OverlayBuilder,
  type Quat,
  type Ray,
  type Vec3,
  type Vec4,
} from '../engine';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

/** Handle ids: 0/1/2 = X/Y/Z axis, 3 = center (screen-plane move / uniform scale). */
export type Handle = 0 | 1 | 2 | 3;

const AXES: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const AXIS_COLORS: Vec4[] = [[0.95, 0.3, 0.32, 1], [0.45, 0.85, 0.3, 1], [0.32, 0.55, 1, 1]];
const HOVER_COLOR: Vec4 = [1, 0.85, 0.25, 1];
const CENTER_COLOR: Vec4 = [0.92, 0.92, 0.95, 0.9];
const GIZMO_PIXELS = 110;
const PICK_TOLERANCE_PX = 9;

interface DragState {
  handle: Handle;
  axis: Vec3;
  startPos: Vec3;
  startRot: Quat;
  startScale: Vec3;
  startParam: number;
  startHit: Vec3 | null;
  startMouse: [number, number];
  size: number;
  planeNormal: Vec3;
  edgeOn: boolean;
  lastAngle: number;
}

function distToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
}

/** Parameter s of the point on line (o + s*d) closest to the ray. */
function closestLineParam(o: Vec3, d: Vec3, ray: Ray): number | null {
  const w0 = vec3.sub(o, ray.origin);
  const a = vec3.dot(d, d), b = vec3.dot(d, ray.dir), c = vec3.dot(ray.dir, ray.dir);
  const dd = vec3.dot(d, w0), e = vec3.dot(ray.dir, w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-8) return null;
  return (b * e - c * dd) / denom;
}

function rayPlane(ray: Ray, point: Vec3, normal: Vec3): Vec3 | null {
  const denom = vec3.dot(ray.dir, normal);
  if (Math.abs(denom) < 1e-6) return null;
  const t = vec3.dot(vec3.sub(point, ray.origin), normal) / denom;
  return t >= 0 ? vec3.addScaled(ray.origin, ray.dir, t) : null;
}

const snapTo = (v: number, step: number) => Math.round(v / step) * step;

/** Translate / rotate / scale manipulator drawn into the editor overlay. */
export class Gizmo {
  mode: GizmoMode = 'translate';
  snap = false;
  translateStep = 0.25;
  rotateStepDeg = 15;
  scaleStep = 0.1;
  hover: Handle | null = null;
  private drag: DragState | null = null;

  constructor(private readonly camera: Camera) {}

  get dragging(): boolean {
    return this.drag !== null;
  }

  private axesFor(obj: GameObject): Vec3[] {
    if (this.mode !== 'scale') return AXES;
    const m = obj.worldMatrix;
    return [
      vec3.normalize([m[0], m[1], m[2]]),
      vec3.normalize([m[4], m[5], m[6]]),
      vec3.normalize([m[8], m[9], m[10]]),
    ].map((a, i) => (vec3.length(a) > 0 ? a : AXES[i]));
  }

  private gizmoSize(center: Vec3, viewportHeight: number): number {
    return this.camera.worldPerPixel(center, viewportHeight) * GIZMO_PIXELS;
  }

  /** Returns the handle under the cursor (viewport pixels), if any. */
  pick(obj: GameObject, mx: number, my: number, vw: number, vh: number): Handle | null {
    const center = obj.worldPosition();
    const vp = this.camera.viewProjection();
    const sc = this.camera.worldToScreen(center, vw, vh, vp);
    if (!sc) return null;
    const m: [number, number] = [mx, my];
    const size = this.gizmoSize(center, vh);
    const axes = this.axesFor(obj);
    let best: Handle | null = null;
    let bestDist = PICK_TOLERANCE_PX;

    if (this.mode === 'rotate') {
      axes.forEach((axis, i) => {
        const pts = circlePoints(center, axis, size * 0.9, 48).map((p) => this.camera.worldToScreen(p, vw, vh, vp));
        for (let k = 0; k < pts.length; k++) {
          const a = pts[k], b = pts[(k + 1) % pts.length];
          if (!a || !b) continue;
          const d = distToSegment(m, a, b);
          if (d < bestDist) {
            bestDist = d;
            best = i as Handle;
          }
        }
      });
      return best;
    }

    if (Math.hypot(mx - sc[0], my - sc[1]) < PICK_TOLERANCE_PX + 2) return 3;
    axes.forEach((axis, i) => {
      const end = this.camera.worldToScreen(vec3.addScaled(center, axis, size), vw, vh, vp);
      if (!end) return;
      const d = distToSegment(m, sc, end);
      if (d < bestDist) {
        bestDist = d;
        best = i as Handle;
      }
    });
    return best;
  }

  begin(handle: Handle, obj: GameObject, ray: Ray, mx: number, my: number, vh: number): void {
    const center = obj.worldPosition();
    const axes = this.axesFor(obj);
    const axis = handle === 3 ? vec3.scale(this.camera.forward(), -1) : axes[handle];
    const size = this.gizmoSize(center, vh);
    const planeNormal = handle === 3 || this.mode !== 'rotate' ? vec3.scale(this.camera.forward(), -1) : axis;
    const edgeOn = this.mode === 'rotate' && Math.abs(vec3.dot(ray.dir, axis)) < 0.08;
    const startHit = rayPlane(ray, center, planeNormal);
    this.drag = {
      handle,
      axis,
      startPos: center,
      startRot: obj.worldRotation(),
      startScale: vec3.clone(obj.transform.scale),
      startParam: handle === 3 ? 0 : closestLineParam(center, axis, ray) ?? 0,
      startHit,
      startMouse: [mx, my],
      size,
      planeNormal,
      edgeOn,
      lastAngle: 0,
    };
  }

  update(obj: GameObject, ray: Ray, mx: number, my: number): void {
    const d = this.drag;
    if (!d) return;
    if (this.mode === 'translate') {
      let next: Vec3 | null = null;
      if (d.handle === 3) {
        const hit = rayPlane(ray, d.startPos, d.planeNormal);
        if (hit && d.startHit) {
          next = vec3.add(d.startPos, vec3.sub(hit, d.startHit));
          if (this.snap) next = next.map((c) => snapTo(c, this.translateStep)) as Vec3;
        }
      } else {
        const s = closestLineParam(d.startPos, d.axis, ray);
        if (s !== null) {
          let delta = s - d.startParam;
          if (this.snap) delta = snapTo(delta, this.translateStep);
          next = vec3.addScaled(d.startPos, d.axis, delta);
        }
      }
      if (next) obj.setWorldPosition(next);
    } else if (this.mode === 'rotate') {
      let angle: number;
      if (d.edgeOn || !d.startHit) {
        angle = (mx - d.startMouse[0]) * 0.01;
      } else {
        const hit = rayPlane(ray, d.startPos, d.planeNormal);
        if (!hit) return;
        const v0 = vec3.normalize(vec3.sub(d.startHit, d.startPos));
        const v1 = vec3.normalize(vec3.sub(hit, d.startPos));
        const raw = Math.atan2(vec3.dot(vec3.cross(v0, v1), d.axis), vec3.dot(v0, v1));
        // Unwrap so continuous dragging past 180° keeps accumulating.
        let a = raw;
        while (a - d.lastAngle > Math.PI) a -= Math.PI * 2;
        while (a - d.lastAngle < -Math.PI) a += Math.PI * 2;
        angle = a;
      }
      d.lastAngle = angle;
      if (this.snap) angle = snapTo(angle, this.rotateStepDeg * DEG2RAD);
      obj.setWorldRotation(quat.multiply(quat.fromAxisAngle(d.axis, angle), d.startRot));
    } else {
      const scale = vec3.clone(d.startScale);
      if (d.handle === 3) {
        const f = Math.max(0.01, 1 + (mx - d.startMouse[0] - (my - d.startMouse[1])) / 150);
        for (let i = 0; i < 3; i++) scale[i] = this.snap ? snapTo(d.startScale[i] * f, this.scaleStep) || this.scaleStep : d.startScale[i] * f;
      } else {
        const s = closestLineParam(d.startPos, d.axis, ray);
        if (s === null) return;
        const f = 1 + (s - d.startParam) / d.size;
        let v = d.startScale[d.handle] * f;
        if (this.snap) v = snapTo(v, this.scaleStep);
        scale[d.handle] = Math.abs(v) < 1e-3 ? 1e-3 : v;
      }
      obj.transform.scale = scale;
    }
  }

  end(): void {
    this.drag = null;
  }

  draw(overlay: OverlayBuilder, obj: GameObject, viewportHeight: number): void {
    const center = obj.worldPosition();
    const size = this.gizmoSize(center, viewportHeight);
    const axes = this.axesFor(obj);
    const active = this.drag?.handle ?? this.hover;
    const colorFor = (i: number) => (active === i ? HOVER_COLOR : AXIS_COLORS[i]);

    if (this.mode === 'rotate') {
      // Silhouette ring facing the camera.
      overlay.circle(center, vec3.sub(this.camera.position, center), size * 0.9, [1, 1, 1, 0.18], 1.5, true);
      axes.forEach((axis, i) => {
        if (this.drag && this.drag.handle !== i) return;
        overlay.circle(center, axis, size * 0.9, colorFor(i), active === i ? 4 : 2.5, true);
      });
      if (this.drag?.startHit && !this.drag.edgeOn) {
        const start = vec3.addScaled(center, vec3.normalize(vec3.sub(this.drag.startHit, center)), size * 0.9);
        overlay.line(center, start, [1, 1, 1, 0.6], 1.5, true);
      }
      return;
    }

    axes.forEach((axis, i) => {
      if (this.drag && this.drag.handle !== i && this.drag.handle !== 3) return;
      const color = colorFor(i);
      const width = active === i ? 4 : 2.5;
      if (this.mode === 'translate') {
        overlay.line(center, vec3.addScaled(center, axis, size * 0.8), color, width, true);
        overlay.cone(vec3.addScaled(center, axis, size * 0.78), vec3.addScaled(center, axis, size * 1.02), size * 0.055, color, true);
      } else {
        overlay.line(center, vec3.addScaled(center, axis, size * 0.92), color, width, true);
        overlay.cube(vec3.addScaled(center, axis, size * 0.95), size * 0.045, color, true);
      }
      if (this.drag && this.drag.handle === i) {
        // Infinite-ish guide line for the active axis.
        overlay.line(vec3.addScaled(center, axis, -size * 20), vec3.addScaled(center, axis, size * 20), [color[0], color[1], color[2], 0.35], 1, true);
      }
    });
    overlay.cube(center, size * 0.05, active === 3 ? HOVER_COLOR : CENTER_COLOR, true);
  }
}
