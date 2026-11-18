// Shader variants for the mesh family of pipelines (the main pass and the shadow pass).
//
// Everything that changes a mesh pipeline is a field of a MeshVariantKey; meshVariantKey() derives it from the pass,
// the material, the mesh and the pass's render target, and the draw loops ask MeshPipelines for the pipeline of that
// key. Material features that a uniform or a placeholder texture can express (unlit, alpha cutoff in the main pass,
// the material maps) stay runtime branches in mesh.wgsl, so they don't multiply pipelines.
//
// A branch inside a stage that every variant of a pass has should be a WGSL `override` constant, set from the key
// through the pipeline's `constants`. Different vertex inputs, bindings or stages can't be overridden away (an entry
// point's interface is fixed), so those use another entry point or another combination of WGSL pieces: the shadow
// pass's alpha test is one (UVs in, a fragment stage the opaque variant doesn't have). Shader modules and pipeline layouts are cached apart from
// pipelines, since many variants share them.

import type { Material } from './material';
import type { Mesh } from './mesh';
import type { RenderTarget } from './frameGraph';

export type MeshPass = 'main' | 'shadow';

/** Everything that selects a mesh pipeline. Plain data; variantKeyString() is its identity. */
export interface MeshVariantKey {
  pass: MeshPass;
  cull: GPUCullMode;
  /** Discard below the material's alpha cutoff. Only the shadow pass uses it; the main pass branches at runtime. */
  alphaTest: boolean;
  /** Null for depth-only passes. */
  colorFormat: GPUTextureFormat | null;
  sampleCount: number;
  depthFormat: GPUTextureFormat;
  /** Reversed-Z 'greater' for the main pass, 'less' for shadow maps. */
  depthCompare: GPUCompareFunction;
}

/** The key's fields in a fixed order, for its string form. Add new fields here too. */
const KEY_FIELDS = ['pass', 'cull', 'alphaTest', 'colorFormat', 'sampleCount', 'depthFormat', 'depthCompare'] as const satisfies readonly (keyof MeshVariantKey)[];

export function variantKeyString(key: MeshVariantKey): string {
  return KEY_FIELDS.map((f) => `${f}=${String(key[f])}`).join(';');
}

/**
 * The pipeline key for drawing `mesh` with `material` in `pass` into `target`. The only place that decides mesh
 * pipelines: draw loops, prewarming and tests all go through it.
 */
export function meshVariantKey(
  pass: MeshPass,
  material: Pick<Material, 'doubleSided' | 'alphaCutoff'>,
  _mesh: Mesh | null,
  target: RenderTarget,
): MeshVariantKey {
  if (!target.depthFormat) throw new Error(`Mesh pipelines need a depth attachment (${pass} pass)`);
  const shadow = pass === 'shadow';
  return {
    pass,
    // Shadow maps draw both faces, so thin and open meshes cast shadows from either side.
    cull: shadow || material.doubleSided ? 'none' : 'back',
    alphaTest: shadow && material.alphaCutoff > 0,
    colorFormat: target.colorFormats[0] ?? null,
    sampleCount: target.sampleCount,
    depthFormat: target.depthFormat,
    depthCompare: shadow ? 'less' : 'greater',
  };
}

/** Every valid key for these targets: the variants a project can need. Tests build them all. */
export function allMeshVariantKeys(targets: Record<MeshPass, RenderTarget>): MeshVariantKey[] {
  const out: MeshVariantKey[] = [];
  for (const pass of ['main', 'shadow'] as const) {
    for (const doubleSided of [false, true]) {
      for (const alphaCutoff of [0, 0.5]) out.push(meshVariantKey(pass, { doubleSided, alphaCutoff }, null, targets[pass]));
    }
  }
  const seen = new Set<string>();
  return out.filter((k) => {
    const s = variantKeyString(k);
    return !seen.has(s) && !!seen.add(s);
  });
}

/** What the variants are made of: the WGSL pieces and the bind group layouts the renderer owns. */
export interface MeshPipelineSources {
  /** Prepended to the main pass shader (frame bindings, skyRadiance). */
  common: string;
  /** Prepended to both mesh shaders: the Material and Object structs, mirrored by the renderer's packing. */
  meshData: string;
  mesh: string;
  shadow: string;
  layouts: {
    frame: GPUBindGroupLayout;
    material: GPUBindGroupLayout;
    object: GPUBindGroupLayout;
    shadowFrame: GPUBindGroupLayout;
  };
  /** Interleaved mesh vertex stride (position 3, normal 3, uv 2 floats). */
  vertexStride: number;
}

/** Mesh pipelines by variant: built on demand (counted, so hitches show) or ahead of time with prewarm(). */
export class MeshPipelines {
  /** Pipelines built synchronously by get() so far. RenderStats.pipelineBuilds reports a frame's share. */
  builds = 0;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly layouts = new Map<string, GPUPipelineLayout>();

  constructor(
    private readonly device: GPUDevice,
    private readonly sources: MeshPipelineSources,
  ) {}

  /** Pipelines in the cache. */
  get size(): number {
    return this.pipelines.size;
  }

  has(key: MeshVariantKey): boolean {
    return this.pipelines.has(variantKeyString(key));
  }

  /** The pipeline for `key`, built now if it isn't cached (a hitch, counted in `builds`). */
  get(key: MeshVariantKey): GPURenderPipeline {
    const id = variantKeyString(key);
    let p = this.pipelines.get(id);
    if (!p) {
      p = this.device.createRenderPipeline(this.describe(key, id));
      this.pipelines.set(id, p);
      this.builds++;
    }
    return p;
  }

  /** Builds the pipelines of `keys` that aren't cached, in the background (createRenderPipelineAsync). */
  prewarm(keys: readonly MeshVariantKey[]): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const key of keys) {
      const id = variantKeyString(key);
      if (this.pipelines.has(id)) continue;
      let job = this.pending.get(id);
      if (!job) {
        job = this.device
          .createRenderPipelineAsync(this.describe(key, id))
          .then((p) => {
            // get() may have built it meanwhile; keep that one.
            if (!this.pipelines.has(id)) this.pipelines.set(id, p);
          })
          .finally(() => this.pending.delete(id));
        this.pending.set(id, job);
      }
      jobs.push(job);
    }
    return Promise.all(jobs).then(() => undefined);
  }

  private module(name: 'mesh' | 'shadow'): GPUShaderModule {
    let m = this.modules.get(name);
    if (!m) {
      const s = this.sources;
      const code = name === 'mesh' ? s.common + s.meshData + s.mesh : s.meshData + s.shadow;
      m = this.device.createShaderModule({ label: name, code });
      this.modules.set(name, m);
    }
    return m;
  }

  /**
   * Main: frame, material, object. Shadow: its own group 0 (the frame group holds the shadow map being drawn into),
   * then object, then, for the alpha test, the material (the same bind groups the main pass uses).
   */
  private pipelineLayout(key: MeshVariantKey): GPUPipelineLayout {
    const id = key.pass === 'main' ? 'main' : key.alphaTest ? 'shadow+material' : 'shadow';
    let l = this.layouts.get(id);
    if (!l) {
      const { frame, material, object, shadowFrame } = this.sources.layouts;
      const groups = id === 'main' ? [frame, material, object] : id === 'shadow' ? [shadowFrame, object] : [shadowFrame, object, material];
      l = this.device.createPipelineLayout({ label: id, bindGroupLayouts: groups });
      this.layouts.set(id, l);
    }
    return l;
  }

  private describe(key: MeshVariantKey, label: string): GPURenderPipelineDescriptor {
    const stride = this.sources.vertexStride;
    const layout = this.pipelineLayout(key);
    const primitive: GPUPrimitiveState = { topology: 'triangle-list', cullMode: key.cull, frontFace: 'ccw' };
    const multisample: GPUMultisampleState = { count: key.sampleCount };
    if (key.pass === 'main') {
      const module = this.module('mesh');
      return {
        label,
        layout,
        vertex: {
          module,
          entryPoint: 'vs_main',
          buffers: [{
            arrayStride: stride,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32x2' },
            ],
          }],
        },
        fragment: { module, entryPoint: 'fs_main', targets: key.colorFormat ? [{ format: key.colorFormat }] : [] },
        primitive,
        depthStencil: { format: key.depthFormat, depthWriteEnabled: true, depthCompare: key.depthCompare },
        multisample,
      };
    }
    // The opaque shadow variant reads positions only and has no fragment stage. The alpha test needs UVs in, so it's
    // another entry point (an override can't change an entry point's inputs), with a fragment stage that discards.
    const module = this.module('shadow');
    const attributes: GPUVertexAttribute[] = [{ shaderLocation: 0, offset: 0, format: 'float32x3' }];
    if (key.alphaTest) attributes.push({ shaderLocation: 1, offset: 24, format: 'float32x2' });
    return {
      label,
      layout,
      vertex: { module, entryPoint: key.alphaTest ? 'vs_alpha' : 'vs_main', buffers: [{ arrayStride: stride, attributes }] },
      ...(key.alphaTest ? { fragment: { module, entryPoint: 'fs_alpha', targets: [] } } : {}),
      primitive,
      depthStencil: { format: key.depthFormat, depthWriteEnabled: true, depthCompare: key.depthCompare, depthBias: 2, depthBiasSlopeScale: 2.5 },
      multisample,
    };
  }
}
