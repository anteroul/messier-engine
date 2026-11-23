// Turns the frame's mesh renderers into instanced draws.
//
// Renderers that share a mesh and have materials that look the same (MeshRenderer.clone() copies the material, so
// duplicates rarely share one object) become one batch: a single drawIndexed with an instance count. Each pass gets
// its own batches, built from the renderers its frustum sees. The shadow pass ignores materials except for
// alpha-tested ones, so there a mesh's casters usually collapse into one batch.
//
// Every instance's Object (model + normal matrix) is written into `objects`, a batch's instances next to each
// other; the shaders index that array with the instance index, which starts at the batch's `first`.
//
// No GPU here: tests/unit/batching.test.ts runs it under Node.

import type { Mat4 } from './math';
import type { Mesh } from './mesh';
import { materialHash, materialsEqual, type Material } from './material';
import type { MeshRenderer } from './meshRenderer';
import { boxOutsideFrustum, frustumPlanes } from './culling';

/** Floats per instance: the Object struct of meshData.wgsl (model, normal matrix). */
export const OBJECT_FLOATS = 32;

/** One instanced draw. */
export interface MeshBatch {
  mesh: Mesh;
  /** The material every instance is drawn with (the first of the look-alikes). */
  material: Material;
  /** Index of the first instance in the object array. */
  first: number;
  count: number;
}

interface BatchBuild extends MeshBatch {
  /** Indices into the renderer list. */
  items: number[];
}

export class DrawList {
  /** Main pass batches, in order of first appearance. */
  readonly main: MeshBatch[] = [];
  readonly shadow: MeshBatch[] = [];
  /** Instance data for both passes, OBJECT_FLOATS each. Grows as needed; `objectCount` instances are valid. */
  objects = new Float32Array<ArrayBuffer>(new ArrayBuffer(64 * OBJECT_FLOATS * 4));
  objectCount = 0;
  /** Instances in the main and the shadow batches. */
  mainInstances = 0;
  shadowInstances = 0;
  /** Renderers left out of the main pass because they're outside the view. */
  culled = 0;
  /** The distinct materials of the batches (the ones that need their uniforms uploaded). */
  readonly materials = new Set<Material>();

  private readonly viewPlanes = new Float32Array(24);
  private readonly lightPlanes = new Float32Array(24);
  private readonly canonical: Material[] = [];
  private readonly buckets = new Map<number, Material[]>();
  private readonly byMesh = new Map<Mesh, BatchBuild[]>();

  /**
   * Builds the batches for `renderers` (each with a mesh and a material). `lightViewProj` is the shadow map's
   * matrix, or null when nothing casts shadows. With `cull` off every renderer is drawn.
   */
  build(renderers: readonly MeshRenderer[], viewProj: Readonly<Mat4>, lightViewProj: Readonly<Mat4> | null, cull = true): void {
    this.main.length = this.shadow.length = 0;
    this.objectCount = this.mainInstances = this.shadowInstances = this.culled = 0;
    this.materials.clear();

    // Look-alike materials share the first one seen.
    const canonical = this.canonical;
    canonical.length = 0;
    const buckets = this.buckets;
    buckets.clear();
    for (const r of renderers) {
      const m = r.material!;
      const hash = materialHash(m);
      const bucket = buckets.get(hash);
      if (!bucket) {
        buckets.set(hash, [m]);
        canonical.push(m);
        continue;
      }
      let same = bucket.find((b) => b === m || materialsEqual(b, m));
      if (!same) bucket.push((same = m));
      canonical.push(same);
    }

    const view = frustumPlanes(viewProj, this.viewPlanes);
    const builds = this.byMesh;
    builds.clear();
    const mainBuilds: BatchBuild[] = [];
    for (let i = 0; i < renderers.length; i++) {
      const r = renderers[i], mesh = r.mesh!;
      if (cull && boxOutsideFrustum(view, r.transform.worldMatrix, mesh.boundsMin, mesh.boundsMax)) {
        this.culled++;
        continue;
      }
      this.add(builds, mainBuilds, mesh, canonical[i], i);
    }
    this.emit(mainBuilds, this.main, renderers);
    this.mainInstances = this.objectCount;

    if (lightViewProj) {
      const light = frustumPlanes(lightViewProj, this.lightPlanes);
      builds.clear();
      const shadowBuilds: BatchBuild[] = [];
      let anyMaterial: Material | null = null;
      for (let i = 0; i < renderers.length; i++) {
        const r = renderers[i], mesh = r.mesh!;
        if (!r.castShadows) continue;
        if (cull && boxOutsideFrustum(light, r.transform.worldMatrix, mesh.boundsMin, mesh.boundsMax)) continue;
        // Only alpha-tested casters read their material; the others can share a batch whatever they look like.
        const m = canonical[i];
        this.add(builds, shadowBuilds, mesh, m.alphaCutoff > 0 ? m : (anyMaterial ??= m), i);
      }
      this.emit(shadowBuilds, this.shadow, renderers);
      this.shadowInstances = this.objectCount - this.mainInstances;
    }
    builds.clear();
    buckets.clear();
    canonical.length = 0;
  }

  private add(builds: Map<Mesh, BatchBuild[]>, order: BatchBuild[], mesh: Mesh, material: Material, index: number): void {
    let list = builds.get(mesh);
    if (!list) builds.set(mesh, (list = []));
    for (const b of list) {
      if (b.material === material) {
        b.items.push(index);
        return;
      }
    }
    const b: BatchBuild = { mesh, material, first: 0, count: 0, items: [index] };
    list.push(b);
    order.push(b);
  }

  /** Writes the batches' instances into the object array and publishes them. */
  private emit(builds: BatchBuild[], out: MeshBatch[], renderers: readonly MeshRenderer[]): void {
    let total = 0;
    for (const b of builds) total += b.items.length;
    this.reserve(this.objectCount + total);
    const data = this.objects;
    for (const b of builds) {
      b.first = this.objectCount;
      b.count = b.items.length;
      for (const i of b.items) {
        const t = renderers[i].transform;
        data.set(t.worldMatrix, this.objectCount * OBJECT_FLOATS);
        data.set(t.normalMatrix, this.objectCount * OBJECT_FLOATS + 16);
        this.objectCount++;
      }
      this.materials.add(b.material);
      out.push({ mesh: b.mesh, material: b.material, first: b.first, count: b.count });
    }
  }

  private reserve(count: number): void {
    if (count * OBJECT_FLOATS <= this.objects.length) return;
    const grown = new Float32Array(new ArrayBuffer(2 ** Math.ceil(Math.log2(count)) * OBJECT_FLOATS * 4));
    grown.set(this.objects.subarray(0, this.objectCount * OBJECT_FLOATS));
    this.objects = grown;
  }
}
