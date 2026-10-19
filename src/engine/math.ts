// Minimal linear algebra for the engine. Matrices are column-major Float32Arrays
// (WGSL / WebGPU layout). Clip-space depth is in [0, 1] (WebGPU convention).

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
export type Quat = [number, number, number, number];
export type Mat4 = Float32Array<ArrayBuffer>;

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export const vec3 = {
  create(x = 0, y = 0, z = 0): Vec3 {
    return [x, y, z];
  },
  clone(a: Readonly<Vec3>): Vec3 {
    return [a[0], a[1], a[2]];
  },
  add(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  },
  sub(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  },
  scale(a: Readonly<Vec3>, s: number): Vec3 {
    return [a[0] * s, a[1] * s, a[2] * s];
  },
  mul(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
    return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
  },
  addScaled(a: Readonly<Vec3>, b: Readonly<Vec3>, s: number): Vec3 {
    return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  },
  dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  },
  cross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  },
  length(a: Readonly<Vec3>): number {
    return Math.hypot(a[0], a[1], a[2]);
  },
  distance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  },
  normalize(a: Readonly<Vec3>): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  },
  lerp(a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  },
  min(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  },
  max(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
    return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  },
  /** Transforms a point (w = 1) with perspective divide. */
  transformPoint(m: Mat4, v: Readonly<Vec3>): Vec3 {
    const x = v[0], y = v[1], z = v[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    return [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    ];
  },
  /** Transforms a direction (w = 0). */
  transformDir(m: Mat4, v: Readonly<Vec3>): Vec3 {
    const x = v[0], y = v[1], z = v[2];
    return [
      m[0] * x + m[4] * y + m[8] * z,
      m[1] * x + m[5] * y + m[9] * z,
      m[2] * x + m[6] * y + m[10] * z,
    ];
  },
  equals(a: Readonly<Vec3>, b: Readonly<Vec3>, eps = 1e-6): boolean {
    return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;
  },
};

export const quat = {
  identity(): Quat {
    return [0, 0, 0, 1];
  },
  clone(q: Readonly<Quat>): Quat {
    return [q[0], q[1], q[2], q[3]];
  },
  /** Hamilton product a * b (apply b first, then a). */
  multiply(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  },
  normalize(q: Readonly<Quat>): Quat {
    const l = Math.hypot(q[0], q[1], q[2], q[3]);
    return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
  },
  invert(q: Readonly<Quat>): Quat {
    const d = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] || 1;
    return [-q[0] / d, -q[1] / d, -q[2] / d, q[3] / d];
  },
  fromAxisAngle(axis: Readonly<Vec3>, rad: number): Quat {
    const n = vec3.normalize(axis);
    const s = Math.sin(rad / 2);
    return [n[0] * s, n[1] * s, n[2] * s, Math.cos(rad / 2)];
  },
  /** Euler angles in degrees, XYZ order (rotation matrix = Rx * Ry * Rz). */
  fromEulerDeg(x: number, y: number, z: number): Quat {
    const c1 = Math.cos((x * DEG2RAD) / 2), s1 = Math.sin((x * DEG2RAD) / 2);
    const c2 = Math.cos((y * DEG2RAD) / 2), s2 = Math.sin((y * DEG2RAD) / 2);
    const c3 = Math.cos((z * DEG2RAD) / 2), s3 = Math.sin((z * DEG2RAD) / 2);
    return [
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3,
    ];
  },
  /** Inverse of fromEulerDeg. */
  toEulerDeg(q: Readonly<Quat>): Vec3 {
    const m = mat4.fromTRS([0, 0, 0], q, [1, 1, 1]);
    const m11 = m[0], m12 = m[4], m13 = m[8];
    const m22 = m[5], m23 = m[9];
    const m32 = m[6], m33 = m[10];
    const y = Math.asin(clamp(m13, -1, 1));
    let x: number, z: number;
    if (Math.abs(m13) < 0.9999999) {
      x = Math.atan2(-m23, m33);
      z = Math.atan2(-m12, m11);
    } else {
      x = Math.atan2(m32, m22);
      z = 0;
    }
    return [x * RAD2DEG, y * RAD2DEG, z * RAD2DEG];
  },
  rotateVec3(q: Readonly<Quat>, v: Readonly<Vec3>): Vec3 {
    const u: Vec3 = [q[0], q[1], q[2]];
    const t = vec3.scale(vec3.cross(u, v), 2);
    return vec3.add(vec3.addScaled(v, t, q[3]), vec3.cross(u, t));
  },
  /** Rotation part of a (possibly scaled) matrix. Columns must already be normalized. */
  fromRotationMatrix(m: Mat4): Quat {
    const m11 = m[0], m12 = m[4], m13 = m[8];
    const m21 = m[1], m22 = m[5], m23 = m[9];
    const m31 = m[2], m32 = m[6], m33 = m[10];
    const trace = m11 + m22 + m33;
    let x: number, y: number, z: number, w: number;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      w = 0.25 / s;
      x = (m32 - m23) * s;
      y = (m13 - m31) * s;
      z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
      w = (m32 - m23) / s;
      x = 0.25 * s;
      y = (m12 + m21) / s;
      z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
      w = (m13 - m31) / s;
      x = (m12 + m21) / s;
      y = 0.25 * s;
      z = (m23 + m32) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
      w = (m21 - m12) / s;
      x = (m13 + m31) / s;
      y = (m23 + m32) / s;
      z = 0.25 * s;
    }
    return quat.normalize([x, y, z, w]);
  },
  /** Rotation that maps the -Z axis onto `dir`. */
  lookRotation(dir: Readonly<Vec3>, up: Readonly<Vec3> = [0, 1, 0]): Quat {
    const f = vec3.normalize(dir);
    let u = Math.abs(vec3.dot(f, up)) > 0.999 ? ([1, 0, 0] as Vec3) : vec3.clone(up);
    const r = vec3.normalize(vec3.cross(f, u));
    u = vec3.cross(r, f);
    const m = mat4.create();
    m[0] = r[0]; m[1] = r[1]; m[2] = r[2];
    m[4] = u[0]; m[5] = u[1]; m[6] = u[2];
    m[8] = -f[0]; m[9] = -f[1]; m[10] = -f[2];
    return quat.fromRotationMatrix(m);
  },
};

export const mat4 = {
  create(): Mat4 {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },
  clone(a: Mat4): Mat4 {
    return new Float32Array(a);
  },
  /** out = a * b */
  multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
    const r = out === a || out === b ? new Float32Array(16) : out;
    for (let c = 0; c < 4; c++) {
      for (let row = 0; row < 4; row++) {
        r[c * 4 + row] =
          a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
      }
    }
    if (r !== out) out.set(r);
    return out;
  },
  fromTRS(t: Readonly<Vec3>, q: Readonly<Quat>, s: Readonly<Vec3>, out: Mat4 = new Float32Array(16)): Mat4 {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const [sx, sy, sz] = s;
    out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
    out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
    out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
    out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
    return out;
  },
  invert(a: Mat4, out: Mat4 = new Float32Array(16)): Mat4 | null {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  },
  transpose(a: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
    const r = out === a ? new Float32Array(a) : a;
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) out[c * 4 + row] = r[row * 4 + c];
    return out;
  },
  /** Inverse-transpose of the upper 3x3, stored in a mat4 with zero translation. */
  normalMatrix(m: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
    const inv = mat4.invert(m) ?? mat4.create();
    mat4.transpose(inv, out);
    out[3] = out[7] = out[11] = 0;
    out[12] = out[13] = out[14] = 0;
    out[15] = 1;
    return out;
  },
  /** Right-handed perspective projection with depth range [0, 1]. */
  perspective(fovYRad: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovYRad / 2);
    const nf = 1 / (near - far);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = far * nf;
    out[11] = -1;
    out[14] = far * near * nf;
    return out;
  },
  /**
   * Reversed-Z perspective (near -> depth 1, far -> depth 0). Paired with a
   * float depth buffer and a 'greater' depth test this gives near-uniform depth
   * precision, so coplanar-ish surfaces (grid on floor) don't z-fight.
   */
  perspectiveReversedZ(fovYRad: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovYRad / 2);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = near / (far - near);
    out[11] = -1;
    out[14] = (far * near) / (far - near);
    return out;
  },
  /** Right-handed orthographic projection with depth range [0, 1]. */
  ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
    const lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f);
    const out = new Float32Array(16);
    out[0] = -2 * lr;
    out[5] = -2 * bt;
    out[10] = nf;
    out[12] = (l + r) * lr;
    out[13] = (t + b) * bt;
    out[14] = n * nf;
    out[15] = 1;
    return out;
  },
  lookAt(eye: Readonly<Vec3>, target: Readonly<Vec3>, up: Readonly<Vec3>): Mat4 {
    const z = vec3.normalize(vec3.sub(eye, target));
    let x = vec3.normalize(vec3.cross(up, z));
    if (vec3.length(x) === 0) x = vec3.normalize(vec3.cross([0, 0, 1], z));
    const y = vec3.cross(z, x);
    const out = new Float32Array(16);
    out[0] = x[0]; out[1] = y[0]; out[2] = z[0];
    out[4] = x[1]; out[5] = y[1]; out[6] = z[1];
    out[8] = x[2]; out[9] = y[2]; out[10] = z[2];
    out[12] = -vec3.dot(x, eye);
    out[13] = -vec3.dot(y, eye);
    out[14] = -vec3.dot(z, eye);
    out[15] = 1;
    return out;
  },
  getTranslation(m: Mat4): Vec3 {
    return [m[12], m[13], m[14]];
  },
  /** Splits an affine matrix into translation, rotation and scale (no shear). */
  decompose(m: Mat4): { t: Vec3; r: Quat; s: Vec3 } {
    let sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    const det =
      m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    if (det < 0) sx = -sx;
    const r = new Float32Array(m);
    const isx = sx ? 1 / sx : 0, isy = sy ? 1 / sy : 0, isz = sz ? 1 / sz : 0;
    r[0] *= isx; r[1] *= isx; r[2] *= isx;
    r[4] *= isy; r[5] *= isy; r[6] *= isy;
    r[8] *= isz; r[9] *= isz; r[10] *= isz;
    return { t: [m[12], m[13], m[14]], r: quat.fromRotationMatrix(r), s: [sx, sy, sz] };
  },
};

// ---------------------------------------------------------------------------
// Color helpers. Engine colors are linear; UI color pickers are sRGB hex.

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function hexToLinear(hex: string): Vec3 {
  const v = parseInt(hex.replace('#', ''), 16);
  return [srgbToLinear(((v >> 16) & 255) / 255), srgbToLinear(((v >> 8) & 255) / 255), srgbToLinear((v & 255) / 255)];
}

export function linearToHex(c: Readonly<Vec3>): string {
  const to = (x: number) =>
    Math.round(clamp(linearToSrgb(clamp(x, 0, 1)), 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`;
}

/** Display-space (no gamma conversion) hex helpers, e.g. for clear colors. */
export function hexToRgb(hex: string): Vec3 {
  const v = parseInt(hex.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToHex(c: Readonly<Vec3>): string {
  return '#' + [0, 1, 2].map((i) => Math.round(clamp(c[i], 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}

export function hsvToRgb(h: number, s: number, v: number): Vec3 {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}
