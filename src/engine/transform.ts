import { mat4, quat, type Mat4, type Quat, type Vec3 } from './math';
import type { GameObject } from './scene';

/** Local position, rotation and scale as plain values (undo snapshots, resets). */
export interface LocalTRS {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

const IDENTITY: LocalTRS = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
export const IDENTITY_TRS: Readonly<LocalTRS> = Object.freeze(IDENTITY);

// Scratch storage for the allocation-free paths. Nothing here survives a call.
const scratchMat = mat4.create();
const scratchMat2 = mat4.create();
const scratchQuat: Quat = [0, 0, 0, 1];

/**
 * Position, rotation and scale of a GameObject relative to its parent, plus the hierarchy itself.
 *
 * World matrices are cached and computed lazily. Each transform remembers the local values it last baked into its
 * matrix and the version of its parent's world matrix it was computed against, so a change anywhere above it makes
 * it stale without walking the subtree. In-place edits (`transform.position[1] = y`) are noticed by comparing the
 * 10 local values with the baked copy, so they work as well as assignments.
 */
export class Transform {
  readonly gameObject: GameObject;

  private _position: Vec3 = [0, 0, 0];
  private _rotation: Quat = [0, 0, 0, 1];
  private _scale: Vec3 = [1, 1, 1];

  private _parent: Transform | null = null;
  private readonly _children: Transform[] = [];

  private readonly _local = mat4.create();
  private readonly _world = mat4.create();
  private readonly _normal = mat4.create();
  // Local values baked into _local. NaN forces the first bake.
  private readonly _baked = new Float64Array(10).fill(NaN);
  // Set by setters and reparenting; in-place edits are found through _baked instead.
  private _dirty = true;
  private _worldVersion = 0;
  private _parentVersion = -1;
  private _normalVersion = -1;

  constructor(gameObject: GameObject) {
    this.gameObject = gameObject;
  }

  // ---- local values

  /** Local position. Assigning stores the array; editing it in place also works. */
  get position(): Vec3 {
    return this._position;
  }
  set position(v: Vec3) {
    this._position = v;
    this._dirty = true;
  }

  /** Local rotation quaternion [x, y, z, w]. */
  get rotation(): Quat {
    return this._rotation;
  }
  set rotation(q: Quat) {
    this._rotation = q;
    this._dirty = true;
  }

  get scale(): Vec3 {
    return this._scale;
  }
  set scale(v: Vec3) {
    this._scale = v;
    this._dirty = true;
  }

  setEulerDeg(x: number, y: number, z: number): this {
    this.rotation = quat.fromEulerDeg(x, y, z);
    return this;
  }

  getEulerDeg(): Vec3 {
    return quat.toEulerDeg(this._rotation);
  }

  /** Copies local values (from another transform or a LocalTRS snapshot). */
  copyFrom(t: Readonly<LocalTRS>): this {
    this.position = [t.position[0], t.position[1], t.position[2]];
    this.rotation = [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]];
    this.scale = [t.scale[0], t.scale[1], t.scale[2]];
    return this;
  }

  /** The local values as a detached copy. */
  snapshot(): LocalTRS {
    return { position: [...this._position], rotation: [...this._rotation], scale: [...this._scale] };
  }

  // ---- hierarchy

  get parent(): Transform | null {
    return this._parent;
  }

  get children(): readonly Transform[] {
    return this._children;
  }

  get root(): Transform {
    let t: Transform = this;
    while (t._parent) t = t._parent;
    return t;
  }

  isAncestorOf(other: Transform): boolean {
    for (let p = other._parent; p; p = p._parent) if (p === this) return true;
    return false;
  }

  /**
   * Moves this transform under `parent` (null detaches it) at `index` among its children (default: last).
   * With keepWorldTransform (the default) the local values are recomputed so the object stays where it is in the
   * world; otherwise the local values are kept and the object moves with its new parent.
   */
  setParent(parent: Transform | null, keepWorldTransform = true, index?: number): void {
    if (parent && (parent === this || this.isAncestorOf(parent))) throw new Error('Cannot parent an object to itself or its own descendant');
    if (keepWorldTransform) scratchMat2.set(this.worldMatrix);
    const old = this._parent;
    if (old) {
      const i = old._children.indexOf(this);
      old._children.splice(i, 1);
      childList(old.gameObject).splice(i, 1);
    }
    this._parent = parent;
    if (parent) {
      const at = index === undefined ? parent._children.length : Math.max(0, Math.min(index, parent._children.length));
      parent._children.splice(at, 0, this);
      childList(parent.gameObject).splice(at, 0, this.gameObject);
    }
    this._dirty = true;
    if (keepWorldTransform && parent) {
      const inv = mat4.invert(parent.worldMatrix, scratchMat) ?? mat4.create();
      const { t, r, s } = mat4.decompose(mat4.multiply(inv, scratchMat2, scratchMat));
      this.position = t;
      this.rotation = r;
      this.scale = s;
    } else if (keepWorldTransform) {
      const { t, r, s } = mat4.decompose(scratchMat2);
      this.position = t;
      this.rotation = r;
      this.scale = s;
    }
    this.gameObject._parentChanged(old?.gameObject ?? null);
  }

  // ---- matrices

  /** Local TRS matrix (cached; don't modify). */
  get localMatrix(): Mat4 {
    this._syncLocal();
    return this._local;
  }

  /** World matrix (cached; don't modify). Always current, even mid-frame right after an edit. */
  get worldMatrix(): Mat4 {
    this._validate();
    return this._world;
  }

  /** Inverse-transpose of the world matrix's 3×3, for transforming normals (cached; don't modify). */
  get normalMatrix(): Mat4 {
    this._validate();
    if (this._normalVersion !== this._worldVersion) {
      const inv = mat4.invert(this._world, scratchMat);
      if (inv) mat4.transpose(inv, this._normal);
      else this._normal.set(IDENTITY_MAT);
      const n = this._normal;
      n[3] = n[7] = n[11] = n[12] = n[13] = n[14] = 0;
      n[15] = 1;
      this._normalVersion = this._worldVersion;
    }
    return this._normal;
  }

  /**
   * Brings this world matrix up to date assuming the parent's already is. The scene calls it top-down once a frame;
   * everything else goes through worldMatrix, which validates the ancestors first.
   */
  updateWorld(): void {
    const p = this._parent;
    const localChanged = this._syncLocal();
    if (!localChanged && (p ? p._worldVersion === this._parentVersion : this._worldVersion > 0)) return;
    if (p) {
      mat4.multiply(p._world, this._local, this._world);
      this._parentVersion = p._worldVersion;
    } else {
      this._world.set(this._local);
    }
    this._worldVersion++;
  }

  private _validate(): void {
    this._parent?._validate();
    this.updateWorld();
  }

  /** Re-bakes the local matrix if the values changed. Returns whether they did. */
  private _syncLocal(): boolean {
    const b = this._baked;
    const p = this._position, r = this._rotation, s = this._scale;
    if (
      !this._dirty &&
      b[0] === p[0] && b[1] === p[1] && b[2] === p[2] &&
      b[3] === r[0] && b[4] === r[1] && b[5] === r[2] && b[6] === r[3] &&
      b[7] === s[0] && b[8] === s[1] && b[9] === s[2]
    ) return false;
    b[0] = p[0]; b[1] = p[1]; b[2] = p[2];
    b[3] = r[0]; b[4] = r[1]; b[5] = r[2]; b[6] = r[3];
    b[7] = s[0]; b[8] = s[1]; b[9] = s[2];
    this._dirty = false;
    mat4.fromTRS(p, r, s, this._local);
    return true;
  }

  // ---- world-space helpers

  /** World position. Reading allocates a new Vec3; use getWorldPosition(out) in hot code. */
  get worldPosition(): Vec3 {
    return this.getWorldPosition([0, 0, 0]);
  }
  set worldPosition(p: Vec3) {
    const parent = this._parent;
    if (!parent) {
      this.position = [p[0], p[1], p[2]];
      return;
    }
    const inv = mat4.invert(parent.worldMatrix, scratchMat);
    this.position = inv ? transformPoint(inv, p, [0, 0, 0]) : [p[0], p[1], p[2]];
  }

  getWorldPosition(out: Vec3): Vec3 {
    const m = this.worldMatrix;
    out[0] = m[12];
    out[1] = m[13];
    out[2] = m[14];
    return out;
  }

  /** World rotation (the product of the local rotations up the hierarchy, so scale doesn't skew it). */
  get worldRotation(): Quat {
    return this.getWorldRotation([0, 0, 0, 1]);
  }
  set worldRotation(q: Quat) {
    const parent = this._parent;
    const pr = parent ? parent.getWorldRotation(scratchQuat) : null;
    const local = pr ? quat.multiply(quat.invert(pr), q) : quat.clone(q);
    this.rotation = quat.normalize(local);
  }

  getWorldRotation(out: Quat): Quat {
    const r = this._rotation;
    out[0] = r[0]; out[1] = r[1]; out[2] = r[2]; out[3] = r[3];
    for (let p = this._parent; p; p = p._parent) quatMulInto(p._rotation, out, out);
    return quatNormalizeInto(out);
  }

  /** World direction of local −Z (where cameras and lights point). */
  get forward(): Vec3 {
    return this.getAxis(2, -1, [0, 0, 0]);
  }
  /** World direction of local +X. */
  get right(): Vec3 {
    return this.getAxis(0, 1, [0, 0, 0]);
  }
  /** World direction of local +Y. */
  get up(): Vec3 {
    return this.getAxis(1, 1, [0, 0, 0]);
  }

  /** Normalized world direction of local axis 0 (X), 1 (Y) or 2 (Z), times `sign`. */
  getAxis(axis: 0 | 1 | 2, sign: number, out: Vec3): Vec3 {
    const m = this.worldMatrix;
    const o = axis * 4;
    const len = Math.hypot(m[o], m[o + 1], m[o + 2]) || 1;
    const k = sign / len;
    out[0] = m[o] * k;
    out[1] = m[o + 1] * k;
    out[2] = m[o + 2] * k;
    return out;
  }

  /** Rotates so local −Z points at `target` (a world point or another transform). Does nothing if they coincide. */
  lookAt(target: Readonly<Vec3> | Transform, up: Readonly<Vec3> = [0, 1, 0]): void {
    const m = this.worldMatrix;
    const t = target instanceof Transform ? target.worldMatrix : null;
    const dx = (t ? t[12] : (target as Vec3)[0]) - m[12];
    const dy = (t ? t[13] : (target as Vec3)[1]) - m[13];
    const dz = (t ? t[14] : (target as Vec3)[2]) - m[14];
    if (dx * dx + dy * dy + dz * dz < 1e-12) return;
    this.worldRotation = quat.lookRotation([dx, dy, dz], up);
  }

  /** Local point → world point. */
  transformPoint(p: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 {
    return transformPoint(this.worldMatrix, p, out);
  }

  /** World point → local point. */
  inverseTransformPoint(p: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 {
    const inv = mat4.invert(this.worldMatrix, scratchMat);
    if (!inv) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    return transformPoint(inv, p, out);
  }

  /** Local direction → world direction (rotation only; scale is ignored and the length kept). */
  transformDirection(d: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 {
    return rotateInto(this.getWorldRotation(scratchQuat), d, out);
  }

  /** World direction → local direction (rotation only). */
  inverseTransformDirection(d: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 {
    const q = this.getWorldRotation(scratchQuat);
    q[0] = -q[0];
    q[1] = -q[1];
    q[2] = -q[2];
    return rotateInto(q, d, out);
  }
}

const IDENTITY_MAT = mat4.create();

// GameObject keeps a parallel list of child objects; Transform.setParent is the only writer.
function childList(obj: GameObject): GameObject[] {
  return obj.children as GameObject[];
}

function transformPoint(m: Mat4, p: Readonly<Vec3>, out: Vec3): Vec3 {
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  return out;
}

/** out = a · b (b applied first). `out` may alias either input. */
function quatMulInto(a: Readonly<Quat>, b: Readonly<Quat>, out: Quat): Quat {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

function quatNormalizeInto(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= len;
  q[1] /= len;
  q[2] /= len;
  q[3] /= len;
  return q;
}

function rotateInto(q: Readonly<Quat>, v: Readonly<Vec3>, out: Vec3): Vec3 {
  // v' = v + 2w(q×v) + 2q×(q×v)
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const vx = v[0], vy = v[1], vz = v[2];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}
