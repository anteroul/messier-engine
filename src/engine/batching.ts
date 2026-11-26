// Turns the frame's mesh renderers into instanced draws.
//
// Renderers that share a mesh and have materials that look the same (MeshRenderer.clone() copies the material, so
// duplicates rarely share one object) become one batch: a single drawIndexed with an instance count. Each view gets
// its own batches, built from the renderers its frustum sees: the camera's, and one per shadow view (a cascade, a
// spot light, a face of a point light). Shadow views ignore materials except for alpha-tested ones, so there a
// mesh's casters usually collapse into one batch.
//
// Blended materials can't be grouped freely: they're drawn after the opaque batches, back to front (by the distance
// from the eye to the center of their bounds), so only neighbours in that order that share a mesh and a look merge
// into a batch. They cast no shadows.
//
// Every instance's Object (model + normal matrix) is written into `objects`, a batch's instances next to each
// other; the shaders index that array with the instance index, which starts at the batch's `first`.
//
// No GPU here: tests/unit/batching.test.ts runs it under Node.

import type { Mat4, Vec3 } from './math';
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
  /** The camera's opaque batches, in order of first appearance. */
  readonly main: MeshBatch[] = [];
  /** The camera's blended batches, back to front: draw them in this order, after `main`. */
  readonly transparent: MeshBatch[] = [];
  /** The casters of each shadow view, in the order the views were given. */
  readonly shadows: MeshBatch[][] = [];
  /** Instance data for every view, OBJECT_FLOATS each. Grows as needed; `objectCount` instances are valid. */
  objects = new Float32Array<ArrayBuffer>(new ArrayBuffer(64 * OBJECT_FLOATS * 4));
  objectCount = 0;
  /** Instances the camera draws (opaque and blended), and the ones of all the shadow views. */
  mainInstances = 0;
  shadowInstances = 0;
  /** Renderers left out of the main pass because they're outside the view. */
  culled = 0;
  /** The distinct materials of the batches (the ones that need their uniforms uploaded). */
  readonly materials = new Set<Material>();

  private readonly viewPlanes = new Float32Array(24);
  private readonly lightPlanes = new Float32Array(24);
  private readonly sorted: { index: number; distance: number }[] = [];
  private readonly canonical: Material[] = [];
  private readonly buckets = new Map<number, Material[]>();
  private readonly byMesh = new Map<Mesh, BatchBuild[]>();

  /**
   * Builds the batches for `renderers` (each with a mesh and a material), seen from `eye` through `viewProj`.
   * `shadowViews` are the view-projection matrices shadow maps are drawn with. With `cull` off every renderer is
   * drawn in every view.
   */
  build(renderers: readonly MeshRenderer[], viewProj: Readonly<Mat4>, eye: Readonly<Vec3>, shadowViews: readonly Readonly<Mat4>[] = [], cull = true): void {
    this.main.length = this.transparent.length = this.shadows.length = 0;
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
    const sorted = this.sorted;
    sorted.length = 0;
    for (let i = 0; i < renderers.length; i++) {
      const r = renderers[i], mesh = r.mesh!;
      const w = r.transform.worldMatrix;
      if (cull && boxOutsideFrustum(view, w, mesh.boundsMin, mesh.boundsMax)) {
        this.culled++;
        continue;
      }
      if (canonical[i].blend === 'opaque') {
        this.add(builds, mainBuilds, mesh, canonical[i], i);
        continue;
      }
      const a = mesh.boundsMin, b = mesh.boundsMax;
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, cz = (a[2] + b[2]) / 2;
      const dx = w[0] * cx + w[4] * cy + w[8] * cz + w[12] - eye[0];
      const dy = w[1] * cx + w[5] * cy + w[9] * cz + w[13] - eye[1];
      const dz = w[2] * cx + w[6] * cy + w[10] * cz + w[14] - eye[2];
      sorted.push({ index: i, distance: dx * dx + dy * dy + dz * dz });
    }
    this.emit(mainBuilds, this.main, renderers);

    // Farthest first (ties keep the renderers' order: the sort is stable); runs that look the same share a batch.
    sorted.sort((a, b) => b.distance - a.distance);
    const blended: BatchBuild[] = [];
    for (const { index } of sorted) {
      const last = blended[blended.length - 1];
      if (last && last.mesh === renderers[index].mesh && last.material === canonical[index]) last.items.push(index);
      else blended.push({ mesh: renderers[index].mesh!, material: canonical[index], first: 0, count: 0, items: [index] });
    }
    sorted.length = 0;
    this.emit(blended, this.transparent, renderers);
    this.mainInstances = this.objectCount;

    for (const shadowViewProj of shadowViews) {
      const light = frustumPlanes(shadowViewProj, this.lightPlanes);
      builds.clear();
      const shadowBuilds: BatchBuild[] = [];
      let anyMaterial: Material | null = null;
      for (let i = 0; i < renderers.length; i++) {
        const r = renderers[i], mesh = r.mesh!;
        const m = canonical[i];
        if (!r.castShadows || m.blend !== 'opaque') continue;
        if (cull && boxOutsideFrustum(light, r.transform.worldMatrix, mesh.boundsMin, mesh.boundsMax)) continue;
        // Only alpha-tested casters read their material; the others can share a batch whatever they look like.
        this.add(builds, shadowBuilds, mesh, m.alphaCutoff > 0 ? m : (anyMaterial ??= m), i);
      }
      const out: MeshBatch[] = [];
      this.emit(shadowBuilds, out, renderers);
      this.shadows.push(out);
    }
    this.shadowInstances = this.objectCount - this.mainInstances;
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
