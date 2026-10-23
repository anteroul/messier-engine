import { Mesh } from './mesh';
import type { Vec3 } from './math';

// Procedural meshes. All are generated with outward normals; fixWinding()
// guarantees counter-clockwise front faces regardless of parametrisation.

export function createCube(size = 1): Mesh {
  const h = size / 2;
  const faces: { n: Vec3; u: Vec3; v: Vec3 }[] = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const f of faces) {
    const base = pos.length / 3;
    for (const [su, sv] of corners) {
      for (let k = 0; k < 3; k++) pos.push((f.n[k] + f.u[k] * su + f.v[k] * sv) * h);
      nor.push(...f.n);
      uv.push((su + 1) / 2, 1 - (sv + 1) / 2);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return tag(Mesh.fromArrays('Cube', pos, nor, uv, idx).fixWinding(), 'cube', [size]);
}

export function createSphere(radius = 0.5, segments = 48, rings = 24): Mesh {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const theta = (j / segments) * Math.PI * 2;
      const n: Vec3 = [Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)];
      pos.push(n[0] * radius, n[1] * radius, n[2] * radius);
      nor.push(...n);
      uv.push(j / segments, i / rings);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * row + j, b = (i + 1) * row + j, c = b + 1, d = a + 1;
      if (i !== 0) idx.push(a, b, d);
      if (i !== rings - 1) idx.push(d, b, c);
    }
  }
  return tag(Mesh.fromArrays('Sphere', pos, nor, uv, idx).fixWinding(), 'sphere', [radius, segments, rings]);
}

export function createPlane(size = 10, subdivisions = 1): Mesh {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const n = Math.max(1, subdivisions);
  const h = size / 2;
  for (let iz = 0; iz <= n; iz++) {
    for (let ix = 0; ix <= n; ix++) {
      pos.push(-h + (ix / n) * size, 0, -h + (iz / n) * size);
      nor.push(0, 1, 0);
      uv.push((ix / n) * size * 0.5, (iz / n) * size * 0.5);
    }
  }
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const a = iz * (n + 1) + ix, b = a + n + 1, c = b + 1, d = a + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  return tag(Mesh.fromArrays('Plane', pos, nor, uv, idx).fixWinding(), 'plane', [size, subdivisions]);
}

export function createCylinder(radius = 0.5, height = 1, segments = 40): Mesh {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const h = height / 2;
  // Side
  for (let j = 0; j <= segments; j++) {
    const t = (j / segments) * Math.PI * 2;
    const x = Math.sin(t), z = Math.cos(t);
    pos.push(x * radius, h, z * radius, x * radius, -h, z * radius);
    nor.push(x, 0, z, x, 0, z);
    uv.push(j / segments, 0, j / segments, 1);
  }
  for (let j = 0; j < segments; j++) {
    const a = j * 2, b = a + 1, c = a + 3, d = a + 2;
    idx.push(a, b, c, a, c, d);
  }
  // Caps
  for (const side of [1, -1]) {
    const center = pos.length / 3;
    pos.push(0, h * side, 0);
    nor.push(0, side, 0);
    uv.push(0.5, 0.5);
    for (let j = 0; j <= segments; j++) {
      const t = (j / segments) * Math.PI * 2;
      const x = Math.sin(t), z = Math.cos(t);
      pos.push(x * radius, h * side, z * radius);
      nor.push(0, side, 0);
      uv.push(0.5 + x * 0.5, 0.5 + z * 0.5);
    }
    for (let j = 0; j < segments; j++) idx.push(center, center + 1 + j, center + 2 + j);
  }
  return tag(Mesh.fromArrays('Cylinder', pos, nor, uv, idx).fixWinding(), 'cylinder', [radius, height, segments]);
}

export function createTorus(radius = 0.5, tube = 0.2, radialSegments = 24, tubularSegments = 64): Mesh {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= radialSegments; i++) {
    const v = (i / radialSegments) * Math.PI * 2;
    for (let j = 0; j <= tubularSegments; j++) {
      const u = (j / tubularSegments) * Math.PI * 2;
      const cx = Math.cos(u) * radius, cz = Math.sin(u) * radius;
      const px = (radius + tube * Math.cos(v)) * Math.cos(u);
      const py = tube * Math.sin(v);
      const pz = (radius + tube * Math.cos(v)) * Math.sin(u);
      pos.push(px, py, pz);
      const n = [px - cx, py, pz - cz];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      nor.push(n[0] / l, n[1] / l, n[2] / l);
      uv.push(j / tubularSegments, i / radialSegments);
    }
  }
  const row = tubularSegments + 1;
  for (let i = 0; i < radialSegments; i++) {
    for (let j = 0; j < tubularSegments; j++) {
      const a = i * row + j, b = (i + 1) * row + j, c = b + 1, d = a + 1;
      idx.push(a, b, d, b, c, d);
    }
  }
  return tag(Mesh.fromArrays('Torus', pos, nor, uv, idx).fixWinding(), 'torus', [radius, tube, radialSegments, tubularSegments]);
}

export type PrimitiveKind = 'cube' | 'sphere' | 'plane' | 'cylinder' | 'torus';

/** Records the generator and its arguments so saved scenes can rebuild the mesh. */
function tag(mesh: Mesh, kind: PrimitiveKind, args: number[]): Mesh {
  mesh.ref = { primitive: kind, args };
  return mesh;
}

const GENERATORS: Record<PrimitiveKind, (...args: number[]) => Mesh> = {
  cube: createCube,
  sphere: createSphere,
  plane: createPlane,
  cylinder: createCylinder,
  torus: createTorus,
};

/** Rebuilds a primitive from a saved `{ primitive, args }` ref, or null for an unknown kind. */
export function buildPrimitive(kind: string, args: number[]): Mesh | null {
  const gen = GENERATORS[kind as PrimitiveKind];
  return gen ? gen(...args.filter((a) => typeof a === 'number' && Number.isFinite(a))) : null;
}

const cache = new Map<PrimitiveKind, Mesh>();

/** Shared unit-sized primitive meshes for editor "Add" menus. */
export function getPrimitive(kind: PrimitiveKind): Mesh {
  let m = cache.get(kind);
  if (!m) {
    m = { cube: createCube, sphere: createSphere, plane: () => createPlane(10, 1), cylinder: createCylinder, torus: createTorus }[kind]();
    cache.set(kind, m);
  }
  return m;
}
