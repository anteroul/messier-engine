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

/** Fields saved with a scene (textures are saved separately, as refs). Keep in sync with clone(). */
export const MATERIAL_FIELDS = [
  'name', 'baseColor', 'metallic', 'roughness', 'emissive', 'emissiveStrength', 'normalScale', 'occlusionStrength', 'alphaCutoff', 'doubleSided',
  'unlit',
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
  gpu: MaterialGPU | null = null;

  constructor(name = 'Material', init: Partial<Pick<Material, 'baseColor' | 'metallic' | 'roughness' | 'emissive' | 'emissiveStrength' | 'unlit' | 'doubleSided'>> = {}) {
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
    return m;
  }
}
