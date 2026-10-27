import { mat4, type Mat4, type Quat, type Vec3 } from './math';
import { Transform } from './transform';
import type { Mesh } from './mesh';
import type { Material } from './material';
import type { Light } from './light';
import type { CameraComponent } from './camera';
import type { Behaviour } from './behaviours';
import { PhysicsWorld, type RigidBody } from './physics';
import { ScriptLibrary } from './scripting';

let nextId = 1;
// Scene of each scene root, so objects can find their scene through the hierarchy.
const rootScenes = new WeakMap<GameObject, Scene>();

/** A node in the scene graph. Components are plain optional fields. */
export class GameObject {
  readonly id = nextId++;
  name: string;
  readonly transform: Transform = new Transform(this);
  /** Child objects, in order. Change it through add()/remove() or transform.setParent(). */
  readonly children: readonly GameObject[] = [];
  visible = true;

  mesh: Mesh | null = null;
  material: Material | null = null;
  castShadows = true;
  light: Light | null = null;
  camera: CameraComponent | null = null;
  behaviours: Behaviour[] = [];
  rigidBody: RigidBody | null = null;

  constructor(name = 'GameObject') {
    this.name = name;
  }

  get parent(): GameObject | null {
    return this.transform.parent?.gameObject ?? null;
  }

  /** Adds `child` at `index` (default: last), keeping its local transform. */
  add(child: GameObject, index?: number): GameObject {
    child.transform.setParent(this.transform, false, index);
    return child;
  }

  remove(child: GameObject): void {
    if (child.parent === this) child.transform.setParent(null, false);
  }

  isAncestorOf(other: GameObject): boolean {
    return this.transform.isAncestorOf(other.transform);
  }

  /** The scene this object is in (through its root), or null when detached. */
  get scene(): Scene | null {
    return rootScenes.get(this.transform.root.gameObject) ?? null;
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

  /** World matrix (cached and always current; don't modify). */
  get worldMatrix(): Mat4 {
    return this.transform.worldMatrix;
  }

  get normalMatrix(): Mat4 {
    return this.transform.normalMatrix;
  }

  /** A copy of the world matrix. */
  computeWorldMatrix(): Mat4 {
    return mat4.clone(this.transform.worldMatrix);
  }

  worldPosition(): Vec3 {
    return this.transform.worldPosition;
  }

  worldRotation(): Quat {
    return this.transform.worldRotation;
  }

  /** Direction the object faces (local -Z) in world space. */
  forward(): Vec3 {
    return this.transform.forward;
  }

  /** Sets the world-space position, converting into the parent's space. */
  setWorldPosition(p: Vec3): void {
    this.transform.worldPosition = p;
  }

  setWorldRotation(q: Quat): void {
    this.transform.worldRotation = q;
  }

  /** Re-parents while keeping the current world transform. */
  setParentKeepWorld(parent: GameObject, index?: number): void {
    this.transform.setParent(parent.transform, true, index);
  }

  /** Deep copy. Meshes and textures are shared; materials, lights, cameras, behaviours and rigid bodies are copied. */
  clone(): GameObject {
    const o = new GameObject(this.name);
    o.transform.copyFrom(this.transform);
    o.visible = this.visible;
    o.mesh = this.mesh;
    o.material = this.material?.clone() ?? null;
    o.castShadows = this.castShadows;
    o.light = this.light?.clone() ?? null;
    o.camera = this.camera?.clone() ?? null;
    o.behaviours = this.behaviours.map((b) => b.clone());
    o.rigidBody = this.rigidBody?.clone() ?? null;
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
  background: Vec3 = [0.06, 0.062, 0.065];
  exposure = 1;
  /** Half extent (world units) of the directional shadow frustum. */
  shadowExtent = 16;
  readonly physics = new PhysicsWorld();
  /** TypeScript behaviour scripts available to this scene's objects. */
  readonly scripts = new ScriptLibrary();

  constructor() {
    rootScenes.set(this.root, this);
  }

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

  /** The camera the game renders through: the visible camera with the highest priority (ties: first in the hierarchy). */
  activeCamera(): GameObject | null {
    let best: GameObject | null = null;
    this.traverse((o) => {
      if (!o.visible) return false;
      if (o.camera && (!best || o.camera.priority > best.camera!.priority)) best = o;
    });
    return best;
  }

  /** Brings every world matrix up to date in one top-down pass (world matrices are also correct when read lazily). */
  updateMatrices(): void {
    updateSubtree(this.root);
  }

  /** Runs behaviours and physics (when playing) and refreshes world matrices. */
  update(dt: number, time: number, playing: boolean): void {
    if (playing) {
      this.traverse((o) => {
        for (const b of o.behaviours) if (b.enabled) b.update(o, dt, time);
      });
      this.physics.update(this, dt);
    }
    this.updateMatrices();
  }
}

function updateSubtree(obj: GameObject): void {
  obj.transform.updateWorld();
  for (const c of obj.children) updateSubtree(c);
}
