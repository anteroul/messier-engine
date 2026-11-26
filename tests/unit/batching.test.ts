import { check, eq } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { Material, Texture, materialHash, materialsEqual } from '@root/src/engine/material.ts';
import { Mesh } from '@root/src/engine/mesh.ts';
import { MeshRenderer } from '@root/src/engine/meshRenderer.ts';
import { Camera } from '@root/src/engine/camera.ts';
import { mat4, quat, type Mat4, type Vec3 } from '@root/src/engine/math.ts';
import { boxOutsideFrustum, frustumPlanes } from '@root/src/engine/culling.ts';
import { DrawList, OBJECT_FLOATS } from '@root/src/engine/batching.ts';
import { createCube, createSphere } from '@root/src/engine/primitives.ts';

// Frustum culling, material look-alikes and the instanced draw list, all without a GPU.

const camera = () => {
  const c = new Camera();
  c.position = [0, 0, 10];
  c.target = [0, 0, 0];
  c.fovDeg = 60;
  c.aspect = 1;
  c.near = 0.1;
  c.far = 100;
  return c;
};
const UNIT_MIN: Vec3 = [-0.5, -0.5, -0.5], UNIT_MAX: Vec3 = [0.5, 0.5, 0.5];
const at = (x: number, y: number, z: number, scale = 1, rotation = quat.identity()) => mat4.fromTRS([x, y, z], rotation, [scale, scale, scale]);

// ---- the planes of a reversed-Z perspective camera
{
  const planes = frustumPlanes(camera().viewProjection());
  const outside = (m: Mat4) => boxOutsideFrustum(planes, m, UNIT_MIN, UNIT_MAX);
  eq('a box in front of the camera is inside', outside(at(0, 0, 0)), false);
  eq('behind the camera is outside', outside(at(0, 0, 12)), true);
  eq('past the far plane is outside', outside(at(0, 0, -95)), true);
  eq('just inside the far plane is inside', outside(at(0, 0, -89)), false);
  // At distance 10 with a 60° field of view the view is tan(30°) × 10 ≈ 5.77 to each side.
  eq('beyond the left, right, top and bottom planes is outside',
    [outside(at(-7, 0, 0)), outside(at(7, 0, 0)), outside(at(0, 7, 0)), outside(at(0, -7, 0))], [true, true, true, true]);
  eq('a box straddling a plane is inside', [outside(at(-6, 0, 0)), outside(at(0, 6.2, 0))], [false, false]);
  eq('the box\'s scale counts', [outside(at(-9, 0, 0)), outside(at(-9, 0, 0, 8))], [true, false]);
  // A unit cube turned 45° around the view axis reaches √2/2 ≈ 0.71 up instead of 0.5.
  const turned = quat.fromEulerDeg(0, 0, 45);
  eq('and so does its rotation', [outside(at(0, 6.65, 0)), outside(at(0, 6.65, 0, 1, turned))], [true, false]);
  eq('off-center bounds are transformed too', boxOutsideFrustum(planes, at(-20, 0, 0), [19.5, -0.5, -0.5], [20.5, 0.5, 0.5]), false);
}

// ---- an orthographic, normal-Z volume (the shadow map's)
{
  const view = mat4.lookAt([0, 10, 0], [0, 0, 0], [0, 0, -1]);
  const planes = frustumPlanes(mat4.multiply(mat4.ortho(-4, 4, -4, 4, 0.1, 20), view));
  const outside = (x: number, y: number, z: number) => boxOutsideFrustum(planes, at(x, y, z), UNIT_MIN, UNIT_MAX);
  eq('inside the shadow volume', [outside(0, 0, 0), outside(3.9, 0, -3.9), outside(0, 9, 0)], [false, false, false]);
  eq('outside it', [outside(5, 0, 0), outside(0, 0, 5), outside(0, 12, 0), outside(0, -11, 0)], [true, true, true, true]);
}

// ---- look-alike materials
{
  const tex = new Texture({ width: 4, height: 4 } as ImageBitmap, 'a');
  const a = Object.assign(new Material('a', { baseColor: [1, 0.5, 0.25, 1], roughness: 0.3 }), { baseColorTexture: tex });
  const b = a.clone();
  b.name = 'copy';
  check('a clone looks the same, whatever its name', materialsEqual(a, b) && materialHash(a) === materialHash(b));
  const changes: [string, (m: Material) => void][] = [
    ['baseColor', (m) => (m.baseColor[3] = 0.5)],
    ['metallic', (m) => (m.metallic = 0.9)],
    ['roughness', (m) => (m.roughness = 0.31)],
    ['emissive', (m) => (m.emissive[1] = 1)],
    ['emissiveStrength', (m) => (m.emissiveStrength = 2)],
    ['normalScale', (m) => (m.normalScale = 0.5)],
    ['occlusionStrength', (m) => (m.occlusionStrength = 0.5)],
    ['alphaCutoff', (m) => (m.alphaCutoff = 0.5)],
    ['doubleSided', (m) => (m.doubleSided = !m.doubleSided)],
    ['unlit', (m) => (m.unlit = !m.unlit)],
    ['blend', (m) => (m.blend = 'alpha')],
    ['baseColorTexture', (m) => (m.baseColorTexture = null)],
    ['normalTexture', (m) => (m.normalTexture = tex)],
    ['emissiveTexture', (m) => (m.emissiveTexture = tex)],
  ];
  const missed = changes.filter(([, change]) => {
    const c = a.clone();
    change(c);
    return materialsEqual(a, c) || materialHash(a) === materialHash(c);
  });
  eq('any field that changes the look tells them apart', missed.map(([name]) => name), []);
  const other = a.clone();
  other.baseColorTexture = new Texture({ width: 4, height: 4 } as ImageBitmap, 'b');
  check('a different texture in the same slot isn\'t equal', !materialsEqual(a, other));
}

// ---- the draw list
{
  const scene = new Scene();
  const cubeMesh = createCube(1), sphereMesh = createSphere(0.5);
  const red = new Material('red', { baseColor: [1, 0, 0, 1] });
  const add = (name: string, mesh: Mesh, material: Material, x: number, castShadows = true) => {
    const o = new GameObject(name);
    o.mesh = mesh;
    o.material = material;
    o.castShadows = castShadows;
    o.transform.position = [x, 0, 0];
    scene.add(o);
    return o;
  };
  add('cube 0', cubeMesh, red, -2);
  add('sphere', sphereMesh, red, 0);
  add('cube 1', cubeMesh, red.clone(), 2); // its own material object, same look
  add('blue cube', cubeMesh, new Material('blue', { baseColor: [0, 0, 1, 1] }), 4, false);
  add('cube 2', cubeMesh, red, -4);
  add('far cube', cubeMesh, red, 50); // out of view and out of the shadow map
  const leaf = Object.assign(red.clone(), { alphaCutoff: 0.5 });
  add('leaf', cubeMesh, leaf, 1);
  scene.updateMatrices();
  const renderers = scene.query(MeshRenderer);
  const lightViewProj = mat4.multiply(mat4.ortho(-8, 8, -8, 8, 0.1, 40), mat4.lookAt([0, 20, 0], [0, 0, 0], [0, 0, -1]));
  const names = (first: number, count: number, list: DrawList) => {
    const out: string[] = [];
    for (let i = first; i < first + count; i++) {
      const x = list.objects[i * OBJECT_FLOATS + 12];
      out.push(renderers.find((r) => r.transform.worldMatrix[12] === x)!.gameObject.name);
    }
    return out;
  };
  const describe = (list: DrawList, batches: typeof list.main) =>
    batches.map((b) => `${b.mesh === cubeMesh ? 'cube' : 'sphere'}/${b.material.name}@${b.first}: ${names(b.first, b.count, list).join(', ')}`);

  const eye = camera().position;
  const list = new DrawList();
  list.build(renderers, camera().viewProjection(), eye, [lightViewProj]);
  eq('main batches: one per mesh and look, in order of first appearance, instances side by side', describe(list, list.main), [
    'cube/red@0: cube 0, cube 1, cube 2',
    'sphere/red@3: sphere',
    'cube/blue@4: blue cube',
    'cube/red@5: leaf',
  ]);
  eq('shadow batches ignore the material unless it\'s alpha tested, and skip non-casters', describe(list, list.shadows[0]), [
    'cube/red@6: cube 0, cube 1, cube 2',
    'sphere/red@9: sphere',
    'cube/red@10: leaf',
  ]);
  check('the alpha-tested shadow batch keeps its material', list.shadows[0][2].material === leaf);
  eq('counts', [list.mainInstances, list.shadowInstances, list.objectCount, list.culled], [6, 5, 11, 1]);
  check('look-alikes share one material', list.materials.size === 3 && list.materials.has(red) && list.materials.has(leaf));
  const cube1 = renderers.find((r) => r.gameObject.name === 'cube 1')!;
  eq('an instance holds its model and normal matrix',
    [[...list.objects.subarray(OBJECT_FLOATS, OBJECT_FLOATS + 16)], [...list.objects.subarray(OBJECT_FLOATS + 16, OBJECT_FLOATS * 2)]],
    [[...cube1.transform.worldMatrix], [...cube1.transform.normalMatrix]]);

  list.build(renderers, camera().viewProjection(), eye, [lightViewProj], false);
  eq('with culling off everything is drawn', [list.mainInstances, list.shadowInstances, list.culled, list.main[0].count], [7, 6, 0, 4]);
  list.build(renderers, camera().viewProjection(), eye);
  eq('no shadow views, no shadow batches', [list.shadows.length, list.shadowInstances, list.objectCount], [0, 0, 6]);
  // A second view that only sees x > 1: cube 1, the leaf (its edge), not the blue cube (it casts no shadow).
  const narrow = mat4.multiply(mat4.ortho(1.6, 8, -8, 8, 0.1, 40), mat4.lookAt([0, 20, 0], [0, 0, 0], [0, 0, -1]));
  list.build(renderers, camera().viewProjection(), eye, [lightViewProj, narrow]);
  eq('every shadow view gets its own casters, after the previous view\'s', [list.shadows.length, ...describe(list, list.shadows[1])],
    [2, 'cube/red@11: cube 1']);
  eq('and they all count', [list.shadowInstances, list.objectCount], [6, 12]);

  // Blended materials: out of the opaque batches, back to front, no shadows.
  const glass = new Material('glass', { baseColor: [0.5, 0.8, 1, 0.4], blend: 'alpha' });
  const glow = new Material('glow', { baseColor: [1, 0.5, 0, 1], blend: 'additive' });
  const pane = (name: string, material: Material, z: number) => {
    const o = add(name, cubeMesh, material, 0);
    o.transform.position = [0, 0, z];
    return o;
  };
  const panes = [pane('near', glass, 4), pane('far', glass.clone(), -6), pane('glow', glow, -2), pane('mid', glass, 1), pane('hidden', glass, 30)];
  scene.updateMatrices();
  const withPanes = scene.query(MeshRenderer);
  const paneNames = (l: DrawList) => l.transparent.map((b) => {
    const out: string[] = [];
    for (let i = b.first; i < b.first + b.count; i++) {
      const z = l.objects[i * OBJECT_FLOATS + 14];
      out.push(panes.find((p) => p.transform.position[2] === z)!.name);
    }
    return `${b.material.name}@${b.first}: ${out.join(', ')}`;
  });
  list.build(withPanes, camera().viewProjection(), eye, [lightViewProj]);
  eq('blended meshes are drawn back to front, neighbours that look alike batched', paneNames(list),
    ['glass@6: far', 'glow@7: glow', 'glass@8: mid, near']);
  eq('they stay out of the opaque batches and cast no shadows', [list.main.length, list.mainInstances, list.shadowInstances, list.culled], [4, 10, 5, 2]);
  const behind = new Camera();
  Object.assign(behind, { position: [0, 0, -12], target: [0, 0, 0], fovDeg: 60, aspect: 1, near: 0.1, far: 100 });
  list.build(withPanes, behind.viewProjection(), behind.position, []);
  // From behind, the pane the first camera couldn't see is in view, and the farthest.
  eq('the order follows the eye', paneNames(list), ['glass@6: hidden, near, mid', 'glow@9: glow', 'glass@10: far']);
  for (const p of panes) scene.remove(p);
  scene.updateMatrices();

  // More instances than the array starts with.
  for (let i = 0; i < 200; i++) add(`extra ${i}`, cubeMesh, red, (i % 5) - 2);
  scene.updateMatrices();
  const many = scene.query(MeshRenderer);
  list.build(many, camera().viewProjection(), eye, [lightViewProj]);
  eq('the object array grows', [list.main[0].count, list.objectCount, list.objects.length >= list.objectCount * OBJECT_FLOATS], [203, 411, true]);
  list.build([], camera().viewProjection(), eye, [lightViewProj]);
  eq('an empty scene has no batches', [list.main.length, list.transparent.length, list.shadows[0].length, list.objectCount], [0, 0, 0, 0]);
}
