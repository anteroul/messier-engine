import { mat4, quat, vec3, type Mat4, type Quat, type Vec3 } from './math';
import type { Mesh } from './mesh';
import type { Material } from './material';
import type { Light } from './light';
import type { Behaviour } from './behaviours';

let nextId = 1;

export class Transform {
  position: Vec3 = [0, 0, 0];
  rotation: Quat = [0, 0, 0, 1];
  scale: Vec3 = [1, 1, 1];

  setEulerDeg(x: number, y: number, z: number): this {
    this.rotation = quat.fromEulerDeg(x, y, z);
    return this;
  }

  getEulerDeg(): Vec3 {
    return quat.toEulerDeg(this.rotation);
  }

  localMatrix(out?: Mat4): Mat4 {
    return mat4.fromTRS(this.position, this.rotation, this.scale, out);
  }

  copyFrom(t: Transform): this {
    this.position = vec3.clone(t.position);
    this.rotation = quat.clone(t.rotation);
    this.scale = vec3.clone(t.scale);
    return this;
  }

  clone(): Transform {
    return new Transform().copyFrom(this);
  }
}

/** A node in the scene graph. Components are plain optional fields. */
export class GameObject {
  readonly id = nextId++;
  name: string;
  transform = new Transform();
  parent: GameObject | null = null;
  readonly children: GameObject[] = [];
  visible = true;

  mesh: Mesh | null = null;
  material: Material | null = null;
  castShadows = true;
  light: Light | null = null;
  behaviours: Behaviour[] = [];

  /** Updated by Scene.updateMatrices(). */
  readonly worldMatrix: Mat4 = mat4.create();
  readonly normalMatrix: Mat4 = mat4.create();

  constructor(name = 'GameObject') {
    this.name = name;
  }

  add(child: GameObject, index = this.children.length): GameObject {
    if (child === this || child.isAncestorOf(this)) throw new Error('Cannot parent an object to its own descendant');
    child.parent?.remove(child);
    child.parent = this;
    this.children.splice(index, 0, child);
    return child;
  }

  remove(child: GameObject): void {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parent = null;
    }
  }

  isAncestorOf(other: GameObject): boolean {
    for (let p = other.parent; p; p = p.parent) if (p === this) return true;
    return false;
  }

  /** True when this object and all its ancestors are visible. */
  isVisibleInHierarchy(): boolean {
    for (let o: GameObject | null = this; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  traverse(fn: (obj: GameObject) => void | boolean): void {
    if (fn(this) === false) return;
    for (const c of this.children) c.traverse(fn);
  }

  updateWorldMatrix(parentWorld: Mat4 | null): void {
    this.transform.localMatrix(this.worldMatrix);
    if (parentWorld) mat4.multiply(parentWorld, this.worldMatrix, this.worldMatrix);
    mat4.normalMatrix(this.worldMatrix, this.normalMatrix);
    for (const c of this.children) c.updateWorldMatrix(this.worldMatrix);
  }

  /** World matrix computed on demand (does not rely on the cached matrix being fresh). */
  computeWorldMatrix(): Mat4 {
    const m = this.transform.localMatrix();
    return this.parent ? mat4.multiply(this.parent.computeWorldMatrix(), m) : m;
  }

  worldPosition(): Vec3 {
    return mat4.getTranslation(this.computeWorldMatrix());
  }

  worldRotation(): Quat {
    let q = quat.clone(this.transform.rotation);
    for (let p = this.parent; p; p = p.parent) q = quat.multiply(p.transform.rotation, q);
    return quat.normalize(q);
  }

  /** Direction the object faces (local -Z) in world space. */
  forward(): Vec3 {
    return vec3.normalize(quat.rotateVec3(this.worldRotation(), [0, 0, -1]));
  }

  /** Sets the world-space position, converting into the parent's space. */
  setWorldPosition(p: Vec3): void {
    if (!this.parent) {
      this.transform.position = vec3.clone(p);
      return;
    }
    const inv = mat4.invert(this.parent.computeWorldMatrix());
    this.transform.position = inv ? vec3.transformPoint(inv, p) : vec3.clone(p);
  }

  setWorldRotation(q: Quat): void {
    const parentRot = this.parent ? this.parent.worldRotation() : quat.identity();
    this.transform.rotation = quat.normalize(quat.multiply(quat.invert(parentRot), q));
  }

  /** Re-parents while keeping the current world transform. */
  setParentKeepWorld(parent: GameObject, index?: number): void {
    const world = this.computeWorldMatrix();
    parent.add(this, index);
    const parentInv = mat4.invert(parent.computeWorldMatrix()) ?? mat4.create();
    const { t, r, s } = mat4.decompose(mat4.multiply(parentInv, world));
    this.transform.position = t;
    this.transform.rotation = r;
    this.transform.scale = s;
  }

  /** Deep copy. Meshes and textures are shared; materials, lights and behaviours are copied. */
  clone(): GameObject {
    const o = new GameObject(this.name);
    o.transform.copyFrom(this.transform);
    o.visible = this.visible;
    o.mesh = this.mesh;
    o.material = this.material?.clone() ?? null;
    o.castShadows = this.castShadows;
    o.light = this.light?.clone() ?? null;
    o.behaviours = this.behaviours.map((b) => b.clone());
    for (const c of this.children) o.add(c.clone());
    return o;
  }
}

export class Scene {
  /** Invisible container; top-level objects are its children. */
  readonly root = new GameObject('Scene');
  /** Linear RGB ambient light color, multiplied by ambientIntensity. */
  ambientColor: Vec3 = [0.55, 0.62, 0.75];
  ambientIntensity = 0.25;
  /** Clear color (display space). */
  background: Vec3 = [0.07, 0.075, 0.09];
  exposure = 1;
  /** Half extent (world units) of the directional shadow frustum. */
  shadowExtent = 16;

  add(obj: GameObject, parent: GameObject = this.root): GameObject {
    return parent.add(obj);
  }

  remove(obj: GameObject): void {
    obj.parent?.remove(obj);
  }

  traverse(fn: (obj: GameObject) => void | boolean): void {
    for (const c of this.root.children) c.traverse(fn);
  }

  find(predicate: (obj: GameObject) => boolean): GameObject | null {
    let found: GameObject | null = null;
    this.traverse((o) => {
      if (found) return false;
      if (predicate(o)) found = o;
    });
    return found;
  }

  findByName(name: string): GameObject | null {
    return this.find((o) => o.name === name);
  }

  updateMatrices(): void {
    for (const c of this.root.children) c.updateWorldMatrix(null);
  }

  /** Runs behaviours (when playing) and refreshes world matrices. */
  update(dt: number, time: number, playing: boolean): void {
    if (playing) {
      this.traverse((o) => {
        for (const b of o.behaviours) if (b.enabled) b.update(o, dt, time);
      });
    }
    this.updateMatrices();
  }
}
