import commonWGSL from './shaders/common.wgsl?raw';
import meshWGSL from './shaders/mesh.wgsl?raw';
import shadowWGSL from './shaders/shadow.wgsl?raw';
import gridWGSL from './shaders/grid.wgsl?raw';
import overlayWGSL from './shaders/overlay.wgsl?raw';
import mipmapWGSL from './shaders/mipmap.wgsl?raw';
import shape2dWGSL from './shaders/shape2d.wgsl?raw';
import skyWGSL from './shaders/sky.wgsl?raw';
import meshDataWGSL from './shaders/meshData.wgsl?raw';
import tonemapWGSL from './shaders/tonemap.wgsl?raw';
import { mat4, vec3, type Mat4, type Vec3 } from './math';
import { VERTEX_STRIDE_BYTES, type Mesh } from './mesh';
import { LINEAR_TEXTURE_SLOTS, TEXTURE_SLOTS, type Material, type Texture } from './material';
import { Light, LIGHT_TYPE_INDEX } from './light';
import { MeshRenderer } from './meshRenderer';
import type { Scene } from './scene';
import type { Camera } from './camera';
import { OVERLAY_STRIDE_FLOATS, type OverlayBuilder } from './overlay';
import { Batch2D, VERTEX2D_FLOATS, type Draw2D } from './draw2d';
import { ATLAS_SIZE, fontAtlas } from './font';
import { Renderer2D } from './shapes2d';
import type { SkyMode } from './sky';
import { FrameGraph, type RenderTarget } from './frameGraph';
import { DrawList, OBJECT_FLOATS, type MeshBatch } from './batching';
import { GpuTimer } from './gpuTimer';
import { profiler } from './profiler';
import { MAX_LOCAL_SHADOW_LAYERS, MAX_SHADOW_CASCADES, assignLocalShadows, computeCascades, type LocalShadowLight } from './shadows';
import { frustumPlanes } from './culling';
import { MeshPipelines, allMeshVariantKeys, meshVariantKey, type MeshPass, type MeshVariantKey } from './pipelines';

export const MAX_LIGHTS = 128;
/** Texels across each cascade's layer of the shadow map. */
const SHADOW_MAP_SIZE = 2048;
/** Texels across each layer of the point and spot light shadow map. */
const LOCAL_SHADOW_MAP_SIZE = 1024;
/**
 * Each shadow view's matrix sits at its own offset of the shadow frame buffer (uniform offsets align to 256): the
 * cascades first, then the point and spot light layers.
 */
const SHADOW_SLOT_SIZE = 256;
const SHADOW_SLOTS = MAX_SHADOW_CASCADES + MAX_LOCAL_SHADOW_LAYERS;
/** One instance in the object storage buffer (model + normal matrix). */
const OBJECT_SIZE = OBJECT_FLOATS * 4;
const FRAME_UNIFORM_SIZE = 592;
const MATERIAL_UNIFORM_SIZE = 64;
const LIGHT_FLOATS = 16;
/** Main pass uses reversed-Z: clear to 0, 'greater' passes nearer fragments. */
const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
/** Meshes and the sky render linear radiance into this; the tonemap pass turns it into display colors. */
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const SHADOW_FORMAT: GPUTextureFormat = 'depth32float';
const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';
/** For textures that hold data (normals, metallic-roughness, occlusion), not colors. */
const LINEAR_TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export interface RenderOptions {
  time?: number;
  /**
   * How far the frame is between two fixed steps (Time.alpha, 0…1), for blending physics poses. Passed through
   * for renderers that interpolate; this one draws the current poses.
   */
  alpha?: number;
  grid?: boolean;
  overlay?: OverlayBuilder | null;
  /** Immediate-mode 2D layer drawn over everything else (the engine passes `draw2d`). */
  draw2d?: Draw2D | null;
  /** Draw screen-space Shape2D/Text2D components (default true). */
  screen2D?: boolean;
}

export interface RenderStats {
  /** Draw calls of the main and overlay passes (a batch of instances is one). */
  drawCalls: number;
  triangles: number;
  /** Mesh instances drawn in the main pass. */
  instances: number;
  /** Mesh renderers skipped because they're outside the view. */
  culled: number;
  lights: number;
  /** Mesh instances drawn into the shadow map, over all its cascades. */
  shadowCasters: number;
  /** Shape2D/Text2D components drawn. */
  elements2D: number;
  /** Mesh pipelines built during the frame because they weren't prewarmed (each one a hitch). */
  pipelineBuilds: number;
}

const SKY_MODE_INDEX: Record<SkyMode, number> = { color: 0, gradient: 1, image: 2 };

const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/**
 * Forward renderer: shadow passes (a cascade each for one directional light, a layer each for point and spot
 * lights), a 4x MSAA HDR main pass (lit meshes, the sky), a tonemap pass, then the display-space overlay pass (editor
 * grid, 2D, overlay helpers) resolved into the canvas. Each frame declares its passes on a FrameGraph, which orders
 * them and owns their transient textures.
 */
export class Renderer {
  readonly device: GPUDevice;
  readonly canvas: HTMLCanvasElement;
  readonly format: GPUTextureFormat;
  readonly sampleCount = 4;
  width = 0;
  height = 0;
  readonly stats: RenderStats = { drawCalls: 0, triangles: 0, instances: 0, culled: 0, lights: 0, shadowCasters: 0, elements2D: 0, pipelineBuilds: 0 };
  /** Skip meshes outside the camera's view (and, in the shadow passes, outside their cascade). */
  frustumCulling = true;

  private readonly context: GPUCanvasContext;
  /** Declares, orders and runs each frame's passes, and owns their transient textures (MSAA color, depth). */
  private readonly graph: FrameGraph;
  /** Times the graph's passes for the profiler; null when the device has no `timestamp-query`. */
  private readonly gpuTimer: GpuTimer | null;

  private readonly frameLayout: GPUBindGroupLayout;
  private readonly materialLayout: GPUBindGroupLayout;
  private readonly objectLayout: GPUBindGroupLayout;
  private readonly shadowFrameLayout: GPUBindGroupLayout;

  /** Mesh and shadow pipelines by variant (see pipelines.ts). */
  readonly meshPipelines: MeshPipelines;
  private readonly gridPipeline: GPURenderPipeline;
  private readonly overlayDepthPipeline: GPURenderPipeline;
  private readonly overlayTopPipeline: GPURenderPipeline;
  private readonly mipPipelines: Record<'srgb' | 'linear', GPURenderPipeline>;
  private readonly skyPipeline: GPURenderPipeline;
  private readonly tonemapPipeline: GPURenderPipeline;
  private readonly tonemapLayout: GPUBindGroupLayout;
  private readonly tonemapBuffer: GPUBuffer;
  /** The HDR texture `tonemapGroup` reads (the graph's pool may hand out another one). */
  private tonemapSource: GPUTexture | null = null;
  private tonemapGroup: GPUBindGroup | null = null;
  private readonly tonemapData = new Float32Array(4);
  private readonly world2DPipeline: GPURenderPipeline;
  private readonly screen2DPipeline: GPURenderPipeline;

  private readonly frameBuffer: GPUBuffer;
  private readonly lightBuffer: GPUBuffer;
  private readonly shadowFrameBuffer: GPUBuffer;
  private readonly shadowMap: GPUTexture;
  private readonly shadowMapView: GPUTextureView;
  /** Point and spot light shadows: a layer per spot light, six per point light (see shadows.ts). */
  private readonly localShadowMap: GPUTexture;
  private readonly localShadowMapView: GPUTextureView;
  /** Each local shadow layer's matrix, for the main pass. */
  private readonly localShadowBuffer: GPUBuffer;
  private readonly localShadowData = new Float32Array(MAX_LOCAL_SHADOW_LAYERS * 16);
  private readonly viewPlanes = new Float32Array(24);
  private frameBindGroup: GPUBindGroup;
  /** The sky texture `frameBindGroup` was made with (null: the white placeholder). */
  private frameSky: Texture | null = null;
  private readonly shadowSampler: GPUSampler;
  private readonly skySampler: GPUSampler;
  /** One per shadow view (SHADOW_SLOTS): its matrix. */
  private readonly shadowFrameBindGroups: GPUBindGroup[];
  private readonly textureSampler: GPUSampler;
  private readonly mipSampler: GPUSampler;
  private readonly whiteTextureView: GPUTextureView;

  private objectBuffer: GPUBuffer | null = null;
  private objectBindGroup: GPUBindGroup | null = null;
  private objectCapacity = 0;
  private readonly drawList = new DrawList();

  private overlayBuffer: GPUBuffer | null = null;
  private overlayCapacity = 0;

  private readonly atlasTexture: GPUTexture;
  private readonly view2DBuffers: [GPUBuffer, GPUBuffer];
  /** World-space and screen-space 2D bind groups (same atlas, different view matrix). */
  private readonly view2DGroups: [GPUBindGroup, GPUBindGroup];
  private buffer2D: GPUBuffer | null = null;
  private capacity2D = 0;
  private atlasGeneration = -1;
  private readonly world2D = new Batch2D();
  private readonly screen2D = new Batch2D();
  private readonly list2D: { r: Renderer2D; key: number }[] = [];
  private readonly matrix2D = new Float32Array(16);

  private readonly frameData = new ArrayBuffer(FRAME_UNIFORM_SIZE);
  private readonly lightData = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS);
  private readonly draws: MeshRenderer[] = [];
  private readonly materialData = new Float32Array(MATERIAL_UNIFORM_SIZE / 4);

  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    if (!('gpu' in navigator) || !navigator.gpu) {
      throw new Error('WebGPU is not available in this browser.');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No suitable WebGPU adapter was found.');
    // Optional: lets the profiler time passes on the GPU.
    const requiredFeatures: GPUFeatureName[] = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
    const device = await adapter.requestDevice({ requiredFeatures });
    return new Renderer(canvas, device);
  }

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice) {
    this.canvas = canvas;
    this.device = device;
    device.lost.then((info) => console.error(`WebGPU device lost (${info.reason}): ${info.message}`));
    device.addEventListener('uncapturederror', (e) => console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message));

    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Could not create a WebGPU canvas context.');
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.graph = new FrameGraph(device);
    this.gpuTimer = device.features.has('timestamp-query') ? new GpuTimer(device) : null;
    if (this.gpuTimer) this.gpuTimer.onResults = (names, ms) => profiler.setGpuTimes(names, ms);
    profiler.gpuSupported = !!this.gpuTimer;

    const VS = GPUShaderStage.VERTEX, FS = GPUShaderStage.FRAGMENT;

    // --- Bind group layouts -------------------------------------------------
    this.frameLayout = device.createBindGroupLayout({
      label: 'frame',
      entries: [
        { binding: 0, visibility: VS | FS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FS, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: FS, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 3, visibility: FS, sampler: { type: 'comparison' } },
        { binding: 4, visibility: FS, texture: { sampleType: 'float' } },
        { binding: 5, visibility: FS, sampler: { type: 'filtering' } },
        { binding: 6, visibility: FS, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 7, visibility: FS, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.materialLayout = device.createBindGroupLayout({
      label: 'material',
      entries: [
        { binding: 0, visibility: FS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FS, texture: { sampleType: 'float' } },
        { binding: 2, visibility: FS, sampler: { type: 'filtering' } },
        { binding: 3, visibility: FS, texture: { sampleType: 'float' } },
        { binding: 4, visibility: FS, texture: { sampleType: 'float' } },
        { binding: 5, visibility: FS, texture: { sampleType: 'float' } },
        { binding: 6, visibility: FS, texture: { sampleType: 'float' } },
      ],
    });
    this.objectLayout = device.createBindGroupLayout({
      label: 'object',
      entries: [{ binding: 0, visibility: VS, buffer: { type: 'read-only-storage', minBindingSize: OBJECT_SIZE } }],
    });
    this.shadowFrameLayout = device.createBindGroupLayout({
      label: 'shadow-frame',
      entries: [{ binding: 0, visibility: VS, buffer: { type: 'uniform' } }],
    });

    // --- Pipelines ----------------------------------------------------------
    const multisample: GPUMultisampleState = { count: this.sampleCount };
    this.meshPipelines = new MeshPipelines(device, {
      common: commonWGSL,
      meshData: meshDataWGSL,
      mesh: meshWGSL,
      shadow: shadowWGSL,
      layouts: { frame: this.frameLayout, material: this.materialLayout, object: this.objectLayout, shadowFrame: this.shadowFrameLayout },
      vertexStride: VERTEX_STRIDE_BYTES,
    });

    const frameOnlyLayout = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout] });
    const gridModule = device.createShaderModule({ label: 'grid', code: commonWGSL + gridWGSL });
    this.gridPipeline = device.createRenderPipeline({
      label: 'grid',
      layout: frameOnlyLayout,
      vertex: { module: gridModule, entryPoint: 'vs_main' },
      fragment: { module: gridModule, entryPoint: 'fs_main', targets: [{ format: this.format, blend: ALPHA_BLEND }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater' },
      multisample,
    });

    const overlayModule = device.createShaderModule({ label: 'overlay', code: commonWGSL + overlayWGSL });
    const makeOverlayPipeline = (depthCompare: GPUCompareFunction) =>
      device.createRenderPipeline({
        label: `overlay-${depthCompare}`,
        layout: frameOnlyLayout,
        vertex: {
          module: overlayModule,
          entryPoint: 'vs_main',
          buffers: [
            {
              arrayStride: OVERLAY_STRIDE_FLOATS * 4,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x4' },
              ],
            },
          ],
        },
        fragment: { module: overlayModule, entryPoint: 'fs_main', targets: [{ format: this.format, blend: ALPHA_BLEND }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare },
        multisample,
      });
    this.overlayDepthPipeline = makeOverlayPipeline('greater-equal');
    this.overlayTopPipeline = makeOverlayPipeline('always');

    const skyModule = device.createShaderModule({ label: 'sky', code: commonWGSL + skyWGSL });
    this.skyPipeline = device.createRenderPipeline({
      label: 'sky',
      layout: frameOnlyLayout,
      vertex: { module: skyModule, entryPoint: 'vs_main' },
      fragment: { module: skyModule, entryPoint: 'fs_main', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
      // At depth 0 (the far plane): passes only where the depth buffer still holds its clear value.
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      multisample,
    });

    this.tonemapLayout = device.createBindGroupLayout({
      label: 'tonemap',
      entries: [
        { binding: 0, visibility: FS, texture: { sampleType: 'unfilterable-float', multisampled: true } },
        { binding: 1, visibility: FS, buffer: { type: 'uniform' } },
      ],
    });
    const tonemapModule = device.createShaderModule({ label: 'tonemap', code: tonemapWGSL });
    this.tonemapPipeline = device.createRenderPipeline({
      label: 'tonemap',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.tonemapLayout] }),
      vertex: { module: tonemapModule, entryPoint: 'vs_main' },
      fragment: { module: tonemapModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
      multisample,
    });
    this.tonemapBuffer = device.createBuffer({ label: 'tonemap', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const mipModule = device.createShaderModule({ label: 'mipmap', code: mipmapWGSL });
    const makeMipPipeline = (format: GPUTextureFormat) =>
      device.createRenderPipeline({
        label: `mipmap-${format}`,
        layout: 'auto',
        vertex: { module: mipModule, entryPoint: 'vs_main' },
        fragment: { module: mipModule, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
    this.mipPipelines = { srgb: makeMipPipeline(TEXTURE_FORMAT), linear: makeMipPipeline(LINEAR_TEXTURE_FORMAT) };

    const layout2D = device.createBindGroupLayout({
      label: '2d',
      entries: [
        { binding: 0, visibility: VS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FS, texture: { sampleType: 'float' } },
        { binding: 2, visibility: FS, sampler: { type: 'filtering' } },
      ],
    });
    const module2D = device.createShaderModule({ label: 'shape2d', code: shape2dWGSL });
    const make2DPipeline = (label: string, depthCompare: GPUCompareFunction) =>
      device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout2D] }),
        vertex: {
          module: module2D,
          entryPoint: 'vs_main',
          buffers: [
            {
              arrayStride: VERTEX2D_FLOATS * 4,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x2' },
                { shaderLocation: 2, offset: 20, format: 'float32x4' },
                { shaderLocation: 3, offset: 36, format: 'float32' },
              ],
            },
          ],
        },
        fragment: { module: module2D, entryPoint: 'fs_main', targets: [{ format: this.format, blend: ALPHA_BLEND }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        // Soft edges: test against the scene but don't write, so later 2D layers blend over earlier ones.
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare },
        multisample,
      });
    this.world2DPipeline = make2DPipeline('2d-world', 'greater-equal');
    this.screen2DPipeline = make2DPipeline('2d-screen', 'always');

    // --- Static resources ---------------------------------------------------
    this.frameBuffer = device.createBuffer({ label: 'frame', size: FRAME_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lightBuffer = device.createBuffer({ label: 'lights', size: MAX_LIGHTS * LIGHT_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.shadowFrameBuffer = device.createBuffer({
      label: 'shadow-frame',
      size: SHADOW_SLOTS * SHADOW_SLOT_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // A layer per cascade.
    this.shadowMap = device.createTexture({
      label: 'shadow-map',
      size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, MAX_SHADOW_CASCADES],
      format: SHADOW_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowMapView = this.shadowMap.createView({ dimension: '2d-array' });
    this.localShadowMap = device.createTexture({
      label: 'local-shadow-map',
      size: [LOCAL_SHADOW_MAP_SIZE, LOCAL_SHADOW_MAP_SIZE, MAX_LOCAL_SHADOW_LAYERS],
      format: SHADOW_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.localShadowMapView = this.localShadowMap.createView({ dimension: '2d-array' });
    this.localShadowBuffer = device.createBuffer({
      label: 'local-shadow-matrices',
      size: MAX_LOCAL_SHADOW_LAYERS * 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.shadowSampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    // Equirectangular: wraps around horizontally, not over the poles.
    this.skySampler = device.createSampler({
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
    this.textureSampler = device.createSampler({
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 8,
    });
    this.mipSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const white = device.createTexture({ size: [1, 1], format: TEXTURE_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this.whiteTextureView = white.createView();

    this.atlasTexture = device.createTexture({
      label: 'font-atlas',
      size: [ATLAS_SIZE, ATLAS_SIZE],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const atlasSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const atlasView = this.atlasTexture.createView();
    const makeView2D = (label: string): [GPUBuffer, GPUBindGroup] => {
      const buffer = device.createBuffer({ label, size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const group = device.createBindGroup({
        label,
        layout: layout2D,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: atlasView },
          { binding: 2, resource: atlasSampler },
        ],
      });
      return [buffer, group];
    };
    const [worldBuf, worldGroup] = makeView2D('2d-world');
    const [screenBuf, screenGroup] = makeView2D('2d-screen');
    this.view2DBuffers = [worldBuf, screenBuf];
    this.view2DGroups = [worldGroup, screenGroup];

    this.frameBindGroup = this.makeFrameBindGroup(null);
    this.shadowFrameBindGroups = Array.from({ length: SHADOW_SLOTS }, (_, i) =>
      device.createBindGroup({
        label: `shadow-frame ${i}`,
        layout: this.shadowFrameLayout,
        entries: [{ binding: 0, resource: { buffer: this.shadowFrameBuffer, offset: i * SHADOW_SLOT_SIZE, size: 64 } }],
      }));
  }

  // -------------------------------------------------------------------------

  private makeFrameBindGroup(sky: Texture | null): GPUBindGroup {
    this.frameSky = sky;
    return this.device.createBindGroup({
      label: 'frame',
      layout: this.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.lightBuffer } },
        { binding: 2, resource: this.shadowMapView },
        { binding: 3, resource: this.shadowSampler },
        { binding: 4, resource: sky ? this.ensureTexture(sky).createView() : this.whiteTextureView },
        { binding: 5, resource: this.skySampler },
        { binding: 6, resource: this.localShadowMapView },
        { binding: 7, resource: { buffer: this.localShadowBuffer } },
      ],
    });
  }

  private resizeIfNeeded(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height) return;
    this.width = this.canvas.width = w;
    this.height = this.canvas.height = h;
    this.graph.setOutputSize(w, h);
  }

  private ensureMesh(mesh: Mesh): void {
    if (mesh.gpu) return;
    const vertexBuffer = this.device.createBuffer({
      label: `${mesh.name}-vertices`,
      size: Math.max(16, mesh.vertices.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertexBuffer, 0, mesh.vertices);
    const indexBuffer = this.device.createBuffer({
      label: `${mesh.name}-indices`,
      size: Math.max(16, mesh.indices.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(indexBuffer, 0, mesh.indices);
    mesh.gpu = { vertexBuffer, indexBuffer };
  }

  /** Uploads `tex` as sRGB colors, or with `linear` as raw data (each copy filters its mips in its own space). */
  private ensureTexture(tex: Texture, linear = false): GPUTexture {
    const existing = linear ? tex.gpuLinear : tex.gpu;
    if (existing) return existing;
    const { width, height } = tex.source;
    const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
    const gpu = this.device.createTexture({
      label: linear ? `${tex.name} (linear)` : tex.name,
      size: [width, height],
      format: linear ? LINEAR_TEXTURE_FORMAT : TEXTURE_FORMAT,
      mipLevelCount,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture({ source: tex.source }, { texture: gpu }, [width, height]);
    this.generateMips(gpu, mipLevelCount, this.mipPipelines[linear ? 'linear' : 'srgb']);
    if (linear) tex.gpuLinear = gpu;
    else tex.gpu = gpu;
    return gpu;
  }

  private generateMips(texture: GPUTexture, levels: number, pipeline: GPURenderPipeline): void {
    if (levels <= 1) return;
    const encoder = this.device.createCommandEncoder({ label: 'mipmaps' });
    for (let level = 1; level < levels; level++) {
      const bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.mipSampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  private prepareMaterial(m: Material): GPUBindGroup {
    const textures = TEXTURE_SLOTS.map((slot) => m[slot]);
    if (!m.gpu || textures.some((t, i) => t !== m.gpu!.boundTextures[i])) {
      const uniformBuffer =
        m.gpu?.uniformBuffer ??
        this.device.createBuffer({ label: `${m.name}-material`, size: MATERIAL_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      // Missing textures are white: a factor of 1 for every slot (the normal map is skipped by a flag instead).
      const views = TEXTURE_SLOTS.map((slot, i) => {
        const t = textures[i];
        return t ? this.ensureTexture(t, LINEAR_TEXTURE_SLOTS.has(slot)).createView() : this.whiteTextureView;
      });
      const bindGroup = this.device.createBindGroup({
        label: m.name,
        layout: this.materialLayout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: views[0] },
          { binding: 2, resource: this.textureSampler },
          ...views.slice(1).map((resource, i) => ({ binding: 3 + i, resource })),
        ],
      });
      m.gpu = { uniformBuffer, bindGroup, boundTextures: textures };
    }
    const d = this.materialData;
    d.set(m.baseColor, 0);
    d[4] = m.emissive[0] * m.emissiveStrength;
    d[5] = m.emissive[1] * m.emissiveStrength;
    d[6] = m.emissive[2] * m.emissiveStrength;
    d[7] = m.metallic;
    d[8] = m.roughness;
    d[9] = m.unlit ? 1 : 0;
    d[10] = m.alphaCutoff;
    d[11] = m.normalTexture ? 1 : 0;
    d[12] = m.normalScale;
    d[13] = m.occlusionStrength;
    d[14] = m.blend === 'opaque' ? 0 : 1;
    d[15] = 0;
    this.device.queue.writeBuffer(m.gpu.uniformBuffer, 0, d);
    return m.gpu.bindGroup;
  }

  private ensureObjectCapacity(count: number): void {
    if (count <= this.objectCapacity && this.objectBindGroup) return;
    const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
    this.objectBuffer?.destroy();
    this.objectBuffer = this.device.createBuffer({ label: 'objects', size: capacity * OBJECT_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.objectBindGroup = this.device.createBindGroup({
      label: 'objects',
      layout: this.objectLayout,
      entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
    });
    this.objectCapacity = capacity;
  }

  private uploadOverlay(overlay: OverlayBuilder): void {
    const floats = overlay.depth.length + overlay.top.length;
    const bytes = floats * 4;
    if (bytes > this.overlayCapacity) {
      this.overlayBuffer?.destroy();
      this.overlayCapacity = Math.max(64 * 1024, 2 ** Math.ceil(Math.log2(bytes)));
      this.overlayBuffer = this.device.createBuffer({ label: 'overlay', size: this.overlayCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    const data = new Float32Array(floats);
    data.set(overlay.depth, 0);
    data.set(overlay.top, overlay.depth.length);
    this.device.queue.writeBuffer(this.overlayBuffer!, 0, data);
  }

  /**
   * Builds the 2D vertex streams (world-space components, then screen-space components and the immediate layer) and
   * uploads them with any new glyphs. Returns the vertex counts of the two parts.
   */
  private prepare2D(scene: Scene, camera: Camera, viewProj: Mat4, options: RenderOptions): [number, number] {
    const cssW = this.canvas.clientWidth || this.width, cssH = this.canvas.clientHeight || this.height;
    const world = this.world2D, screen = this.screen2D;
    world.reset();
    screen.reset();
    const showScreen = options.screen2D ?? true;
    const list = this.list2D;
    list.length = 0;
    const cam = camera.position;
    for (const r of scene.query(Renderer2D)) {
      if (r.space === 'screen') {
        if (showScreen) list.push({ r, key: 0 });
      } else {
        const w = r.transform.worldMatrix;
        list.push({ r, key: (w[12] - cam[0]) ** 2 + (w[13] - cam[1]) ** 2 + (w[14] - cam[2]) ** 2 });
      }
    }
    // By order, then back to front (world space; ties keep hierarchy order, as sort is stable).
    list.sort((a, b) => a.r.order - b.r.order || b.key - a.key);
    for (const { r } of list) {
      const batch = r.space === 'screen' ? screen : world;
      batch.matrix = r.targetMatrix(cssW, cssH, this.matrix2D);
      r.build(batch);
      batch.matrix = null;
    }
    this.stats.elements2D = list.length;
    list.length = 0;
    const immediate = options.draw2d;
    if (immediate) {
      immediate.width = cssW;
      immediate.height = cssH;
    }
    const worldFloats = world.length, screenFloats = screen.length + (immediate?.batch.length ?? 0);
    const total = worldFloats + screenFloats;
    if (total === 0) return [0, 0];

    const device = this.device;
    const atlas = fontAtlas;
    if (atlas.generation !== this.atlasGeneration) {
      // A new or cleared atlas: upload all of it.
      this.atlasGeneration = atlas.generation;
      atlas.dirtyMin = 0;
      atlas.dirtyMax = ATLAS_SIZE - 1;
    }
    if (atlas.dirtyMin <= atlas.dirtyMax) {
      const y0 = atlas.dirtyMin, rows = atlas.dirtyMax - atlas.dirtyMin + 1;
      device.queue.writeTexture({ texture: this.atlasTexture, origin: [0, y0] }, atlas.data, { offset: y0 * ATLAS_SIZE, bytesPerRow: ATLAS_SIZE }, [ATLAS_SIZE, rows]);
      atlas.markClean();
    }

    const bytes = total * 4;
    if (bytes > this.capacity2D) {
      this.buffer2D?.destroy();
      this.capacity2D = Math.max(64 * 1024, 2 ** Math.ceil(Math.log2(bytes)));
      this.buffer2D = device.createBuffer({ label: '2d', size: this.capacity2D, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    const buf = this.buffer2D!;
    if (worldFloats) device.queue.writeBuffer(buf, 0, world.data, 0, worldFloats);
    if (screen.length) device.queue.writeBuffer(buf, worldFloats * 4, screen.data, 0, screen.length);
    if (immediate?.batch.length) device.queue.writeBuffer(buf, (worldFloats + screen.length) * 4, immediate.batch.data, 0, immediate.batch.length);
    device.queue.writeBuffer(this.view2DBuffers[0], 0, viewProj);
    // CSS pixels (y down) → NDC.
    device.queue.writeBuffer(this.view2DBuffers[1], 0, new Float32Array([2 / cssW, 0, 0, 0, 0, -2 / cssH, 0, 0, 0, 0, 0, 0, -1, 1, 0.5, 1]));
    return [worldFloats / VERTEX2D_FLOATS, screenFloats / VERTEX2D_FLOATS];
  }

  /** Renders one frame. World matrices must be up to date (Scene.updateMatrices). */
  render(scene: Scene, camera: Camera, options: RenderOptions = {}): RenderStats {
    profiler.begin('prepare');
    this.resizeIfNeeded();
    camera.aspect = this.width / this.height;
    const device = this.device;
    const stats = this.stats;
    stats.drawCalls = stats.triangles = stats.instances = stats.culled = stats.lights = stats.shadowCasters = stats.elements2D = 0;
    const builds = this.meshPipelines.builds;

    // Gather live renderables and lights from the scene's component registry.
    const draws = this.draws;
    draws.length = 0;
    for (const r of scene.query(MeshRenderer)) if (r.mesh && r.material && r.mesh.indices.length > 0) draws.push(r);
    const lights = scene.query(Light);
    const lightObjects = lights.length > MAX_LIGHTS ? lights.slice(0, MAX_LIGHTS) : lights;

    const viewProj = camera.viewProjection();

    // Lights.
    let shadowIndex = -1;
    let shadowDir: Vec3 = [0, -1, 0];
    // The gradient sky's sun: the shadow-casting directional light, or else the first directional one.
    let sun: Light | null = null;
    let sunDir: Vec3 = [0, -1, 0];
    const ld = this.lightData;
    const localRequests: (LocalShadowLight | null)[] = [];
    lightObjects.forEach((light, i) => {
      const world = light.transform.worldMatrix;
      const pos = mat4.getTranslation(world);
      const dir = vec3.normalize(vec3.transformDir(world, [0, 0, -1]));
      const o = i * LIGHT_FLOATS;
      ld[o] = pos[0]; ld[o + 1] = pos[1]; ld[o + 2] = pos[2]; ld[o + 3] = LIGHT_TYPE_INDEX[light.type];
      ld[o + 4] = dir[0]; ld[o + 5] = dir[1]; ld[o + 6] = dir[2]; ld[o + 7] = light.range;
      ld[o + 8] = light.color[0]; ld[o + 9] = light.color[1]; ld[o + 10] = light.color[2]; ld[o + 11] = light.intensity;
      const outer = Math.min(89, Math.max(0.5, light.outerAngle));
      const inner = Math.min(outer - 0.01, Math.max(0, light.innerAngle));
      ld[o + 12] = Math.cos((inner * Math.PI) / 180); ld[o + 13] = Math.cos((outer * Math.PI) / 180); ld[o + 14] = -1; ld[o + 15] = 0;
      localRequests.push(light.castShadows && light.type !== 'directional' ? { type: light.type, position: pos, direction: dir, range: light.range, outerAngle: outer } : null);
      if (shadowIndex < 0 && light.type === 'directional' && light.castShadows) {
        shadowIndex = i;
        shadowDir = dir;
        sun = light;
        sunDir = dir;
      } else if (!sun && light.type === 'directional') {
        sun = light;
        sunDir = dir;
      }
    });
    // Point and spot shadows: layers for the lights that reach into the view, nearest first. A light's params.z is its
    // first layer (-1: none), params.w the texel size per unit of distance (common.wgsl).
    const localShadows = assignLocalShadows(localRequests, camera.position, frustumPlanes(viewProj, this.viewPlanes), MAX_LOCAL_SHADOW_LAYERS, LOCAL_SHADOW_MAP_SIZE);
    const localViews: Mat4[] = [];
    localShadows.forEach((ls, i) => {
      if (!ls) return;
      ld[i * LIGHT_FLOATS + 14] = ls.layer;
      ld[i * LIGHT_FLOATS + 15] = ls.texelPerDistance;
      ls.views.forEach((v, f) => {
        localViews[ls.layer + f] = v;
        this.localShadowData.set(v, (ls.layer + f) * 16);
      });
    });
    if (localViews.length > 0) device.queue.writeBuffer(this.localShadowBuffer, 0, this.localShadowData, 0, localViews.length * 16);
    if (lightObjects.length > 0) device.queue.writeBuffer(this.lightBuffer, 0, ld, 0, lightObjects.length * LIGHT_FLOATS);
    stats.lights = lightObjects.length;

    const cascades = shadowIndex >= 0 ? computeCascades(camera, shadowDir, scene.shadowDistance, scene.shadowCascades, SHADOW_MAP_SIZE) : [];
    cascades.forEach((c, i) => device.queue.writeBuffer(this.shadowFrameBuffer, i * SHADOW_SLOT_SIZE, c.viewProj));
    localViews.forEach((v, i) => device.queue.writeBuffer(this.shadowFrameBuffer, (MAX_SHADOW_CASCADES + i) * SHADOW_SLOT_SIZE, v));

    // Frame uniforms (layout: shaders/common.wgsl).
    const fv = new Float32Array(this.frameData);
    const fi = new Int32Array(this.frameData);
    const fu = new Uint32Array(this.frameData);
    fv.set(viewProj, 0);
    fv.set([camera.position[0], camera.position[1], camera.position[2], 1], 16);
    const amb = vec3.scale(scene.ambientColor, scene.ambientIntensity);
    fv.set([amb[0], amb[1], amb[2], scene.exposure], 20);
    fu[24] = lightObjects.length;
    fi[25] = shadowIndex;
    fv[26] = options.time ?? 0;
    fv[27] = 1 / SHADOW_MAP_SIZE;
    const sky = scene.sky;
    const skyMode = sky.effectiveMode;
    const skyTexture = skyMode === 'image' ? sky.texture : null;
    if (skyTexture !== this.frameSky) this.frameBindGroup = this.makeFrameBindGroup(skyTexture);
    fv.set(mat4.invert(viewProj) ?? mat4.create(), 28);
    fv.set([sky.top[0], sky.top[1], sky.top[2], sky.intensity], 44);
    fv.set([sky.horizon[0], sky.horizon[1], sky.horizon[2], 0], 48);
    fv.set([sky.ground[0], sky.ground[1], sky.ground[2], 0], 52);
    // Assigned in the forEach above, which TypeScript's narrowing doesn't follow.
    const sunLight = sun as Light | null;
    const sunRadius = (Math.max(0, sky.sunSize) * Math.PI) / 360;
    fv.set([-sunDir[0], -sunDir[1], -sunDir[2], sunLight && sky.sunSize > 0 ? Math.cos(sunRadius) : 2], 56);
    const sunColor = sunLight ? vec3.scale(sunLight.color, sunLight.intensity) : [0, 0, 0];
    fv.set([sunColor[0], sunColor[1], sunColor[2], sunLight ? sky.sunGlow : 0], 60);
    const mips = skyTexture?.gpu?.mipLevelCount ?? 1;
    fv.set([SKY_MODE_INDEX[skyMode], sky.lighting, (sky.rotation * Math.PI) / 180, mips], 64);
    // Cascades: where each ends, its texel size and a depth bias of about two texels, both turned into its depth range.
    const forward = vec3.normalize(vec3.sub(camera.target, camera.position));
    fv.set([forward[0], forward[1], forward[2], cascades.length], 68);
    for (let i = 0; i < MAX_SHADOW_CASCADES; i++) {
      const c = cascades[i];
      fv[72 + i] = c ? c.far : 0;
      fv[76 + i] = c ? c.texel : 0;
      fv[80 + i] = c ? (c.texel * 2) / c.depthRange : 0;
      if (c) fv.set(c.viewProj, 84 + i * 16);
    }
    device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);

    // Cull against the view and the shadow map, batch what's left into instanced draws, and upload every instance's
    // matrices into one storage buffer.
    profiler.begin('cull + batch');
    const list = this.drawList;
    // Shadow views: the cascades, then the local layers (list.shadows follows that order).
    list.build(draws, viewProj, camera.position, [...cascades.map((c) => c.viewProj), ...localViews], this.frustumCulling);
    profiler.end();
    stats.culled = list.culled;
    this.ensureObjectCapacity(list.objectCount);
    if (list.objectCount > 0) device.queue.writeBuffer(this.objectBuffer!, 0, list.objects, 0, list.objectCount * OBJECT_FLOATS);
    for (const b of list.main) this.ensureMesh(b.mesh);
    for (const b of list.transparent) this.ensureMesh(b.mesh);
    for (const casters of list.shadows) for (const b of casters) this.ensureMesh(b.mesh);

    const materialGroups = new Map<Material, GPUBindGroup>();
    for (const m of list.materials) materialGroups.set(m, this.prepareMaterial(m));

    const overlay = options.overlay && !options.overlay.isEmpty ? options.overlay : null;
    if (overlay) this.uploadOverlay(overlay);
    profiler.end();
    profiler.begin('2D');
    const [world2DCount, screen2DCount] = this.prepare2D(scene, camera, viewProj, options);
    profiler.end();

    // The frame: a shadow pass per cascade into its layer of the persistent shadow map (when a directional light casts
    // shadows), the main pass (meshes and sky as linear radiance into a multisampled HDR target), the tonemap pass (into
    // the multisampled display target), then the display-space overlay pass (grid, 2D, editor helpers), resolved into
    // the canvas.
    const g = this.graph;
    const shadowMap = g.importTexture('shadow map', this.shadowMap);
    const output = g.importTexture('canvas', this.context.getCurrentTexture());
    cascades.forEach((_, i) => {
      g.addRenderPass(`shadow ${i}`, (pass) => {
        pass.depthAttachment(shadowMap, { depthClearValue: 1, depthLoadOp: 'clear', layer: i });
        return (encoder, res) => this.drawShadowCasters(encoder, i, list.shadows[i], materialGroups, res.target!);
      });
    });
    const localShadowMap = localViews.length > 0 ? g.importTexture('local shadow map', this.localShadowMap) : null;
    localViews.forEach((_, i) => {
      const slot = cascades.length + i;
      g.addRenderPass(`light shadow ${i}`, (pass) => {
        pass.depthAttachment(localShadowMap!, { depthClearValue: 1, depthLoadOp: 'clear', layer: i });
        return (encoder, res) => this.drawShadowCasters(encoder, MAX_SHADOW_CASCADES + i, list.shadows[slot], materialGroups, res.target!);
      });
    });
    const hdr = g.createTexture('hdr color', { format: HDR_FORMAT, sampleCount: this.sampleCount });
    const depth = g.createTexture('main depth', { format: DEPTH_FORMAT, sampleCount: this.sampleCount });
    const display = g.createTexture('display color', { format: this.format, sampleCount: this.sampleCount });
    g.addRenderPass('main', (pass) => {
      pass.read(shadowMap); // through the frame bind group
      if (localShadowMap) pass.read(localShadowMap);
      // Alpha 0 marks pixels nothing covers (meshes and the sky write 1): the tonemap pass shows the background there.
      pass.colorAttachment(hdr, { clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear' });
      pass.depthAttachment(depth, { depthClearValue: 0, depthLoadOp: 'clear' });
      return (encoder, res) => this.drawScene(encoder, list, materialGroups, skyMode, res.target!);
    });
    // With a sky, the background only shows where the sky pass doesn't draw (nowhere).
    const bg = skyMode === 'color' ? scene.background : [0, 0, 0];
    const td = this.tonemapData;
    td[0] = bg[0]; td[1] = bg[1]; td[2] = bg[2]; td[3] = scene.exposure;
    device.queue.writeBuffer(this.tonemapBuffer, 0, td);
    g.addRenderPass('tonemap', (pass) => {
      pass.read(hdr);
      pass.colorAttachment(display, { clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear' });
      return (encoder, res) => this.drawTonemap(encoder, res.texture(hdr));
    });
    g.addRenderPass('overlay', (pass) => {
      pass.colorAttachment(display, { loadOp: 'load', resolveTarget: output });
      pass.depthAttachment(depth, { depthLoadOp: 'load' });
      return (encoder) => this.drawDisplay(encoder, { grid: !!options.grid, overlay, world2DCount, screen2DCount });
    });
    g.timer = profiler.enabled ? this.gpuTimer : null;
    profiler.begin('passes');
    g.execute();
    profiler.end();
    stats.pipelineBuilds = this.meshPipelines.builds - builds;
    return stats;
  }

  /** The attachments the mesh passes draw into, as the frame graph declares them: what mesh variants are made for. */
  meshTargets(): Record<MeshPass, RenderTarget> {
    return {
      main: { colorFormats: [HDR_FORMAT], depthFormat: DEPTH_FORMAT, sampleCount: this.sampleCount },
      shadow: { colorFormats: [], depthFormat: SHADOW_FORMAT, sampleCount: 1 },
    };
  }

  /** Every mesh pipeline variant this renderer can need. */
  meshVariantKeys(): MeshVariantKey[] {
    return allMeshVariantKeys(this.meshTargets());
  }

  /**
   * Builds the mesh pipelines `scene` draws with in the background, so they're ready when it's rendered instead of
   * built in the middle of a frame. Call after a scene or an asset loads.
   */
  prewarm(scene: Scene): Promise<void> {
    const targets = this.meshTargets();
    const keys: MeshVariantKey[] = [];
    for (const r of scene.query(MeshRenderer)) {
      if (!r.material) continue;
      keys.push(meshVariantKey('main', r.material, r.mesh, targets.main));
      if (r.castShadows) keys.push(meshVariantKey('shadow', r.material, r.mesh, targets.shadow));
    }
    return this.meshPipelines.prewarm(keys);
  }

  /**
   * A shadow pass (one view: a cascade or a point/spot light layer): depth only, on its own group 0 (the frame group
   * holds the shadow map it's drawing into), the view's matrix at `slot`. The alpha-tested variant reads the material
   * from group 2.
   */
  private drawShadowCasters(
    pass: GPURenderPassEncoder,
    slot: number,
    batches: MeshBatch[],
    materialGroups: Map<Material, GPUBindGroup>,
    target: RenderTarget,
  ): void {
    const stats = this.stats;
    pass.setBindGroup(0, this.shadowFrameBindGroups[slot]);
    if (batches.length > 0) pass.setBindGroup(1, this.objectBindGroup!);
    let currentPipeline: GPURenderPipeline | null = null;
    for (const b of batches) {
      const key = meshVariantKey('shadow', b.material, b.mesh, target);
      const pipeline = this.meshPipelines.get(key);
      if (pipeline !== currentPipeline) {
        pass.setPipeline(pipeline);
        currentPipeline = pipeline;
      }
      const gpu = b.mesh.gpu!;
      if (key.alphaTest) pass.setBindGroup(2, materialGroups.get(b.material)!);
      pass.setVertexBuffer(0, gpu.vertexBuffer);
      pass.setIndexBuffer(gpu.indexBuffer, 'uint32');
      // The first instance is where the batch starts in the object buffer (the shader's instance index includes it).
      pass.drawIndexed(b.mesh.indices.length, b.count, 0, 0, b.first);
      stats.shadowCasters += b.count;
    }
  }

  /** The main pass, as linear radiance: opaque meshes, the sky behind them, then blended meshes back to front. */
  private drawScene(pass: GPURenderPassEncoder, list: DrawList, materialGroups: Map<Material, GPUBindGroup>, skyMode: SkyMode, target: RenderTarget): void {
    const stats = this.stats;
    pass.setBindGroup(0, this.frameBindGroup);
    if (list.mainInstances > 0) pass.setBindGroup(2, this.objectBindGroup!);
    let currentPipeline: GPURenderPipeline | null = null;
    const draw = (b: MeshBatch) => {
      const pipeline = this.meshPipelines.get(meshVariantKey('main', b.material, b.mesh, target));
      if (pipeline !== currentPipeline) {
        pass.setPipeline(pipeline);
        currentPipeline = pipeline;
      }
      const gpu = b.mesh.gpu!;
      pass.setBindGroup(1, materialGroups.get(b.material)!);
      pass.setVertexBuffer(0, gpu.vertexBuffer);
      pass.setIndexBuffer(gpu.indexBuffer, 'uint32');
      pass.drawIndexed(b.mesh.indices.length, b.count, 0, 0, b.first);
      stats.drawCalls++;
      stats.instances += b.count;
      stats.triangles += b.mesh.triangleCount * b.count;
    };
    for (const b of list.main) draw(b);

    if (skyMode !== 'color') {
      pass.setPipeline(this.skyPipeline);
      pass.draw(3);
      stats.drawCalls++;
      currentPipeline = null;
    }
    for (const b of list.transparent) draw(b);
  }

  /** The tonemap pass: HDR radiance to display colors, per sample (see tonemap.wgsl). */
  private drawTonemap(pass: GPURenderPassEncoder, hdr: GPUTexture): void {
    if (hdr !== this.tonemapSource) {
      this.tonemapSource = hdr;
      this.tonemapGroup = this.device.createBindGroup({
        label: 'tonemap',
        layout: this.tonemapLayout,
        entries: [
          { binding: 0, resource: hdr.createView() },
          { binding: 1, resource: { buffer: this.tonemapBuffer } },
        ],
      });
    }
    pass.setPipeline(this.tonemapPipeline);
    pass.setBindGroup(0, this.tonemapGroup!);
    pass.draw(3);
  }

  /** The overlay pass, display space: grid, world 2D, depth-tested overlay, screen 2D (HUD), then the overlay on top. */
  private drawDisplay(pass: GPURenderPassEncoder, f: DisplayPassInput): void {
    const stats = this.stats;
    const { overlay, world2DCount, screen2DCount } = f;
    pass.setBindGroup(0, this.frameBindGroup);
    if (f.grid) {
      pass.setPipeline(this.gridPipeline);
      pass.draw(6);
    }

    if (world2DCount > 0) {
      pass.setPipeline(this.world2DPipeline);
      pass.setBindGroup(0, this.view2DGroups[0]);
      pass.setVertexBuffer(0, this.buffer2D!);
      pass.draw(world2DCount);
      stats.drawCalls++;
    }

    // Editor helpers hidden by the scene, then the HUD, then the helpers that stay on top (gizmo, selection).
    const depthCount = overlay ? overlay.depth.length / OVERLAY_STRIDE_FLOATS : 0;
    const topCount = overlay ? overlay.top.length / OVERLAY_STRIDE_FLOATS : 0;
    if (depthCount > 0) {
      pass.setPipeline(this.overlayDepthPipeline);
      pass.setBindGroup(0, this.frameBindGroup);
      pass.setVertexBuffer(0, this.overlayBuffer!);
      pass.draw(depthCount);
    }
    if (screen2DCount > 0) {
      pass.setPipeline(this.screen2DPipeline);
      pass.setBindGroup(0, this.view2DGroups[1]);
      pass.setVertexBuffer(0, this.buffer2D!);
      pass.draw(screen2DCount, 1, world2DCount);
      stats.drawCalls++;
    }
    if (topCount > 0) {
      pass.setPipeline(this.overlayTopPipeline);
      pass.setBindGroup(0, this.frameBindGroup);
      pass.setVertexBuffer(0, this.overlayBuffer!);
      pass.draw(topCount, 1, depthCount);
    }
  }
}

interface DisplayPassInput {
  grid: boolean;
  overlay: OverlayBuilder | null;
  world2DCount: number;
  screen2DCount: number;
}

