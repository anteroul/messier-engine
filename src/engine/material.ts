import type { Vec3, Vec4 } from './math';
import type { ResourceRef } from './mesh';

/**
 * An image uploaded with a full mip chain: as an sRGB texture for colors (base color, emissive), and as a linear one
 * for data (normals, metallic-roughness, occlusion). Each copy is made the first time a slot of that kind uses it.
 */
export class Texture {
  gpu: GPUTexture | null = null;
  gpuLinear: GPUTexture | null = null;
  /** Source of the image (set when its asset is tagged), or null when it can't be saved. */
  ref: ResourceRef | null = null;
  constructor(
    public readonly source: ImageBitmap,
    public readonly name = 'texture',
  ) {}

  static async fromBlob(blob: Blob, name?: string): Promise<Texture> {
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    return new Texture(bitmap, name);
  }

  destroy(): void {
    this.gpu?.destroy();
    this.gpuLinear?.destroy();
    this.gpu = null;
    this.gpuLinear = null;
  }
}

export interface MaterialGPU {
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  /** The textures `bindGroup` was made with, in TEXTURE_SLOTS order. */
  boundTextures: (Texture | null)[];
}

/** A material's texture fields, in bind-group order. */
export const TEXTURE_SLOTS = ['baseColorTexture', 'normalTexture', 'metallicRoughnessTexture', 'occlusionTexture', 'emissiveTexture'] as const;
export type TextureSlot = (typeof TEXTURE_SLOTS)[number];

/** Slots whose textures hold data rather than colors, so they're sampled without sRGB decoding. */
export const LINEAR_TEXTURE_SLOTS: ReadonlySet<TextureSlot> = new Set(['normalTexture', 'metallicRoughnessTexture', 'occlusionTexture']);

/**
 * How a material's pixels meet what's behind them. `opaque` covers it (with `alphaCutoff`, in a cut-out). `alpha`
 * mixes by the base color's alpha (glass, smoke); `additive` adds on top, scaled by alpha (fire, beams). Blended
 * materials are drawn after everything opaque, sorted back to front, don't write depth and cast no shadows.
 */
export type BlendMode = 'opaque' | 'alpha' | 'additive';
export const BLEND_MODES: readonly BlendMode[] = ['opaque', 'alpha', 'additive'];

/** Fields saved with a scene (textures are saved separately, as refs). Keep in sync with clone(). */
export const MATERIAL_FIELDS = [
  'name', 'baseColor', 'metallic', 'roughness', 'emissive', 'emissiveStrength', 'normalScale', 'occlusionStrength', 'alphaCutoff', 'doubleSided',
  'unlit', 'blend',
] as const;

/** Metallic-roughness PBR material (glTF 2.0 compatible subset). All colors are linear. */
export class Material {
  name: string;
  baseColor: Vec4 = [1, 1, 1, 1];
  metallic = 0;
  roughness = 0.5;
  emissive: Vec3 = [0, 0, 0];
  emissiveStrength = 1;
  /** Multiplies baseColor (sRGB, alpha included). */
  baseColorTexture: Texture | null = null;
  /** Tangent-space normal map (glTF convention: +Y up in the image). Tangents come from the UVs per pixel. */
  normalTexture: Texture | null = null;
  /** Scales the normal map's X and Y. */
  normalScale = 1;
  /** Linear: G is roughness and B is metallic (glTF packing), multiplying the factors. */
  metallicRoughnessTexture: Texture | null = null;
  /** Linear: R is ambient occlusion. Often the same image as metallicRoughnessTexture (ORM). */
  occlusionTexture: Texture | null = null;
  /** How much the occlusion texture darkens ambient light (0 = none, 1 = fully). */
  occlusionStrength = 1;
  /** Multiplies emissive × emissiveStrength (sRGB). */
  emissiveTexture: Texture | null = null;
  /** Fragments with alpha below this are discarded. 0 disables alpha testing. */
  alphaCutoff = 0;
  doubleSided = false;
  /** Skips lighting entirely; outputs base color + emissive. */
  unlit = false;
  /** See BlendMode. Anything but `opaque` makes the base color's alpha the opacity. */
  blend: BlendMode = 'opaque';
  gpu: MaterialGPU | null = null;

  constructor(
    name = 'Material',
    init: Partial<Pick<Material, 'baseColor' | 'metallic' | 'roughness' | 'emissive' | 'emissiveStrength' | 'unlit' | 'doubleSided' | 'blend'>> = {},
  ) {
    this.name = name;
    Object.assign(this, init);
  }

  clone(): Material {
    const m = new Material(this.name);
    m.baseColor = [...this.baseColor];
    m.metallic = this.metallic;
    m.roughness = this.roughness;
    m.emissive = [...this.emissive];
    m.emissiveStrength = this.emissiveStrength;
    for (const slot of TEXTURE_SLOTS) m[slot] = this[slot];
    m.normalScale = this.normalScale;
    m.occlusionStrength = this.occlusionStrength;
    m.alphaCutoff = this.alphaCutoff;
    m.doubleSided = this.doubleSided;
    m.unlit = this.unlit;
    m.blend = this.blend;
    return m;
  }
}

const hashBuffer = new Float32Array(1);
const hashBits = new Uint32Array(hashBuffer.buffer);
const mix = (h: number, v: number): number => {
  hashBuffer[0] = v;
  return Math.imul(h ^ hashBits[0], 0x01000193) >>> 0;
};

/**
 * A number that's equal for materials that draw the same (see materialsEqual). Different materials can collide, so
 * confirm a match with materialsEqual.
 */
export function materialHash(m: Material): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < 4; i++) h = mix(h, m.baseColor[i]);
  for (let i = 0; i < 3; i++) h = mix(h, m.emissive[i]);
  h = mix(h, m.metallic);
  h = mix(h, m.roughness);
  h = mix(h, m.emissiveStrength);
  h = mix(h, m.normalScale);
  h = mix(h, m.occlusionStrength);
  h = mix(h, m.alphaCutoff);
  let flags = (m.doubleSided ? 1 : 0) | (m.unlit ? 2 : 0) | (BLEND_MODES.indexOf(m.blend) << 2);
  TEXTURE_SLOTS.forEach((slot, i) => {
    if (m[slot]) flags |= 16 << i;
  });
  return mix(h, flags);
}

/** Whether two materials draw the same: every field but the name, and the same textures. The renderer batches these. */
export function materialsEqual(a: Material, b: Material): boolean {
  for (let i = 0; i < 4; i++) if (a.baseColor[i] !== b.baseColor[i]) return false;
  for (let i = 0; i < 3; i++) if (a.emissive[i] !== b.emissive[i]) return false;
  for (const slot of TEXTURE_SLOTS) if (a[slot] !== b[slot]) return false;
  return (
    a.metallic === b.metallic &&
    a.roughness === b.roughness &&
    a.emissiveStrength === b.emissiveStrength &&
    a.normalScale === b.normalScale &&
    a.occlusionStrength === b.occlusionStrength &&
    a.alphaCutoff === b.alphaCutoff &&
    a.doubleSided === b.doubleSided &&
    a.unlit === b.unlit &&
    a.blend === b.blend
  );
}
