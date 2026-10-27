import { check, eq, near, throws } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { mat4, quat, vec3, type Mat4, type Quat, type Vec3 } from '@root/src/engine/math.ts';

// Deterministic pseudo-random TRS values.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const randomize = (o: GameObject) => {
  o.transform.position = [rnd() * 3, rnd() * 3, rnd() * 3];
  o.transform.rotation = quat.fromEulerDeg(rnd() * 180, rnd() * 180, rnd() * 180);
  o.transform.scale = [1 + rnd() * 0.5, 1 + rnd() * 0.5, 1 + rnd() * 0.5];
};
/** Reference world matrix: the product of fresh local matrices up the chain. */
const reference = (o: GameObject): Mat4 => {
  let m = mat4.fromTRS(o.transform.position, o.transform.rotation, o.transform.scale);
  for (let p = o.parent; p; p = p.parent) m = mat4.multiply(mat4.fromTRS(p.transform.position, p.transform.rotation, p.transform.scale), m);
  return m;
};

// ---- world matrices through a deep hierarchy
const scene = new Scene();
const chain: GameObject[] = [];
{
  let parent = scene.root;
  for (let i = 0; i < 8; i++) {
    const o = new GameObject(`n${i}`);
    randomize(o);
    parent.add(o);
    chain.push(o);
    parent = o;
  }
  const leaf = chain[7];
  near('deep world matrix matches the reference product', leaf.worldMatrix, reference(leaf), 1e-4);
  eq('children are kept on both the object and its transform', [chain[0].children[0] === chain[1], chain[0].transform.children[0] === chain[1].transform], [true, true]);
  check('scene reaches through the hierarchy', leaf.scene === scene);
}

// ---- dirty propagation: assignment and in-place edits above a cached child
{
  const leaf = chain[7];
  const before = mat4.clone(leaf.worldMatrix);
  chain[2].transform.position = vec3.add(chain[2].transform.position, [1, 0, 0]);
  near('assigning an ancestor position updates a cached descendant', leaf.worldMatrix, reference(leaf), 1e-4);
  check('…and actually changed it', !before.every((v, i) => Math.abs(v - leaf.worldMatrix[i]) < 1e-6));

  chain[0].transform.rotation[1] += 0.2; // in place, not normalized: still a valid matrix input
  near('in-place ancestor rotation edit propagates', leaf.worldMatrix, reference(leaf), 1e-4);
  chain[5].transform.scale[2] = 2;
  near('in-place scale edit propagates', leaf.worldMatrix, reference(leaf), 1e-4);
  chain[0].transform.rotation = quat.normalize(chain[0].transform.rotation);

  // Cached reads don't rebuild matrices.
  let builds = 0;
  const fromTRS = mat4.fromTRS;
  mat4.fromTRS = (...args: Parameters<typeof fromTRS>) => {
    builds++;
    return fromTRS(...args);
  };
  void leaf.worldMatrix;
  builds = 0;
  for (let i = 0; i < 5; i++) void leaf.worldMatrix;
  scene.updateMatrices();
  eq('unchanged hierarchy: no matrix rebuilds', builds, 0);
  chain[6].transform.position[0] += 1;
  scene.updateMatrices();
  eq('one edit rebuilds one local matrix', builds, 1);
  mat4.fromTRS = fromTRS;

  const n0 = mat4.clone(leaf.normalMatrix);
  chain[4].transform.scale = [3, 1, 1];
  const expectN = mat4.normalMatrix(reference(leaf));
  near('normal matrix follows world changes', leaf.normalMatrix, expectN, 1e-3);
  check('…and differs from before', !n0.every((v, i) => Math.abs(v - leaf.normalMatrix[i]) < 1e-6));
}

// ---- reparenting
{
  const a = scene.add(new GameObject('a'));
  const b = scene.add(new GameObject('b'));
  randomize(a);
  randomize(b);
  b.transform.scale = [1, 1, 1]; // uniform so world rotation+position are exactly representable
  a.transform.scale = [1.5, 1.5, 1.5];
  const c = a.add(new GameObject('c'));
  randomize(c);
  c.transform.scale = [1, 1, 1];

  const world = mat4.clone(c.worldMatrix);
  c.transform.setParent(b.transform); // keepWorldTransform defaults to true
  near('setParent keeps the world transform by default', c.worldMatrix, world, 1e-4);
  check('…and moved it in both child lists', b.children.includes(c) && !a.children.includes(c) && c.parent === b);

  const local = c.transform.snapshot();
  c.transform.setParent(a.transform, false);
  near('setParent(…, false) keeps local values', [...c.transform.position, ...c.transform.rotation], [...local.position, ...local.rotation], 1e-6);
  near('…so the world follows the new parent', c.worldMatrix, mat4.multiply(a.worldMatrix, c.transform.localMatrix), 1e-4);

  c.transform.setParent(null);
  near('detaching keeps the world transform', c.worldMatrix, mat4.multiply(a.worldMatrix, mat4.fromTRS(local.position, local.rotation, local.scale)), 1e-4);
  check('detached object has no parent or scene', c.parent === null && c.scene === null);

  const d = a.add(new GameObject('d'));
  const e = a.add(new GameObject('e'));
  a.add(e, 0);
  eq('add() at an index reorders siblings', a.children.map((o) => o.name), ['e', 'd']);
  throws('parenting to a descendant throws', () => d.add(a), /descendant/);
  throws('parenting to itself throws', () => d.add(d), /itself/);
}

// ---- world-space setters and helpers under a rotated, scaled parent
{
  const parent = scene.add(new GameObject('p'));
  parent.transform.position = [2, 1, -3];
  parent.transform.setEulerDeg(10, 70, -20);
  parent.transform.scale = [2, 2, 2];
  const child = parent.add(new GameObject('ch'));

  child.transform.worldPosition = [5, -1, 4];
  near('worldPosition setter round-trips', child.transform.worldPosition, [5, -1, 4], 1e-4);
  const q = quat.fromEulerDeg(-30, 15, 80);
  child.transform.worldRotation = q;
  const got: Quat = child.transform.worldRotation;
  const sameSign = got[3] * q[3] < 0 ? got.map((v) => -v) : got;
  near('worldRotation setter round-trips', sameSign, q, 1e-5);

  child.transform.lookAt([5, 10, 4]);
  near('lookAt points forward (−Z) at the target', child.transform.forward, [0, 1, 0], 1e-5);
  const t = scene.add(new GameObject('target'));
  t.transform.position = [5, -1, 14];
  child.transform.lookAt(t.transform);
  near('lookAt a transform', child.transform.forward, [0, 0, 1], 1e-5);
  const r = child.transform.right, u = child.transform.up, f = child.transform.forward;
  near('right/up/forward are orthonormal', [vec3.dot(r, u), vec3.dot(u, f), vec3.dot(r, f), vec3.length(r), vec3.length(u)], [0, 0, 0, 1, 1], 1e-5);

  const p: Vec3 = [0.3, -2, 1.5];
  const w = child.transform.transformPoint(p);
  near('transformPoint matches the world matrix', w, vec3.transformPoint(child.worldMatrix, p), 1e-5);
  near('inverseTransformPoint undoes it', child.transform.inverseTransformPoint(w), p, 1e-4);
  const dir: Vec3 = [0, 0, -2];
  near('transformDirection rotates, keeps length', child.transform.transformDirection(dir), [0, 0, 2], 1e-5);
  near('inverseTransformDirection undoes it', child.transform.inverseTransformDirection([0, 0, 2]), dir, 1e-5);

  // GameObject compatibility helpers agree with the transform.
  near('GameObject.worldPosition() delegates', child.worldPosition(), child.transform.worldPosition, 1e-6);
  near('GameObject.forward() delegates', child.forward(), child.transform.forward, 1e-6);
}

// ---- clone copies local values and hierarchy
{
  const src = scene.add(new GameObject('src'));
  randomize(src);
  const kid = src.add(new GameObject('kid'));
  randomize(kid);
  const copy = src.clone();
  scene.add(copy);
  near('clone has the same world matrices', copy.children[0].worldMatrix, kid.worldMatrix, 1e-5);
  copy.transform.position[0] += 1;
  check('clone values are independent', src.transform.position[0] !== copy.transform.position[0]);
}
