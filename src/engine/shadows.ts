// Cascaded shadow maps for the shadow-casting directional light.
//
// The camera's view, from its near plane out to the scene's shadow distance, is cut into slices by depth along its
// forward axis; each slice gets a layer of the shadow map. Splits blend uniform and logarithmic spacing, so near
// cascades are small (sharp) and far ones large. Each cascade is an orthographic box around the slice's bounding
// sphere rather than its exact bounds: a sphere doesn't change with the camera's rotation, so the box's size never
// changes, and its center is snapped to whole shadow-map texels, so moving the camera doesn't make edges shimmer.
//
// No GPU here: tests/unit/shadows.test.ts checks the math under Node.

import { mat4, vec3, type Mat4, type Vec3 } from './math';
import type { Camera } from './camera';

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
