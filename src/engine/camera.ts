import { DEG2RAD, mat4, vec3, type Mat4, type Vec3 } from './math';

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/** Perspective look-at camera (reversed-Z projection: depth 1 at near, 0 at far). */
export class Camera {
  position: Vec3 = [7, 5, 9];
  target: Vec3 = [0, 0.5, 0];
  up: Vec3 = [0, 1, 0];
  fovDeg = 55;
  near = 0.05;
  far = 500;
  aspect = 16 / 9;

  view(): Mat4 {
    return mat4.lookAt(this.position, this.target, this.up);
  }

  projection(): Mat4 {
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
    const dist = Math.max(this.near, vec3.dot(vec3.sub(p, this.position), this.forward()));
    return (2 * dist * Math.tan((this.fovDeg * DEG2RAD) / 2)) / Math.max(1, viewportHeight);
  }
}
