import {
  CameraComponent,
  GameObject,
  Light,
  Material,
  Text2D,
  createCylinder,
  createPlane,
  createSphere,
  quat,
  type Mesh,
  type Scene,
  type Vec3,
} from '../engine';
import { addScripts, glow, group, hudText, lightObject, meshObject, neon } from '../demos/shared';
import { LAB_SCRIPTS } from './scripts';

// The Material Lab's scenes. Everything textured comes from material-lab.glb (scripts/generate-material-glb.mjs):
// the builders only take its meshes and materials apart and lay them out, so the scenes save like hand-made ones.

/** What the builders use from the loaded material-lab.glb. */
export interface LabParts {
  cube: Mesh;
  sphere: Mesh;
  panel: Mesh;
  /** The tile material with its maps added one at a time: base color, + normal, + metal/rough, + occlusion, + emissive. */
  stages: Material[];
  hull: Material;
}

/** Finds the meshes and materials of a loaded material-lab.glb by node name. */
export function labParts(model: GameObject): LabParts {
  const node = (name: string) => {
    let found: GameObject | null = null;
    model.traverse((o) => {
      if (!found && o.name === name && o.mesh && o.material) found = o;
    });
    if (!found) throw new Error(`material-lab.glb has no node "${name}"`);
    return found as GameObject;
  };
  const stageNames = ['Stage 1 Base Color', 'Stage 2 Normal', 'Stage 3 Metal Rough', 'Stage 4 Occlusion', 'Stage 5 Emissive'];
  return {
    cube: node(stageNames[0]).mesh!,
    sphere: node('Sphere').mesh!,
    panel: node('Panel').mesh!,
    stages: stageNames.map((n) => node(n).material!),
    hull: node('Panel').material!,
  };
}

const STAGE_LABELS = ['Base color', '+ Normal', '+ Metal / rough', '+ Occlusion', '+ Emissive'];

/** The HUD and the Lab controller both scenes have. */
function addLab(scene: Scene, title: string, script: ReturnType<typeof addScripts>): void {
  const lab = new GameObject('Lab');
  lab.attachComponent(script('Lab'));
  scene.add(lab);
  scene.add(hudText('Title', 'top-left', 22, -16, { text: `Material Lab · ${title}`, fontSize: 24, bold: true, color: [1, 0.9, 0.7, 1], align: 'left', verticalAlign: 'top' }));
  scene.add(hudText('Status', 'top-right', -22, -18, { text: 'Maps: on', fontSize: 18, color: [0.75, 0.95, 1, 1], align: 'right', verticalAlign: 'top' }));
  scene.add(hudText('Controls', 'bottom', 0, 12, {
    text: 'Space: maps on / off   N / P: next / previous scene', fontSize: 14, color: [1, 1, 1, 0.85], verticalAlign: 'bottom',
  }));
}

function camera(position: Vec3, target: Vec3, fovDeg: number): GameObject {
  const o = new GameObject('Camera');
  o.camera = new CameraComponent({ fovDeg, far: 200 });
  o.transform.position = position;
  o.transform.lookAt(target);
  return o;
}

/**
 * "Gallery": five pedestals that add the tile material's maps one at a time, in front of a wall of hull plating, with
 * a light sweeping across them all. Normal maps only really show when the light moves.
 */
export function buildGallery(scene: Scene, parts: LabParts): void {
  const script = addScripts(scene, LAB_SCRIPTS);
  Object.assign(scene.sky, {
    mode: 'gradient', top: [0.015, 0.02, 0.045], horizon: [0.07, 0.07, 0.09], ground: [0.02, 0.02, 0.02], sunSize: 0, sunGlow: 0, lighting: 0.6,
  });
  addLab(scene, 'Gallery', script);

  scene.add(meshObject('Floor', createPlane(40, 1), new Material('Floor', { baseColor: [0.05, 0.05, 0.055, 1], roughness: 0.55 }), [0, 0, 0]));

  // The wall: 2 m panels of hull plating, 6 across and 3 high.
  const wall = group('Wall', [], [0, 0, -2.6]);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 6; col++) {
      wall.add(meshObject(`Panel ${row + 1}-${col + 1}`, parts.panel, parts.hull, [(col - 2.5) * 2, 1 + row * 2, 0], [2, 2, 1]));
    }
  }
  scene.add(wall);

  // The build-up row: a tiled cube on each pedestal and a sphere turning above it.
  const plinth = createCylinder(0.45, 0.8, 40);
  const stone = new Material('Pedestal', { baseColor: [0.08, 0.08, 0.09, 1], roughness: 0.4 });
  parts.stages.forEach((material, i) => {
    const stand = group(`Stage ${i + 1}`, [], [(i - 2) * 2, 0, 0]);
    stand.add(meshObject('Pedestal', plinth, stone, [0, 0.4, 0]));
    const cube = meshObject('Cube', parts.cube, material, [0, 1.15, 0], [0.7, 0.7, 0.7]);
    cube.transform.setEulerDeg(0, 32, 0);
    stand.add(cube);
    const sphere = meshObject('Sphere', parts.sphere, material, [0, 2.05, 0], [0.75, 0.75, 0.75]);
    sphere.attachComponent(script('Spin', { speed: 14, tilt: 12 }));
    stand.add(sphere);
    const label = new GameObject('Label');
    label.attachComponent(new Text2D({ text: `${i + 1}  ${STAGE_LABELS[i]}`, fontSize: 0.17, bold: true, color: [1, 1, 1, 0.92], outlineWidth: 0.02, outlineColor: [0, 0, 0, 0.8] }));
    label.transform.position = [0, 0.35, 0.7];
    stand.add(label);
    scene.add(stand);
  });

  // The light that sweeps across everything, with a bulb and a halo to show where it is.
  const sweep = lightObject('Sweep Light', new Light('point', [1, 0.86, 0.7], 28), [0, 2.4, 1.5], 12);
  sweep.attachComponent(script('Sweep', { width: 5, period: 10, bob: 0.5 }));
  const bulb = meshObject('Bulb', createSphere(1, 16, 8), neon('Bulb', [1, 0.9, 0.75], 1.5), [0, 0, 0], [0.12, 0.12, 0.12]);
  bulb.castShadows = false;
  sweep.add(bulb);
  sweep.add(glow('Halo', [1, 0.85, 0.6], 0.9, 0.12));
  scene.add(sweep);

  // A dim, cool key light, for shape and shadows.
  const key = new Light('directional', [0.7, 0.8, 1], 0.7);
  key.castShadows = true;
  const keyObj = lightObject('Key Light', key, [-6, 8, 6]);
  keyObj.transform.rotation = quat.lookRotation([0.45, -0.75, -0.5]);
  scene.add(keyObj);

  scene.add(camera([0, 2.9, 9.6], [0, 1.4, -0.6], 50));
}

/**
 * "Orbit": a large sphere of hull plating with a ring of fully mapped tile cubes around it, under a low sun that
 * circles the scene, so every side gets the light in turn.
 */
export function buildOrbit(scene: Scene, parts: LabParts): void {
  const script = addScripts(scene, LAB_SCRIPTS);
  Object.assign(scene.sky, {
    mode: 'gradient', top: [0.03, 0.05, 0.12], horizon: [0.3, 0.2, 0.16], ground: [0.025, 0.022, 0.02], sunSize: 2, sunGlow: 0.5, lighting: 0.55,
  });
  addLab(scene, 'Orbit', script);

  scene.add(meshObject('Platform', createCylinder(6, 0.3, 64), new Material('Platform', { baseColor: [0.06, 0.06, 0.07, 1], metallic: 1, roughness: 0.45 }), [0, -0.15, 0]));

  const hero = meshObject('Hull Sphere', parts.sphere, parts.hull, [0, 1.9, 0], [3, 3, 3]);
  hero.attachComponent(script('Spin', { speed: 6, tilt: 14 }));
  scene.add(hero);

  const ring = group('Ring', [], [0, 1.9, 0]);
  ring.attachComponent(script('Spin', { speed: 10, tilt: 8 }));
  const tiles = parts.stages[parts.stages.length - 1];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const cube = meshObject(`Cube ${i + 1}`, parts.cube, tiles, [Math.cos(a) * 3.1, 0, Math.sin(a) * 3.1], [0.55, 0.55, 0.55]);
    cube.transform.setEulerDeg(20, (-a * 180) / Math.PI, 35);
    ring.add(cube);
  }
  scene.add(ring);

  const sun = new Light('directional', [1, 0.85, 0.7], 3);
  sun.castShadows = true;
  const sunObj = lightObject('Sun', sun, [8, 6, 0]);
  sunObj.transform.rotation = quat.lookRotation([-0.9, -0.42, -0.1]);
  sunObj.attachComponent(script('Orbit', { period: 24, elevation: 24 }));
  scene.add(sunObj);

  scene.add(camera([0, 3.2, 8.6], [0, 1.7, 0], 50));
}
