import { mat4, quat, vec3, type Quat, type Vec3 } from './math';
import type { Mesh } from './mesh';
import type { GameObject, Scene } from './scene';

// Rigid body dynamics: box and sphere colliders, a fixed-step sequential
// impulse solver with warm starting, Coulomb friction, restitution and
// sleeping. Bodies are simulated in world space; poses are read from and
// written back to the GameObject transform every step, so gizmo edits and
// behaviours (for kinematic bodies) act on the simulation directly.

export type BodyType = 'dynamic' | 'static' | 'kinematic';
export type ColliderShape = 'box' | 'sphere';
export const BODY_TYPES: readonly BodyType[] = ['dynamic', 'static', 'kinematic'];
export const COLLIDER_SHAPES: readonly ColliderShape[] = ['box', 'sphere'];

/** Flat meshes (planes) get a slab this thick (half extent) below the surface so things can rest on them. */
const FLAT_HALF_EXTENT = 0.1;
const MAX_SUBSTEPS = 8;
/** Penetration (m) left uncorrected so resting contacts persist between steps. */
const SLOP = 0.005;
const BAUMGARTE = 0.2;
const MAX_CORRECTION_SPEED = 3;
/** Approach speeds (m/s) below this don't bounce, so resting bodies settle. */
const RESTITUTION_THRESHOLD = 1;
const SLEEP_LINEAR = 0.05;
const SLEEP_ANGULAR = 0.05;
const SLEEP_TIME = 0.5;
const MAX_ANGULAR_SPEED = 100;

type RigidBodyOptions = Partial<
  Pick<RigidBody, 'shape' | 'center' | 'halfExtents' | 'radius' | 'mass' | 'friction' | 'restitution' | 'linearDamping' | 'angularDamping' | 'useGravity' | 'velocity' | 'angularVelocity'>
>;

/**
 * Physics component. `dynamic` bodies are moved by the simulation, `static`
 * ones never move, and `kinematic` ones are moved by you (transform edits or
 * behaviours) and push dynamic bodies with the velocity derived from that motion.
 */
export class RigidBody {
  type: BodyType;
  shape: ColliderShape = 'box';
  /** Collider center in the object's local space (scaled with the object). */
  center: Vec3 = [0, 0, 0];
  /** Box half extents in local space. */
  halfExtents: Vec3 = [0.5, 0.5, 0.5];
  /** Sphere radius in local space (scaled by the largest world scale axis). */
  radius = 0.5;
  /** kg. Only used by dynamic bodies. */
  mass = 1;
  friction = 0.5;
  restitution = 0.1;
  linearDamping = 0.05;
  angularDamping = 0.1;
  useGravity = true;
  /** World-space m/s. Set before Play for an initial velocity; updated live while simulating. */
  velocity: Vec3 = [0, 0, 0];
  /** World-space rad/s. */
  angularVelocity: Vec3 = [0, 0, 0];
  sleeping = false;

  /** World-space force and torque accumulated until the next step. */
  force: Vec3 = [0, 0, 0];
  torque: Vec3 = [0, 0, 0];
  /** Simulation bookkeeping: time spent below the sleep thresholds. */
  sleepTime = 0;
  /** Pose seen by the last step. A mismatch means something else moved the object. */
  lastPosition: Vec3 | null = null;
  lastRotation: Quat | null = null;

  constructor(type: BodyType = 'dynamic', opts: RigidBodyOptions = {}) {
    this.type = type;
    Object.assign(this, opts);
  }

  addForce(f: Readonly<Vec3>): void {
    this.force = vec3.add(this.force, f);
    this.wake();
  }

  addTorque(t: Readonly<Vec3>): void {
    this.torque = vec3.add(this.torque, t);
    this.wake();
  }

  /** Instant velocity change of `j / mass` (N·s), applied at the center of mass. */
  addImpulse(j: Readonly<Vec3>): void {
    if (this.type !== 'dynamic') return;
    this.velocity = vec3.addScaled(this.velocity, j, 1 / Math.max(this.mass, 1e-3));
    this.wake();
  }

  wake(): void {
    this.sleeping = false;
    this.sleepTime = 0;
  }

  /** Clears runtime state (sleep, accumulated forces, pose tracking). Velocities are kept. */
  resetState(): void {
    this.wake();
    this.force = [0, 0, 0];
    this.torque = [0, 0, 0];
    this.lastPosition = null;
    this.lastRotation = null;
  }

  clone(): RigidBody {
    return new RigidBody(this.type, {
      shape: this.shape,
      center: vec3.clone(this.center),
      halfExtents: vec3.clone(this.halfExtents),
      radius: this.radius,
      mass: this.mass,
      friction: this.friction,
      restitution: this.restitution,
      linearDamping: this.linearDamping,
      angularDamping: this.angularDamping,
      useGravity: this.useGravity,
      velocity: vec3.clone(this.velocity),
      angularVelocity: vec3.clone(this.angularVelocity),
    });
  }
}

/** Sizes the collider to the mesh's local bounds (unit box / sphere without a mesh). */
export function fitCollider(body: RigidBody, mesh: Mesh | null): void {
  if (!mesh) {
    body.center = [0, 0, 0];
    body.halfExtents = [0.5, 0.5, 0.5];
    body.radius = 0.5;
    return;
  }
  const c = vec3.lerp(mesh.boundsMin, mesh.boundsMax, 0.5);
  const h = vec3.scale(vec3.sub(mesh.boundsMax, mesh.boundsMin), 0.5);
  body.radius = Math.max(h[0], h[1], h[2], 1e-3);
  for (let k = 0; k < 3; k++) {
    if (h[k] >= 1e-3) continue;
    // A plane: thicken it into a slab. Below the surface for Y (floors), symmetric otherwise.
    if (k === 1) c[1] -= FLAT_HALF_EXTENT - h[1];
    h[k] = FLAT_HALF_EXTENT;
  }
  body.center = c;
  body.halfExtents = h;
}

/** True when the mesh is flat along some axis, i.e. better suited to a static body. */
export function isFlatMesh(mesh: Mesh | null): boolean {
  if (!mesh) return false;
  const d = vec3.sub(mesh.boundsMax, mesh.boundsMin);
  return Math.min(d[0], d[1], d[2]) < 2e-3;
}

/** A collider resolved to world space. `center` is also the center of mass. */
export interface WorldCollider {
  shape: ColliderShape;
  center: Vec3;
  axes: [Vec3, Vec3, Vec3];
  half: Vec3;
  radius: number;
}

interface Pose {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

function readPose(obj: GameObject): Pose {
  const local = obj.transform;
  // Top-level objects (parent = the never-transformed scene root) skip the float32 matrices for precision.
  if (!obj.parent?.parent) return { position: vec3.clone(local.position), rotation: quat.normalize(local.rotation), scale: absVec(local.scale) };
  const parentWorld = obj.parent.computeWorldMatrix();
  const { s } = mat4.decompose(mat4.multiply(parentWorld, local.localMatrix()));
  return { position: vec3.transformPoint(parentWorld, local.position), rotation: obj.worldRotation(), scale: absVec(s) };
}

function buildCollider(rb: RigidBody, pose: Pose): WorldCollider {
  const q = pose.rotation, s = pose.scale;
  return {
    shape: rb.shape,
    center: vec3.add(pose.position, quat.rotateVec3(q, vec3.mul(rb.center, s))),
    axes: [quat.rotateVec3(q, [1, 0, 0]), quat.rotateVec3(q, [0, 1, 0]), quat.rotateVec3(q, [0, 0, 1])],
    half: vec3.max(vec3.mul(rb.halfExtents, s), [1e-4, 1e-4, 1e-4]),
    radius: Math.max(rb.radius * Math.max(s[0], s[1], s[2]), 1e-4),
  };
}

/** The object's collider in world space, or null without a rigid body. Uses fresh (not cached) transforms. */
export function worldCollider(obj: GameObject): WorldCollider | null {
  return obj.rigidBody ? buildCollider(obj.rigidBody, readPose(obj)) : null;
}

/** World-space corners of a box collider, ordered like boxCorners(). */
export function colliderCorners(c: WorldCollider): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    let p = c.center;
    p = vec3.addScaled(p, c.axes[0], i & 4 ? c.half[0] : -c.half[0]);
    p = vec3.addScaled(p, c.axes[1], i & 2 ? c.half[1] : -c.half[1]);
    p = vec3.addScaled(p, c.axes[2], i & 1 ? c.half[2] : -c.half[2]);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Simulation

interface Body {
  obj: GameObject;
  rb: RigidBody;
  pose: Pose;
  col: WorldCollider;
  /** Simulated this step (dynamic and awake). */
  active: boolean;
  invMass: number;
  /** Inverse principal inertia in the collider's local axes. */
  invInertia: Vec3;
  v: Vec3;
  w: Vec3;
  min: Vec3;
  max: Vec3;
  /** Pose changed outside the solver since the last step. */
  teleported: boolean;
}

interface RawContact {
  p: Vec3;
  /** From the first collider towards the second. */
  n: Vec3;
  depth: number;
  feature: string;
}

interface Contact extends RawContact {
  a: Body;
  b: Body;
  key: string;
  rA: Vec3;
  rB: Vec3;
  t1: Vec3;
  t2: Vec3;
  massN: number;
  massT1: number;
  massT2: number;
  bias: number;
  friction: number;
  jn: number;
  jt1: number;
  jt2: number;
}

interface CachedImpulse {
  jn: number;
  /** World-space friction impulse, re-projected onto the next step's tangents. */
  jt: Vec3;
}

export class PhysicsWorld {
  gravity: Vec3 = [0, -9.81, 0];
  /** Fixed simulation step in seconds. */
  timeStep = 1 / 60;
  /** Solver iterations per step. More = stiffer stacks. */
  iterations = 10;
  /** Contacts in the last step (for stats). */
  contactCount = 0;

  private accumulator = 0;
  private cache = new Map<string, CachedImpulse>();
  private bodyCount = 0;

  /** Forgets cached contacts and wakes every body. Called when Play starts. */
  reset(scene: Scene): void {
    this.accumulator = 0;
    this.cache.clear();
    this.bodyCount = 0;
    scene.traverse((o) => o.rigidBody?.resetState());
  }

  /** Advances the simulation by `dt` seconds of real time in fixed steps. */
  update(scene: Scene, dt: number): void {
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= this.timeStep && steps < MAX_SUBSTEPS) {
      this.step(scene, this.timeStep);
      this.accumulator -= this.timeStep;
      steps++;
    }
    // Too slow to keep up: drop the backlog instead of spiralling.
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;
  }

  step(scene: Scene, h: number): void {
    const bodies: Body[] = [];
    scene.traverse((o) => {
      if (!o.visible) return false;
      if (o.rigidBody) bodies.push(makeBody(o, o.rigidBody, h));
    });
    // Sleeping bodies may have lost their support when bodies were added, removed or hidden, or scenery moved.
    if (bodies.length !== this.bodyCount || bodies.some((b) => b.rb.type === 'static' && b.teleported)) for (const b of bodies) wakeBody(b);
    this.bodyCount = bodies.length;

    // Integrate forces.
    for (const b of bodies) {
      const rb = b.rb;
      if (b.active) {
        if (rb.useGravity) b.v = vec3.addScaled(b.v, this.gravity, h);
        b.v = vec3.addScaled(b.v, rb.force, b.invMass * h);
        b.w = vec3.addScaled(b.w, applyInvInertia(b, rb.torque), h);
        b.v = vec3.scale(b.v, 1 / (1 + h * Math.max(0, rb.linearDamping)));
        b.w = vec3.scale(b.w, 1 / (1 + h * Math.max(0, rb.angularDamping)));
      }
      rb.force = [0, 0, 0];
      rb.torque = [0, 0, 0];
    }

    // Collision detection (brute-force broadphase; fine for editor-sized scenes).
    const contacts: Contact[] = [];
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const A = bodies[i], B = bodies[j];
        // Something must be simulated, or a kinematic body may be about to wake a sleeper.
        if (!A.active && !B.active && !(A.rb.type === 'kinematic' && B.rb.type === 'dynamic') && !(B.rb.type === 'kinematic' && A.rb.type === 'dynamic')) continue;
        if (A.max[0] < B.min[0] || A.min[0] > B.max[0] || A.max[1] < B.min[1] || A.min[1] > B.max[1] || A.max[2] < B.min[2] || A.min[2] > B.max[2]) continue;
        for (const c of collide(A.col, B.col)) contacts.push(makeContact(A, B, c));
      }
    }
    this.contactCount = contacts.length;

    // Wake sleeping bodies that are hit by something moving.
    for (const c of contacts) {
      if (isMoving(c.a)) wakeBody(c.b);
      if (isMoving(c.b)) wakeBody(c.a);
    }

    // Prepare and warm start.
    const solved: Contact[] = [];
    for (const c of contacts) {
      if (!c.a.active && !c.b.active) continue;
      prepareContact(c, h);
      const cached = this.cache.get(c.key);
      if (cached) {
        c.jn = cached.jn;
        c.jt1 = vec3.dot(cached.jt, c.t1);
        c.jt2 = vec3.dot(cached.jt, c.t2);
        applyImpulse(c, vec3.add(vec3.scale(c.n, c.jn), vec3.add(vec3.scale(c.t1, c.jt1), vec3.scale(c.t2, c.jt2))));
      }
      solved.push(c);
    }

    // Sequential impulses: friction (bounded by the current normal impulse), then the normal.
    for (let it = 0; it < this.iterations; it++) {
      for (const c of solved) {
        const maxF = c.friction * c.jn;
        let old = c.jt1;
        c.jt1 = clampAbs(old - vec3.dot(relativeVelocity(c), c.t1) * c.massT1, maxF);
        applyImpulse(c, vec3.scale(c.t1, c.jt1 - old));
        old = c.jt2;
        c.jt2 = clampAbs(old - vec3.dot(relativeVelocity(c), c.t2) * c.massT2, maxF);
        applyImpulse(c, vec3.scale(c.t2, c.jt2 - old));

        old = c.jn;
        c.jn = Math.max(0, old + (c.bias - vec3.dot(relativeVelocity(c), c.n)) * c.massN);
        applyImpulse(c, vec3.scale(c.n, c.jn - old));
      }
    }

    const cache = new Map<string, CachedImpulse>();
    for (const c of solved) cache.set(c.key, { jn: c.jn, jt: vec3.add(vec3.scale(c.t1, c.jt1), vec3.scale(c.t2, c.jt2)) });
    this.cache = cache;

    // Integrate velocities, update sleep state and write poses back.
    for (const b of bodies) {
      const rb = b.rb;
      if (rb.type === 'kinematic') {
        rb.lastPosition = b.pose.position;
        rb.lastRotation = b.pose.rotation;
        continue;
      }
      if (!b.active) continue;
      const ws = vec3.length(b.w);
      if (ws > MAX_ANGULAR_SPEED) b.w = vec3.scale(b.w, MAX_ANGULAR_SPEED / ws);

      if (vec3.dot(b.v, b.v) < SLEEP_LINEAR * SLEEP_LINEAR && vec3.dot(b.w, b.w) < SLEEP_ANGULAR * SLEEP_ANGULAR) {
        rb.sleepTime += h;
        if (rb.sleepTime >= SLEEP_TIME) {
          rb.sleeping = true;
          b.v = [0, 0, 0];
          b.w = [0, 0, 0];
        }
      } else {
        rb.sleepTime = 0;
      }
      rb.velocity = b.v;
      rb.angularVelocity = b.w;

      const com = vec3.addScaled(b.col.center, b.v, h);
      const spin = quat.multiply([b.w[0], b.w[1], b.w[2], 0], b.pose.rotation);
      const q0 = b.pose.rotation;
      const q = quat.normalize([q0[0] + spin[0] * 0.5 * h, q0[1] + spin[1] * 0.5 * h, q0[2] + spin[2] * 0.5 * h, q0[3] + spin[3] * 0.5 * h]);
      const origin = vec3.sub(com, quat.rotateVec3(q, vec3.mul(rb.center, b.pose.scale)));
      b.obj.setWorldPosition(origin);
      b.obj.setWorldRotation(q);
      rb.lastPosition = origin;
      rb.lastRotation = q;
    }
  }
}

function makeBody(obj: GameObject, rb: RigidBody, h: number): Body {
  const pose = readPose(obj);
  const col = buildCollider(rb, pose);
  let v = vec3.clone(rb.velocity), w = vec3.clone(rb.angularVelocity);
  const last = rb.lastPosition && rb.lastRotation ? { p: rb.lastPosition, q: rb.lastRotation } : null;
  const teleported = !!last && (vec3.distance(pose.position, last.p) > 1e-4 || 1 - Math.abs(quatDot(pose.rotation, last.q)) > 1e-7);
  if (rb.type === 'kinematic') {
    v = last ? vec3.scale(vec3.sub(pose.position, last.p), 1 / h) : [0, 0, 0];
    w = last ? angularVelocityBetween(last.q, pose.rotation, h) : [0, 0, 0];
    rb.velocity = v;
    rb.angularVelocity = w;
  } else if (rb.type === 'static') {
    rb.lastPosition = pose.position;
    rb.lastRotation = pose.rotation;
  } else if (teleported) {
    // Moved by the gizmo, the inspector or a script: restart from rest.
    v = [0, 0, 0];
    w = [0, 0, 0];
    rb.wake();
  }
  const ext = col.shape === 'sphere' ? [col.radius, col.radius, col.radius] : [0, 1, 2].map((i) => col.axes.reduce((s, a, k) => s + Math.abs(a[i]) * col.half[k], 0));
  const body: Body = {
    obj, rb, pose, col, v, w,
    active: false,
    invMass: 0,
    invInertia: [0, 0, 0],
    min: [col.center[0] - ext[0], col.center[1] - ext[1], col.center[2] - ext[2]],
    max: [col.center[0] + ext[0], col.center[1] + ext[1], col.center[2] + ext[2]],
    teleported,
  };
  if (rb.type === 'dynamic' && !rb.sleeping) activate(body);
  return body;
}

function activate(b: Body): void {
  const m = Math.max(b.rb.mass, 1e-3);
  const c = b.col;
  b.active = true;
  b.invMass = 1 / m;
  if (c.shape === 'sphere') {
    const i = 1 / (0.4 * m * c.radius * c.radius);
    b.invInertia = [i, i, i];
  } else {
    const [x, y, z] = c.half.map((e) => e * e);
    b.invInertia = [3 / (m * (y + z)), 3 / (m * (x + z)), 3 / (m * (x + y))];
  }
}

function wakeBody(b: Body): void {
  if (!b.rb.sleeping) return;
  b.rb.wake();
  activate(b);
}

/**
 * Uses the velocity from the end of the previous step: after this step's
 * gravity is applied every resting body would look like it's moving.
 */
function isMoving(b: Body): boolean {
  if (!b.active && b.rb.type !== 'kinematic') return false;
  const v = b.rb.velocity, w = b.rb.angularVelocity;
  return vec3.dot(v, v) > 4 * SLEEP_LINEAR * SLEEP_LINEAR || vec3.dot(w, w) > 4 * SLEEP_ANGULAR * SLEEP_ANGULAR;
}

/** World inverse inertia times `x`: R · diag(invInertia) · Rᵀ · x. */
function applyInvInertia(b: Body, x: Readonly<Vec3>): Vec3 {
  let out: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) out = vec3.addScaled(out, b.col.axes[k], b.invInertia[k] * vec3.dot(b.col.axes[k], x));
  return out;
}

function makeContact(a: Body, b: Body, c: RawContact): Contact {
  const zero: Vec3 = [0, 0, 0];
  return {
    ...c, a, b,
    key: `${a.obj.id}:${b.obj.id}:${c.feature}`,
    rA: zero, rB: zero, t1: zero, t2: zero,
    massN: 0, massT1: 0, massT2: 0, bias: 0, friction: 0, jn: 0, jt1: 0, jt2: 0,
  };
}

function prepareContact(c: Contact, h: number): void {
  const A = c.a, B = c.b;
  c.rA = vec3.sub(c.p, A.col.center);
  c.rB = vec3.sub(c.p, B.col.center);
  const t1 = vec3.normalize(vec3.cross(c.n, Math.abs(c.n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  c.t1 = t1;
  c.t2 = vec3.cross(c.n, t1);
  const effMass = (dir: Vec3) => {
    const ra = vec3.cross(c.rA, dir), rb = vec3.cross(c.rB, dir);
    const k = A.invMass + B.invMass + vec3.dot(ra, applyInvInertia(A, ra)) + vec3.dot(rb, applyInvInertia(B, rb));
    return k > 1e-12 ? 1 / k : 0;
  };
  c.massN = effMass(c.n);
  c.massT1 = effMass(c.t1);
  c.massT2 = effMass(c.t2);
  c.friction = Math.sqrt(Math.max(0, A.rb.friction) * Math.max(0, B.rb.friction));
  const vn = vec3.dot(relativeVelocity(c), c.n);
  const e = Math.max(A.rb.restitution, B.rb.restitution);
  const bounce = vn < -RESTITUTION_THRESHOLD ? -e * vn : 0;
  const push = Math.min(MAX_CORRECTION_SPEED, (BAUMGARTE / h) * Math.max(0, c.depth - SLOP));
  c.bias = Math.max(bounce, push);
}

function relativeVelocity(c: Contact): Vec3 {
  const va = vec3.add(c.a.v, vec3.cross(c.a.w, c.rA));
  const vb = vec3.add(c.b.v, vec3.cross(c.b.w, c.rB));
  return vec3.sub(vb, va);
}

/** Applies impulse `p` to B and `-p` to A at the contact point. Inactive bodies are unaffected. */
function applyImpulse(c: Contact, p: Vec3): void {
  const A = c.a, B = c.b;
  if (A.active) {
    A.v = vec3.addScaled(A.v, p, -A.invMass);
    A.w = vec3.sub(A.w, applyInvInertia(A, vec3.cross(c.rA, p)));
  }
  if (B.active) {
    B.v = vec3.addScaled(B.v, p, B.invMass);
    B.w = vec3.add(B.w, applyInvInertia(B, vec3.cross(c.rB, p)));
  }
}

// ---------------------------------------------------------------------------
// Narrowphase. Every function returns normals pointing from `a` to `b`.

function collide(a: WorldCollider, b: WorldCollider): RawContact[] {
  if (a.shape === 'sphere' && b.shape === 'sphere') return sphereSphere(a, b);
  if (a.shape === 'box' && b.shape === 'sphere') return boxSphere(a, b);
  if (a.shape === 'sphere' && b.shape === 'box') return boxSphere(b, a).map((c) => ({ ...c, n: vec3.scale(c.n, -1) }));
  return boxBox(a, b);
}

function sphereSphere(a: WorldCollider, b: WorldCollider): RawContact[] {
  const d = vec3.sub(b.center, a.center);
  const dist = vec3.length(d);
  const depth = a.radius + b.radius - dist;
  if (depth < 0) return [];
  const n: Vec3 = dist > 1e-9 ? vec3.scale(d, 1 / dist) : [0, 1, 0];
  return [{ p: vec3.addScaled(a.center, n, a.radius - depth / 2), n, depth, feature: 's' }];
}

function boxSphere(box: WorldCollider, sphere: WorldCollider): RawContact[] {
  const d = vec3.sub(sphere.center, box.center);
  const local = box.axes.map((ax) => vec3.dot(d, ax));
  const clamped = local.map((x, k) => Math.max(-box.half[k], Math.min(box.half[k], x)));
  const inside = local.every((x, k) => x === clamped[k]);
  if (!inside) {
    const closest = box.axes.reduce((p, ax, k) => vec3.addScaled(p, ax, clamped[k]), box.center);
    const diff = vec3.sub(sphere.center, closest);
    const dist = vec3.length(diff);
    if (dist >= sphere.radius || dist < 1e-9) return [];
    return [{ p: closest, n: vec3.scale(diff, 1 / dist), depth: sphere.radius - dist, feature: 's' }];
  }
  // Center inside the box: push out through the nearest face.
  let k = 0;
  for (let i = 1; i < 3; i++) if (box.half[i] - Math.abs(local[i]) < box.half[k] - Math.abs(local[k])) k = i;
  const side = local[k] >= 0 ? 1 : -1;
  const facePoint = box.axes.reduce((p, ax, i) => vec3.addScaled(p, ax, i === k ? side * box.half[k] : local[i]), box.center);
  return [{ p: facePoint, n: vec3.scale(box.axes[k], side), depth: sphere.radius + box.half[k] - Math.abs(local[k]), feature: 's' }];
}

function projectedRadius(c: WorldCollider, axis: Readonly<Vec3>): number {
  return c.half[0] * Math.abs(vec3.dot(c.axes[0], axis)) + c.half[1] * Math.abs(vec3.dot(c.axes[1], axis)) + c.half[2] * Math.abs(vec3.dot(c.axes[2], axis));
}

function insideBox(c: WorldCollider, p: Readonly<Vec3>, tol: number): boolean {
  const d = vec3.sub(p, c.center);
  return c.axes.every((ax, k) => Math.abs(vec3.dot(d, ax)) <= c.half[k] + tol);
}

/**
 * Separating axis test over the 15 candidate axes. The contact manifold is
 * every vertex of one box inside the other (that covers face-face and
 * edge-face resting contacts), or the closest points of the two edges when
 * an edge-edge axis separates least.
 */
function boxBox(a: WorldCollider, b: WorldCollider): RawContact[] {
  const d = vec3.sub(b.center, a.center);
  const best = { score: Infinity, depth: 0, n: [0, 1, 0] as Vec3, edgeA: -1, edgeB: -1 };
  const test = (axis: Vec3, edgeA: number, edgeB: number): boolean => {
    const len = vec3.length(axis);
    if (len < 1e-6) return true; // parallel edges: covered by the face axes
    const L = vec3.scale(axis, 1 / len);
    const dist = vec3.dot(d, L);
    const depth = projectedRadius(a, L) + projectedRadius(b, L) - Math.abs(dist);
    if (depth < 0) return false;
    // Prefer face axes so resting contacts don't flicker between face and edge normals.
    const score = edgeA < 0 ? depth : depth * 1.05 + 0.002;
    if (score < best.score) {
      best.score = score;
      best.depth = depth;
      best.n = dist < 0 ? vec3.scale(L, -1) : L;
      best.edgeA = edgeA;
      best.edgeB = edgeB;
    }
    return true;
  };
  for (let k = 0; k < 3; k++) if (!test(a.axes[k], -1, -1) || !test(b.axes[k], -1, -1)) return [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!test(vec3.cross(a.axes[i], b.axes[j]), i, j)) return [];

  const n = best.n;
  if (best.edgeA >= 0) {
    const i = best.edgeA, j = best.edgeB;
    let pa = a.center, pb = b.center;
    for (let k = 0; k < 3; k++) {
      if (k !== i) pa = vec3.addScaled(pa, a.axes[k], Math.sign(vec3.dot(a.axes[k], n)) * a.half[k]);
      if (k !== j) pb = vec3.addScaled(pb, b.axes[k], -Math.sign(vec3.dot(b.axes[k], n)) * b.half[k]);
    }
    const [ca, cb] = closestOnSegments(pa, a.axes[i], a.half[i], pb, b.axes[j], b.half[j]);
    return [{ p: vec3.lerp(ca, cb, 0.5), n, depth: best.depth, feature: `e${i}${j}` }];
  }

  const out: RawContact[] = [];
  const tol = 0.01;
  const faceA = vec3.dot(a.center, n) + projectedRadius(a, n);
  const faceB = vec3.dot(b.center, n) - projectedRadius(b, n);
  colliderCorners(b).forEach((v, i) => {
    const depth = faceA - vec3.dot(v, n);
    if (depth > 0 && insideBox(a, v, tol)) out.push({ p: v, n, depth, feature: `b${i}` });
  });
  colliderCorners(a).forEach((v, i) => {
    const depth = vec3.dot(v, n) - faceB;
    if (depth > 0 && insideBox(b, v, tol) && !out.some((c) => vec3.distance(c.p, v) < 1e-3)) out.push({ p: v, n, depth, feature: `a${i}` });
  });
  if (out.length === 0) {
    // Overlapping without a vertex inside (crossing edges near a face axis): one contact at B's deepest vertex.
    const deepest = colliderCorners(b).reduce((m, v) => (vec3.dot(v, n) < vec3.dot(m, n) ? v : m));
    out.push({ p: vec3.addScaled(deepest, n, best.depth / 2), n, depth: best.depth, feature: 'f' });
  }
  return out;
}

/** Closest points between segments p ± u·ha and q ± v·hb (u, v unit length). */
function closestOnSegments(p: Vec3, u: Vec3, ha: number, q: Vec3, v: Vec3, hb: number): [Vec3, Vec3] {
  const r = vec3.sub(p, q);
  const b = vec3.dot(u, v), c = vec3.dot(u, r), f = vec3.dot(v, r);
  const denom = 1 - b * b;
  let s = denom > 1e-9 ? (b * f - c) / denom : 0;
  s = Math.max(-ha, Math.min(ha, s));
  let t = Math.max(-hb, Math.min(hb, f + s * b));
  s = Math.max(-ha, Math.min(ha, t * b - c));
  t = Math.max(-hb, Math.min(hb, f + s * b));
  return [vec3.addScaled(p, u, s), vec3.addScaled(q, v, t)];
}

function angularVelocityBetween(from: Readonly<Quat>, to: Readonly<Quat>, h: number): Vec3 {
  let dq = quat.multiply(to, quat.invert(from));
  if (dq[3] < 0) dq = [-dq[0], -dq[1], -dq[2], -dq[3]];
  const s = Math.hypot(dq[0], dq[1], dq[2]);
  if (s < 1e-9) return [0, 0, 0];
  const angle = 2 * Math.atan2(s, dq[3]);
  return [(dq[0] / s) * (angle / h), (dq[1] / s) * (angle / h), (dq[2] / s) * (angle / h)];
}

function quatDot(a: Readonly<Quat>, b: Readonly<Quat>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

function absVec(v: Readonly<Vec3>): Vec3 {
  return [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
}

function clampAbs(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}
