import { Component } from './component';
import { DEG2RAD, mat4, vec3, type Mat4, type Vec3 } from './math';

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/**
 * Look-at view the renderer draws from (reversed-Z projection: depth 1 at near, 0 at far).
 * The editor's viewport camera is one; a scene's CameraComponent fills one in with applyTo().
 */
export class Camera {
  position: Vec3 = [7, 5, 9];
  target: Vec3 = [0, 0.5, 0];
  up: Vec3 = [0, 1, 0];
  fovDeg = 55;
  near = 0.05;
  far = 500;
  aspect = 16 / 9;
  orthographic = false;
  /** Orthographic: half the visible height in world units. */
  orthoSize = 5;

  view(): Mat4 {
    return mat4.lookAt(this.position, this.target, this.up);
  }

  projection(): Mat4 {
    if (this.orthographic) {
      const h = this.orthoSize, w = h * this.aspect;
      return mat4.orthoReversedZ(-w, w, -h, h, this.near, this.far);
    }
    return mat4.perspectiveReversedZ(this.fovDeg * DEG2RAD, this.aspect, this.near, this.far);
  }

  viewProjection(): Mat4 {
    return mat4.multiply(this.projection(), this.view());
  }

  forward(): Vec3 {
    return vec3.normalize(vec3.sub(this.target, this.position));
  }

  /** World-space ray through a pixel (CSS pixels relative to the viewport). */
  screenRay(x: number, y: number, width: number, height: number): Ray {
    const inv = mat4.invert(this.viewProjection()) ?? mat4.create();
    const nx = (x / width) * 2 - 1;
    const ny = 1 - (y / height) * 2;
    const near = vec3.transformPoint(inv, [nx, ny, 1]);
    const far = vec3.transformPoint(inv, [nx, ny, 0]);
    return { origin: near, dir: vec3.normalize(vec3.sub(far, near)) };
  }

  /** Projects a world point to viewport pixels. Returns null when behind the camera. */
  worldToScreen(p: Readonly<Vec3>, width: number, height: number, viewProj = this.viewProjection()): [number, number] | null {
    const m = viewProj;
    const x = p[0], y = p[1], z = p[2];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 1e-5) return null;
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
    return [((cx + 1) / 2) * width, ((1 - cy) / 2) * height];
  }

  /** Size in world units of one viewport pixel at the given point. */
  worldPerPixel(p: Readonly<Vec3>, viewportHeight: number): number {
    if (this.orthographic) return (2 * this.orthoSize) / Math.max(1, viewportHeight);
    const dist = Math.max(this.near, vec3.dot(vec3.sub(p, this.position), this.forward()));
    return (2 * dist * Math.tan((this.fovDeg * DEG2RAD) / 2)) / Math.max(1, viewportHeight);
  }
}

export type Projection = 'perspective' | 'orthographic';
export const PROJECTIONS: readonly Projection[] = ['perspective', 'orthographic'];

/** Lens settings: the fields copyFrom() copies and scenes save. */
export const CAMERA_FIELDS = ['projection', 'fovDeg', 'orthoSize', 'near', 'far', 'priority'] as const;
type CameraSettings = Pick<CameraComponent, (typeof CAMERA_FIELDS)[number]>;

/**
 * Camera component. Position and orientation come from the owning GameObject:
 * cameras look along the object's local -Z axis with local +Y up (scale is ignored).
 * The engine renders through the scene's active camera (Scene.activeCamera) while
 * Engine.useSceneCamera is set.
 */
export class CameraComponent extends Component {
  projection: Projection = 'perspective';
  /** Perspective: vertical field of view in degrees. */
  fovDeg = 60;
  /** Orthographic: half the visible height in world units. */
  orthoSize = 5;
  near = 0.1;
  far = 500;
  /** The visible camera with the highest priority is the active one (ties go to the first in the hierarchy). */
  priority = 0;

  constructor(init: Partial<CameraSettings> = {}) {
    super();
    Object.assign(this, init);
  }

  copyFrom(c: CameraComponent): this {
    this.projection = c.projection;
    this.fovDeg = c.fovDeg;
    this.orthoSize = c.orthoSize;
    this.near = c.near;
    this.far = c.far;
    this.priority = c.priority;
    return this;
  }

  clone(): CameraComponent {
    const c = new CameraComponent().copyFrom(this);
    c.enabled = this.enabled;
    return c;
  }

  /**
   * Points `view` through this camera, placed by its owner's world matrix.
   * `target` is put `focusDistance` ahead (the renderer centers the shadow map on it).
   */
  applyTo(view: Camera, world: Mat4, focusDistance = 10): Camera {
    const pos: Vec3 = [world[12], world[13], world[14]];
    const forward = vec3.normalize(vec3.transformDir(world, [0, 0, -1]));
    const up = vec3.normalize(vec3.transformDir(world, [0, 1, 0]));
    view.position = pos;
    view.target = vec3.addScaled(pos, forward, focusDistance);
    view.up = vec3.length(up) > 0 ? up : [0, 1, 0];
    view.orthographic = this.projection === 'orthographic';
    view.fovDeg = Math.min(179, Math.max(0.1, this.fovDeg));
    view.orthoSize = Math.max(1e-3, this.orthoSize);
    view.near = Math.max(1e-4, this.near);
    view.far = Math.max(view.near * 1.001, this.far);
    return view;
  }
}
