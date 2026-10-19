import type { Vec3, Vec4 } from './math';

/** An image that will be uploaded as an sRGB texture with a full mip chain. */
export class Texture {
  gpu: GPUTexture | null = null;
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
    this.gpu = null;
  }
}

export interface MaterialGPU {
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  boundTexture: Texture | null;
}

/** Metallic-roughness PBR material (glTF 2.0 compatible subset). All colors are linear. */
export class Material {
  name: string;
  baseColor: Vec4 = [1, 1, 1, 1];
  metallic = 0;
  roughness = 0.5;
  emissive: Vec3 = [0, 0, 0];
  emissiveStrength = 1;
  baseColorTexture: Texture | null = null;
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
    m.baseColorTexture = this.baseColorTexture;
    m.alphaCutoff = this.alphaCutoff;
    m.doubleSided = this.doubleSided;
    m.unlit = this.unlit;
    return m;
  }
}
