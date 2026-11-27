import cubeWGSL from './shaders/cube.wgsl?raw';
import envCaptureWGSL from './shaders/envCapture.wgsl?raw';
import environmentWGSL from './shaders/environment.wgsl?raw';
import type { FrameGraph, TextureHandle } from './frameGraph';

// Image-based lighting from a gradient or image sky, by the split-sum approximation. When the sky changes, two compute
// passes rebake it: `environment capture` renders the sky (without the sun disc: lit surfaces already get the sun's
// highlight from its light) into a cube and averages its mips; `environment filter` prefilters that into the specular
// cube (a roughness per mip, by GGX importance sampling) and the irradiance cube (the cosine-weighted average, for
// diffuse light). The BRDF table, scale and bias to F0 by N·V and roughness, is made once. The mesh shader reads all
// three through the frame bind group (shaders/environment.wgsl has the math).

/** Faces of the captured sky, in texels: what the prefilter reads, at every mip. */
export const ENVIRONMENT_SIZE = 128;
/** Faces of the specular cube's first mip; each further mip is the next roughness. */
export const SPECULAR_SIZE = 128;
/** Mips of the specular cube: roughness 0, 0.2, … 1. mesh.wgsl reads it with this count. */
export const SPECULAR_LEVELS = 6;
export const IRRADIANCE_SIZE = 32;
const LUT_SIZE = 64;
const FORMAT: GPUTextureFormat = 'rgba16float';
/** Which of the environment's mips the irradiance reads: 16² faces, plenty for something that smooth. */
const IRRADIANCE_SOURCE_LEVEL = 3;

const ENV_MIPS = Math.log2(ENVIRONMENT_SIZE) + 1;

/** The passes' texture handles in this frame's graph, for the passes that sample them. */
export interface EnvironmentHandles {
  specular: TextureHandle;
  irradiance: TextureHandle;
}

export class EnvironmentMaps {
  /** The prefiltered sky, a cube with SPECULAR_LEVELS mips. */
  readonly specularView: GPUTextureView;
  readonly irradianceView: GPUTextureView;
  /** The BRDF table (r = scale, g = bias to F0), by (N·V, roughness). */
  readonly brdfView: GPUTextureView;
  /** Linear, clamped, mipmapped: for the cubes and the table. */
  readonly sampler: GPUSampler;
  /** How many times the sky has been baked. */
  bakes = 0;

  private readonly env: GPUTexture;
  private readonly specular: GPUTexture;
  private readonly irradiance: GPUTexture;
  private readonly capturePipeline: GPUComputePipeline;
  private readonly downsamplePipeline: GPUComputePipeline;
  private readonly prefilterPipeline: GPUComputePipeline;
  private readonly irradiancePipeline: GPUComputePipeline;
  private readonly captureOut: GPUBindGroup;
  private readonly downsampleGroups: GPUBindGroup[] = [];
  private readonly prefilterGroups: GPUBindGroup[] = [];
  private readonly irradianceGroup: GPUBindGroup;
  private captureSky: { group: GPUBindGroup; frame: GPUBuffer; sky: GPUTextureView } | null = null;
  private bakedKey: Float32Array | null = null;
  private bakedTexture: unknown = undefined;

  constructor(
    private readonly device: GPUDevice,
    commonWGSL: string,
  ) {
    const cube = (label: string, size: number, mips: number) =>
      device.createTexture({
        label,
        size: [size, size, 6],
        format: FORMAT,
        mipLevelCount: mips,
        // Copying out is for tests/render, which reads them back.
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
    this.env = cube('environment', ENVIRONMENT_SIZE, ENV_MIPS);
    this.specular = cube('specular-environment', SPECULAR_SIZE, SPECULAR_LEVELS);
    this.irradiance = cube('irradiance', IRRADIANCE_SIZE, 1);
    this.specularView = this.specular.createView({ dimension: 'cube' });
    this.irradianceView = this.irradiance.createView({ dimension: 'cube' });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });

    const captureModule = device.createShaderModule({ label: 'environment-capture', code: commonWGSL + cubeWGSL + envCaptureWGSL });
    const filterModule = device.createShaderModule({ label: 'environment', code: cubeWGSL + environmentWGSL });
    const pipeline = (module: GPUShaderModule, entryPoint: string) =>
      device.createComputePipeline({ label: `environment ${entryPoint}`, layout: 'auto', compute: { module, entryPoint } });
    this.capturePipeline = pipeline(captureModule, 'capture');
    this.downsamplePipeline = pipeline(filterModule, 'downsample');
    this.prefilterPipeline = pipeline(filterModule, 'prefilter');
    this.irradiancePipeline = pipeline(filterModule, 'irradiance');

    const level = (t: GPUTexture, mip: number) => t.createView({ dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 });
    this.captureOut = device.createBindGroup({
      label: 'environment capture out',
      layout: this.capturePipeline.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: level(this.env, 0) }],
    });
    for (let mip = 1; mip < ENV_MIPS; mip++) {
      this.downsampleGroups.push(device.createBindGroup({
        label: `environment mip ${mip}`,
        layout: this.downsamplePipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: level(this.env, mip - 1) }, { binding: 1, resource: level(this.env, mip) }],
      }));
    }
    const envCube = this.env.createView({ dimension: 'cube' });
    const params = (values: number[]) => {
      const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, new Float32Array(values));
      return buffer;
    };
    for (let mip = 0; mip < SPECULAR_LEVELS; mip++) {
      const roughness = mip / (SPECULAR_LEVELS - 1);
      this.prefilterGroups.push(device.createBindGroup({
        label: `specular environment ${mip}`,
        layout: this.prefilterPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: envCube },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: level(this.specular, mip) },
          { binding: 3, resource: { buffer: params([roughness, mip < 2 ? 64 : 128, ENVIRONMENT_SIZE, ENV_MIPS]) } },
        ],
      }));
    }
    this.irradianceGroup = device.createBindGroup({
      label: 'irradiance',
      layout: this.irradiancePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: envCube },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: level(this.irradiance, 0) },
        { binding: 3, resource: { buffer: params([IRRADIANCE_SOURCE_LEVEL, 0, 0, 0]) } },
      ],
    });

    // The BRDF table doesn't depend on the sky: made once, now.
    const lut = device.createTexture({
      label: 'brdf-lut',
      size: [LUT_SIZE, LUT_SIZE],
      format: FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.brdfView = lut.createView();
    const lutPipeline = pipeline(filterModule, 'brdfLut');
    const encoder = device.createCommandEncoder({ label: 'brdf-lut' });
    const pass = encoder.beginComputePass({ label: 'brdf-lut' });
    pass.setPipeline(lutPipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: lutPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.brdfView }] }));
    pass.dispatchWorkgroups(LUT_SIZE / 8, LUT_SIZE / 8);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Whether the sky differs from the one last baked: `key` holds everything the capture reads (the frame's sky values,
   * without how strongly it lights the scene, which applies when it's read), and `texture` is the image sky's.
   */
  needsBake(key: Float32Array, texture: unknown): boolean {
    const last = this.bakedKey;
    if (!last || texture !== this.bakedTexture || last.length !== key.length) return true;
    for (let i = 0; i < key.length; i++) if (last[i] !== key[i]) return true;
    return false;
  }

  /**
   * Declares the passes that rebake the sky into this frame's graph, and remembers it as baked. The capture reads the
   * frame uniform and the sky texture through `frame` and `sky` (the frame bind group's).
   */
  bake(g: FrameGraph, key: Float32Array, texture: unknown, frame: GPUBuffer, sky: GPUTextureView, skySampler: GPUSampler): EnvironmentHandles {
    this.bakedKey = key.slice();
    this.bakedTexture = texture;
    this.bakes++;
    const c = this.captureSky;
    if (!c || c.frame !== frame || c.sky !== sky) {
      const group = this.device.createBindGroup({
        label: 'environment capture sky',
        layout: this.capturePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: frame } },
          { binding: 4, resource: sky },
          { binding: 5, resource: skySampler },
        ],
      });
      this.captureSky = { group, frame, sky };
    }
    const env = g.importTexture('environment', this.env);
    const specular = g.importTexture('specular environment', this.specular);
    const irradiance = g.importTexture('irradiance', this.irradiance);
    const groups = (size: number) => Math.ceil(size / 8);
    g.addComputePass('environment capture', (pass) => {
      pass.writeStorage(env);
      return (pe) => {
        pe.setPipeline(this.capturePipeline);
        pe.setBindGroup(0, this.captureSky!.group);
        pe.setBindGroup(1, this.captureOut);
        pe.dispatchWorkgroups(groups(ENVIRONMENT_SIZE), groups(ENVIRONMENT_SIZE), 6);
        // Each mip from the one above: separate dispatches, so each reads what the previous one wrote.
        pe.setPipeline(this.downsamplePipeline);
        this.downsampleGroups.forEach((group, i) => {
          pe.setBindGroup(0, group);
          const size = ENVIRONMENT_SIZE >> (i + 1);
          pe.dispatchWorkgroups(groups(size), groups(size), 6);
        });
      };
    });
    g.addComputePass('environment filter', (pass) => {
      pass.read(env);
      pass.writeStorage(specular);
      pass.writeStorage(irradiance);
      return (pe) => {
        pe.setPipeline(this.prefilterPipeline);
        this.prefilterGroups.forEach((group, mip) => {
          pe.setBindGroup(0, group);
          const size = Math.max(1, SPECULAR_SIZE >> mip);
          pe.dispatchWorkgroups(groups(size), groups(size), 6);
        });
        pe.setPipeline(this.irradiancePipeline);
        pe.setBindGroup(0, this.irradianceGroup);
        pe.dispatchWorkgroups(groups(IRRADIANCE_SIZE), groups(IRRADIANCE_SIZE), 6);
      };
    });
    return { specular, irradiance };
  }
}
