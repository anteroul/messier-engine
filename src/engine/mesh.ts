import { vec3, type Vec3 } from './math';

/** Floats per vertex: position(3) + normal(3) + uv(2). */
export const VERTEX_STRIDE_FLOATS = 8;
export const VERTEX_STRIDE_BYTES = VERTEX_STRIDE_FLOATS * 4;

/**
 * Where a mesh or texture came from, so a saved scene can point at it instead
 * of embedding vertex data: a procedural primitive with its generator
 * arguments, or the n-th resource of an imported asset (see tagAssetResources).
 */
export type ResourceRef = { primitive: string; args: number[] } | { asset: string; index: number };

export interface MeshGPU {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
}

/**
 * Indexed triangle mesh with interleaved vertices. CPU data is kept so the
 * editor can raycast against triangles; GPU buffers are created lazily by the
 * renderer on first draw.
 */
export class Mesh {
  name: string;
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  boundsMin: Vec3 = [0, 0, 0];
  boundsMax: Vec3 = [0, 0, 0];
  gpu: MeshGPU | null = null;
  /** Source of this mesh, or null when it can't be saved (built by code at runtime). */
  ref: ResourceRef | null = null;

  constructor(name: string, vertices: Float32Array<ArrayBuffer>, indices: Uint32Array<ArrayBuffer>) {
    this.name = name;
    this.vertices = vertices;
    this.indices = indices;
    this.computeBounds();
  }

  get vertexCount(): number {
    return this.vertices.length / VERTEX_STRIDE_FLOATS;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  static fromArrays(
    name: string,
    positions: ArrayLike<number>,
    normals: ArrayLike<number> | null,
    uvs: ArrayLike<number> | null,
    indices: ArrayLike<number> | null,
  ): Mesh {
    const count = positions.length / 3;
    const idx = indices ? Uint32Array.from(indices) : Uint32Array.from({ length: count }, (_, i) => i);
    const n = normals ?? computeNormals(positions, idx);
    const v = new Float32Array(count * VERTEX_STRIDE_FLOATS);
    for (let i = 0; i < count; i++) {
      const o = i * VERTEX_STRIDE_FLOATS;
      v[o] = positions[i * 3];
      v[o + 1] = positions[i * 3 + 1];
      v[o + 2] = positions[i * 3 + 2];
      v[o + 3] = n[i * 3];
      v[o + 4] = n[i * 3 + 1];
      v[o + 5] = n[i * 3 + 2];
      if (uvs) {
        v[o + 6] = uvs[i * 2];
        v[o + 7] = uvs[i * 2 + 1];
      }
    }
    return new Mesh(name, v, idx);
  }

  computeBounds(): void {
    const v = this.vertices;
    if (v.length === 0) {
      this.boundsMin = [0, 0, 0];
      this.boundsMax = [0, 0, 0];
      return;
    }
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i += VERTEX_STRIDE_FLOATS) {
      for (let k = 0; k < 3; k++) {
        const c = v[i + k];
        if (c < min[k]) min[k] = c;
        if (c > max[k]) max[k] = c;
      }
    }
    this.boundsMin = min;
    this.boundsMax = max;
  }

  /** Flips triangles whose geometric normal disagrees with their vertex normals. */
  fixWinding(): this {
    const v = this.vertices, idx = this.indices;
    const p = (i: number): Vec3 => [v[i * 8], v[i * 8 + 1], v[i * 8 + 2]];
    const n = (i: number): Vec3 => [v[i * 8 + 3], v[i * 8 + 4], v[i * 8 + 5]];
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const pa = p(a);
      const geo = vec3.cross(vec3.sub(p(b), pa), vec3.sub(p(c), pa));
      const avg = vec3.add(vec3.add(n(a), n(b)), n(c));
      if (vec3.dot(geo, avg) < 0) {
        idx[t + 1] = c;
        idx[t + 2] = b;
      }
    }
    return this;
  }

  destroy(): void {
    this.gpu?.vertexBuffer.destroy();
    this.gpu?.indexBuffer.destroy();
    this.gpu = null;
  }
}

/** Area-weighted smooth vertex normals. */
export function computeNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const e1: Vec3 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const e2: Vec3 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const fn = vec3.cross(e1, e2);
    for (const i of [a, b, c]) {
      normals[i] += fn[0];
      normals[i + 1] += fn[1];
      normals[i + 2] += fn[2];
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l;
    normals[i + 1] /= l;
    normals[i + 2] /= l;
  }
  return normals;
}
