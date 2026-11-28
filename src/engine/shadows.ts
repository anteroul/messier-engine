// Shadow maps: cascades for the shadow-casting directional light, and perspective views for point and spot lights.
//
// Directional:
// The camera's view, from its near plane out to the scene's shadow distance, is cut into slices by depth along its
// forward axis; each slice gets a layer of the shadow map. Splits blend uniform and logarithmic spacing, so near
// cascades are small (sharp) and far ones large. Each cascade is an orthographic box around the slice's bounding
// sphere rather than its exact bounds: a sphere doesn't change with the camera's rotation, so the box's size never
// changes, and its center is snapped to whole shadow-map texels, so moving the camera doesn't make edges shimmer.
//
// Point and spot lights that cast shadows share a second shadow map, an array of layers handed out each frame: a spot
// light takes one (a perspective view down its cone), a point light six (a cube's faces, each a perspective view a
// little wider than 90°, so filtering near a face's edge stays inside it). Lights whose range reaches into the view
// get layers first, nearest first; one that doesn't fit is left without shadows.
//
// No GPU here: tests/unit/shadows.test.ts checks the math under Node.

import { mat4, vec3, type Mat4, type Vec3 } from './math';
import type { Camera } from './camera';
import { sphereOutsideFrustum, type FrustumPlanes } from './culling';

/** Layers of the shadow map: the most cascades a scene can ask for. */
export const MAX_SHADOW_CASCADES = 4;

/** 0 = uniform splits, 1 = logarithmic. Logarithmic alone spends too little on the far cascades. */
const SPLIT_LAMBDA = 0.75;

export interface ShadowCascade {
  /** World to the cascade's clip space (normal Z: 0 near the light, 1 far). */
  viewProj: Mat4;
  /** View depth (along the camera's forward axis) where the cascade ends. */
  far: number;
  /** Radius of the slice's bounding sphere: the box is twice that across. */
  radius: number;
  /** Size of one shadow-map texel in world units. */
  texel: number;
  /** Depth range of the box (world units), for turning a world-space bias into a depth one. */
  depthRange: number;
}

/**
 * The cascades for `camera`, looking along `lightDir` (the direction the light travels), up to `distance` from the
 * camera, on a `mapSize` texel square per cascade.
 */
export function computeCascades(camera: Camera, lightDir: Readonly<Vec3>, distance: number, count: number, mapSize: number): ShadowCascade[] {
  const n = Math.max(1, Math.min(MAX_SHADOW_CASCADES, Math.floor(count)));
  const near = camera.near;
  const far = Math.max(near * 1.01, Math.min(distance, camera.far));
  const forward = vec3.normalize(vec3.sub(camera.target, camera.position));
  const dir = vec3.normalize(lightDir as Vec3);
  const up: Vec3 = Math.abs(dir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  // The light's orientation, at the origin: texel snapping happens in its x/y.
  const lightView = mat4.lookAt([0, 0, 0], dir, up);
  const lightToWorld = mat4.invert(lightView) ?? mat4.create();

  // How far a slice's corners are from the view axis per unit of depth (perspective), or at any depth (ortho).
  const tanY = Math.tan((camera.fovDeg * Math.PI) / 360);
  const perspK2 = tanY * tanY * (1 + camera.aspect * camera.aspect);
  const orthoR2 = camera.orthoSize * camera.orthoSize * (1 + camera.aspect * camera.aspect);

  const out: ShadowCascade[] = [];
  let sliceNear = near;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / n;
    const sliceFar = i === n - 1 ? far : SPLIT_LAMBDA * near * Math.pow(far / near, t) + (1 - SPLIT_LAMBDA) * (near + (far - near) * t);
    // The smallest sphere around the slice has its center on the view axis, where the near and far corners are
    // equally far; when that's past the far plane (a wide view, a thin slice) it stops there, and the far corners,
    // now the farther ones, decide the radius.
    let center: number, r2: number;
    if (camera.orthographic) {
      center = (sliceNear + sliceFar) / 2;
      r2 = (center - sliceNear) ** 2 + orthoR2;
    } else {
      center = Math.min(sliceFar, ((sliceNear + sliceFar) * (1 + perspK2)) / 2);
      r2 = Math.max((center - sliceNear) ** 2 + sliceNear * sliceNear * perspK2, (sliceFar - center) ** 2 + sliceFar * sliceFar * perspK2);
    }
    // Rounded up, so float noise as the camera turns can't change the box's size (and with it the texel grid).
    const radius = Math.ceil(Math.sqrt(r2) * 16) / 16;
    const texel = (radius * 2) / mapSize;

    const world = vec3.addScaled(camera.position, forward, center);
    const ls = vec3.transformPoint(lightView, world);
    ls[0] = Math.floor(ls[0] / texel) * texel;
    ls[1] = Math.floor(ls[1] / texel) * texel;
    const snapped = vec3.transformPoint(lightToWorld, ls);
    // Casters up to the shadow distance beyond the sphere, toward the light, still land in the map.
    const back = radius + far;
    const eye = vec3.addScaled(snapped, dir, -back);
    const view = mat4.lookAt(eye, snapped, up);
    const depthRange = back + radius;
    const proj = mat4.ortho(-radius, radius, -radius, radius, 0, depthRange);
    out.push({ viewProj: mat4.multiply(proj, view), far: sliceFar, radius, texel, depthRange });
    sliceNear = sliceFar;
  }
  return out;
}

/** Layers of the point and spot light shadow map: two point lights, or twelve spot lights. */
export const MAX_LOCAL_SHADOW_LAYERS = 12;

/** Cube faces of a point light's shadow, in layer order: +x, −x, +y, −y, +z, −z (the shader picks them so). */
const CUBE_FACES: readonly [Vec3, Vec3][] = [
  [[1, 0, 0], [0, 1, 0]],
  [[-1, 0, 0], [0, 1, 0]],
  [[0, 1, 0], [0, 0, -1]],
  [[0, -1, 0], [0, 0, 1]],
  [[0, 0, 1], [0, 1, 0]],
  [[0, 0, -1], [0, 1, 0]],
];

/** Widest a spot light's shadow view gets: past it, the edge of a wider cone is lit. */
const MAX_SPOT_FOV_DEG = 160;

export interface LocalShadowLight {
  type: 'point' | 'spot';
  position: Readonly<Vec3>;
  /** Where a spot light points (unit length). */
  direction: Readonly<Vec3>;
  range: number;
  /** Spot: the cone's half-angle in degrees. */
  outerAngle: number;
}

export interface LocalShadow {
  /** The first of its layers (a spot light has one, a point light six, one per face in CUBE_FACES order). */
  layer: number;
  /** World to each layer's clip space (normal Z). */
  views: Mat4[];
  /** A shadow-map texel's world size per unit of distance from the light, for scaling the bias. */
  texelPerDistance: number;
}

/** The views of one light's shadow on `mapSize` texel squares, starting at `layer`. */
export function localShadowViews(light: LocalShadowLight, layer: number, mapSize: number): LocalShadow {
  const range = Math.max(light.range, 0.01);
  const near = Math.max(0.05, range * 0.01);
  const pos = light.position as Vec3;
  if (light.type === 'spot') {
    const fov = Math.min(MAX_SPOT_FOV_DEG, 2 * Math.min(89, Math.max(0.5, light.outerAngle)) + 4) * (Math.PI / 180);
    const dir = light.direction as Vec3;
    const up: Vec3 = Math.abs(dir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    const view = mat4.lookAt(pos, vec3.add(pos, dir), up);
    const tanHalf = Math.tan(fov / 2);
    return { layer, views: [mat4.multiply(mat4.perspective(fov, 1, near, range), view)], texelPerDistance: (2 * tanHalf) / mapSize };
  }
  // A border of two texels beyond 90°.
  const tanHalf = 1 + 4 / mapSize;
  const proj = mat4.perspective(2 * Math.atan(tanHalf), 1, near, range);
  const views = CUBE_FACES.map(([dir, up]) => mat4.multiply(proj, mat4.lookAt(pos, vec3.add(pos, dir), up)));
  return { layer, views, texelPerDistance: (2 * tanHalf) / mapSize };
}

/**
 * Hands out the `maxLayers` layers to `lights` (null: not casting shadows): lights whose range is inside the view
 * (`viewPlanes`) first, nearest to `eye` first. Returns each light's shadow, or null.
 */
export function assignLocalShadows(
  lights: readonly (LocalShadowLight | null)[],
  eye: Readonly<Vec3>,
  viewPlanes: FrustumPlanes,
  maxLayers: number,
  mapSize: number,
): (LocalShadow | null)[] {
  const out: (LocalShadow | null)[] = lights.map(() => null);
  const order: { index: number; distance: number }[] = [];
  lights.forEach((l, index) => {
    if (!l || sphereOutsideFrustum(viewPlanes, l.position, l.range)) return;
    order.push({ index, distance: Math.max(0, vec3.distance(eye as Vec3, l.position as Vec3) - l.range) });
  });
  order.sort((a, b) => a.distance - b.distance);
  let layer = 0;
  for (const { index } of order) {
    const l = lights[index]!;
    const needs = l.type === 'point' ? 6 : 1;
    if (layer + needs > maxLayers) continue;
    out[index] = localShadowViews(l, layer, mapSize);
    layer += needs;
  }
  return out;
}
