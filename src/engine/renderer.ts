import commonWGSL from './shaders/common.wgsl?raw';
import meshWGSL from './shaders/mesh.wgsl?raw';
import shadowWGSL from './shaders/shadow.wgsl?raw';
import gridWGSL from './shaders/grid.wgsl?raw';
import overlayWGSL from './shaders/overlay.wgsl?raw';
import mipmapWGSL from './shaders/mipmap.wgsl?raw';
import shape2dWGSL from './shaders/shape2d.wgsl?raw';
import { mat4, vec3, type Mat4, type Vec3 } from './math';
import { VERTEX_STRIDE_BYTES, type Mesh } from './mesh';
import type { Material, Texture } from './material';
import { Light, LIGHT_TYPE_INDEX } from './light';
import { MeshRenderer } from './meshRenderer';
import type { Scene } from './scene';
import type { Camera } from './camera';
import { OVERLAY_STRIDE_FLOATS, type OverlayBuilder } from './overlay';
import { Batch2D, VERTEX2D_FLOATS, type Draw2D } from './draw2d';
import { ATLAS_SIZE, fontAtlas } from './font';
import { Renderer2D } from './shapes2d';

export const MAX_LIGHTS = 128;
const SHADOW_MAP_SIZE = 2048;
/** Per-object uniform slot; must be a multiple of minUniformBufferOffsetAlignment (256). */
const OBJECT_STRIDE = 256;
const OBJECT_UNIFORM_SIZE = 128;
const FRAME_UNIFORM_SIZE = 176;
const MATERIAL_UNIFORM_SIZE = 48;
const LIGHT_FLOATS = 16;
/** Main pass uses reversed-Z: clear to 0, 'greater' passes nearer fragments. */
const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
const SHADOW_FORMAT: GPUTextureFormat = 'depth32float';
const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';

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
  drawCalls: number;
  triangles: number;
  lights: number;
  shadowCasters: number;
  /** Shape2D/Text2D components drawn. */
  elements2D: number;
}

const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/**
 * Forward renderer: shadow pass (one directional light) followed by a 4x MSAA
 * main pass containing lit meshes, the editor grid and overlay helpers.
 */
export class Renderer {
  readonly device: GPUDevice;
  readonly canvas: HTMLCanvasElement;
  readonly format: GPUTextureFormat;
  readonly sampleCount = 4;
  width = 0;
  height = 0;
  readonly stats: RenderStats = { drawCalls: 0, triangles: 0, lights: 0, shadowCasters: 0, elements2D: 0 };

  private readonly context: GPUCanvasContext;
  private msaaTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;

  private readonly frameLayout: GPUBindGroupLayout;
  private readonly materialLayout: GPUBindGroupLayout;
  private readonly objectLayout: GPUBindGroupLayout;
  private readonly shadowFrameLayout: GPUBindGroupLayout;

  private readonly meshPipelineCulled: GPURenderPipeline;
  private readonly meshPipelineDoubleSided: GPURenderPipeline;
  private readonly shadowPipeline: GPURenderPipeline;
  private readonly gridPipeline: GPURenderPipeline;
  private readonly overlayDepthPipeline: GPURenderPipeline;
  private readonly overlayTopPipeline: GPURenderPipeline;
  private readonly mipPipeline: GPURenderPipeline;
  private readonly world2DPipeline: GPURenderPipeline;
  private readonly screen2DPipeline: GPURenderPipeline;

  private readonly frameBuffer: GPUBuffer;
  private readonly lightBuffer: GPUBuffer;
  private readonly shadowFrameBuffer: GPUBuffer;
  private readonly shadowMap: GPUTexture;
  private readonly shadowMapView: GPUTextureView;
  private readonly frameBindGroup: GPUBindGroup;
  private readonly shadowFrameBindGroup: GPUBindGroup;
  private readonly textureSampler: GPUSampler;
  private readonly mipSampler: GPUSampler;
  private readonly whiteTextureView: GPUTextureView;

  private objectBuffer: GPUBuffer | null = null;
  private objectBindGroup: GPUBindGroup | null = null;
  private objectCapacity = 0;
  private objectStaging = new Float32Array(0);

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
    const device = await adapter.requestDevice();
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

    const VS = GPUShaderStage.VERTEX, FS = GPUShaderStage.FRAGMENT;

    // --- Bind group layouts -------------------------------------------------
    this.frameLayout = device.createBindGroupLayout({
      label: 'frame',
      entries: [
        { binding: 0, visibility: VS | FS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FS, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: FS, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: FS, sampler: { type: 'comparison' } },
      ],
    });
    this.materialLayout = device.createBindGroupLayout({
      label: 'material',
      entries: [
        { binding: 0, visibility: FS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FS, texture: { sampleType: 'float' } },
        { binding: 2, visibility: FS, sampler: { type: 'filtering' } },
      ],
    });
    this.objectLayout = device.createBindGroupLayout({
      label: 'object',
      entries: [{ binding: 0, visibility: VS, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: OBJECT_UNIFORM_SIZE } }],
    });
    this.shadowFrameLayout = device.createBindGroupLayout({
      label: 'shadow-frame',
      entries: [{ binding: 0, visibility: VS, buffer: { type: 'uniform' } }],
    });

    // --- Pipelines ----------------------------------------------------------
    const meshVertexLayout: GPUVertexBufferLayout = {
      arrayStride: VERTEX_STRIDE_BYTES,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' },
      ],
    };
    const multisample: GPUMultisampleState = { count: this.sampleCount };
    const meshModule = device.createShaderModule({ label: 'mesh', code: commonWGSL + meshWGSL });
    const meshLayout = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.materialLayout, this.objectLayout] });
    const makeMeshPipeline = (cullMode: GPUCullMode) =>
      device.createRenderPipeline({
        label: `mesh-${cullMode}`,
        layout: meshLayout,
        vertex: { module: meshModule, entryPoint: 'vs_main', buffers: [meshVertexLayout] },
        fragment: { module: meshModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
        multisample,
      });
    this.meshPipelineCulled = makeMeshPipeline('back');
    this.meshPipelineDoubleSided = makeMeshPipeline('none');

    const shadowModule = device.createShaderModule({ label: 'shadow', code: shadowWGSL });
    this.shadowPipeline = device.createRenderPipeline({
      label: 'shadow',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.shadowFrameLayout, this.objectLayout] }),
      vertex: {
        module: shadowModule,
        entryPoint: 'vs_main',
        buffers: [{ arrayStride: VERTEX_STRIDE_BYTES, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.5 },
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

    const mipModule = device.createShaderModule({ label: 'mipmap', code: mipmapWGSL });
    this.mipPipeline = device.createRenderPipeline({
      label: 'mipmap',
      layout: 'auto',
      vertex: { module: mipModule, entryPoint: 'vs_main' },
      fragment: { module: mipModule, entryPoint: 'fs_main', targets: [{ format: TEXTURE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

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
    this.shadowFrameBuffer = device.createBuffer({ label: 'shadow-frame', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.shadowMap = device.createTexture({
      label: 'shadow-map',
      size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
      format: SHADOW_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowMapView = this.shadowMap.createView();
    const shadowSampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
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

    this.frameBindGroup = device.createBindGroup({
      label: 'frame',
      layout: this.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.lightBuffer } },
        { binding: 2, resource: this.shadowMapView },
        { binding: 3, resource: shadowSampler },
      ],
    });
    this.shadowFrameBindGroup = device.createBindGroup({
      label: 'shadow-frame',
      layout: this.shadowFrameLayout,
      entries: [{ binding: 0, resource: { buffer: this.shadowFrameBuffer } }],
    });
  }

  // -------------------------------------------------------------------------

  private resizeIfNeeded(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height && this.msaaTexture) return;
    this.width = this.canvas.width = w;
    this.height = this.canvas.height = h;
    this.msaaTexture?.destroy();
    this.depthTexture?.destroy();
    this.msaaTexture = this.device.createTexture({
      size: [w, h],
      format: this.format,
      sampleCount: this.sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: DEPTH_FORMAT,
      sampleCount: this.sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
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

  private ensureTexture(tex: Texture): GPUTexture {
    if (tex.gpu) return tex.gpu;
    const { width, height } = tex.source;
    const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
    const gpu = this.device.createTexture({
      label: tex.name,
      size: [width, height],
      format: TEXTURE_FORMAT,
      mipLevelCount,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture({ source: tex.source }, { texture: gpu }, [width, height]);
    this.generateMips(gpu, mipLevelCount);
    tex.gpu = gpu;
    return gpu;
  }

  private generateMips(texture: GPUTexture, levels: number): void {
    if (levels <= 1) return;
    const encoder = this.device.createCommandEncoder({ label: 'mipmaps' });
    for (let level = 1; level < levels; level++) {
      const bindGroup = this.device.createBindGroup({
        layout: this.mipPipeline.getBindGroupLayout(0),
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
      pass.setPipeline(this.mipPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  private prepareMaterial(m: Material): GPUBindGroup {
    const tex = m.baseColorTexture;
    if (!m.gpu || m.gpu.boundTexture !== tex) {
      const uniformBuffer =
        m.gpu?.uniformBuffer ??
        this.device.createBuffer({ label: `${m.name}-material`, size: MATERIAL_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const view = tex ? this.ensureTexture(tex).createView() : this.whiteTextureView;
      const bindGroup = this.device.createBindGroup({
        label: m.name,
        layout: this.materialLayout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: view },
          { binding: 2, resource: this.textureSampler },
        ],
      });
      m.gpu = { uniformBuffer, bindGroup, boundTexture: tex };
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
    d[11] = 0;
    this.device.queue.writeBuffer(m.gpu.uniformBuffer, 0, d);
    return m.gpu.bindGroup;
  }

  private ensureObjectCapacity(count: number): void {
    if (count <= this.objectCapacity && this.objectBindGroup) return;
    const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
    this.objectBuffer?.destroy();
    this.objectBuffer = this.device.createBuffer({ label: 'objects', size: capacity * OBJECT_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.objectBindGroup = this.device.createBindGroup({
      label: 'objects',
      layout: this.objectLayout,
      entries: [{ binding: 0, resource: { buffer: this.objectBuffer, size: OBJECT_UNIFORM_SIZE } }],
    });
    this.objectStaging = new Float32Array((capacity * OBJECT_STRIDE) / 4);
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

  private computeShadowMatrix(dir: Vec3, focus: Vec3, extent: number): Mat4 {
    const up: Vec3 = Math.abs(dir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    // Snap the focus point to shadow-map texels to avoid shimmering when the camera moves.
    const texel = (extent * 2) / SHADOW_MAP_SIZE;
    const lightView0 = mat4.lookAt([0, 0, 0], dir, up);
    const ls = vec3.transformPoint(lightView0, focus);
    ls[0] = Math.round(ls[0] / texel) * texel;
    ls[1] = Math.round(ls[1] / texel) * texel;
    const inv = mat4.invert(lightView0) ?? mat4.create();
    const snapped = vec3.transformPoint(inv, ls);
    const eye = vec3.addScaled(snapped, dir, -extent * 3);
    const view = mat4.lookAt(eye, snapped, up);
    const proj = mat4.ortho(-extent, extent, -extent, extent, 0.1, extent * 6);
    return mat4.multiply(proj, view);
  }

  /** Renders one frame. World matrices must be up to date (Scene.updateMatrices). */
  render(scene: Scene, camera: Camera, options: RenderOptions = {}): RenderStats {
    this.resizeIfNeeded();
    camera.aspect = this.width / this.height;
    const device = this.device;
    const stats = this.stats;
    stats.drawCalls = stats.triangles = stats.lights = stats.shadowCasters = stats.elements2D = 0;

    // Gather live renderables and lights from the scene's component registry.
    const draws = this.draws;
    draws.length = 0;
    for (const r of scene.query(MeshRenderer)) if (r.mesh && r.material && r.mesh.indices.length > 0) draws.push(r);
    const lights = scene.query(Light);
    const lightObjects = lights.length > MAX_LIGHTS ? lights.slice(0, MAX_LIGHTS) : lights;

    // Lights.
    let shadowIndex = -1;
    let shadowDir: Vec3 = [0, -1, 0];
    const ld = this.lightData;
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
      ld[o + 12] = Math.cos((inner * Math.PI) / 180); ld[o + 13] = Math.cos((outer * Math.PI) / 180); ld[o + 14] = 0; ld[o + 15] = 0;
      if (shadowIndex < 0 && light.type === 'directional' && light.castShadows) {
        shadowIndex = i;
        shadowDir = dir;
      }
    });
    if (lightObjects.length > 0) device.queue.writeBuffer(this.lightBuffer, 0, ld, 0, lightObjects.length * LIGHT_FLOATS);
    stats.lights = lightObjects.length;

    const lightViewProj = shadowIndex >= 0 ? this.computeShadowMatrix(shadowDir, camera.target, scene.shadowExtent) : mat4.create();
    if (shadowIndex >= 0) device.queue.writeBuffer(this.shadowFrameBuffer, 0, lightViewProj);

    // Frame uniforms (layout: shaders/common.wgsl).
    const fv = new Float32Array(this.frameData);
    const fi = new Int32Array(this.frameData);
    const fu = new Uint32Array(this.frameData);
    const viewProj = camera.viewProjection();
    fv.set(viewProj, 0);
    fv.set(lightViewProj, 16);
    fv.set([camera.position[0], camera.position[1], camera.position[2], 1], 32);
    const amb = vec3.scale(scene.ambientColor, scene.ambientIntensity);
    fv.set([amb[0], amb[1], amb[2], scene.exposure], 36);
    fu[40] = lightObjects.length;
    fi[41] = shadowIndex;
    fv[42] = options.time ?? 0;
    fv[43] = 1 / SHADOW_MAP_SIZE;
    device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);

    // Per-object uniforms in one dynamic-offset buffer.
    this.ensureObjectCapacity(draws.length);
    const staging = this.objectStaging;
    draws.forEach((o, i) => {
      staging.set(o.transform.worldMatrix, (i * OBJECT_STRIDE) / 4);
      staging.set(o.transform.normalMatrix, (i * OBJECT_STRIDE) / 4 + 16);
      this.ensureMesh(o.mesh!);
    });
    if (draws.length > 0) device.queue.writeBuffer(this.objectBuffer!, 0, staging, 0, (draws.length * OBJECT_STRIDE) / 4);

    const materialGroups = new Map<Material, GPUBindGroup>();
    for (const o of draws) if (!materialGroups.has(o.material!)) materialGroups.set(o.material!, this.prepareMaterial(o.material!));

    const overlay = options.overlay && !options.overlay.isEmpty ? options.overlay : null;
    if (overlay) this.uploadOverlay(overlay);
    const [world2DCount, screen2DCount] = this.prepare2D(scene, camera, viewProj, options);

    const encoder = device.createCommandEncoder({ label: 'frame' });

    // Shadow pass.
    if (shadowIndex >= 0) {
      const pass = encoder.beginRenderPass({
        label: 'shadow',
        colorAttachments: [],
        depthStencilAttachment: { view: this.shadowMapView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      pass.setPipeline(this.shadowPipeline);
      pass.setBindGroup(0, this.shadowFrameBindGroup);
      draws.forEach((o, i) => {
        if (!o.castShadows) return;
        const gpu = o.mesh!.gpu!;
        pass.setBindGroup(1, this.objectBindGroup!, [i * OBJECT_STRIDE]);
        pass.setVertexBuffer(0, gpu.vertexBuffer);
        pass.setIndexBuffer(gpu.indexBuffer, 'uint32');
        pass.drawIndexed(o.mesh!.indices.length);
        stats.shadowCasters++;
      });
      pass.end();
    }

    // Main pass.
    const bg = scene.background;
    const pass = encoder.beginRenderPass({
      label: 'main',
      colorAttachments: [
        {
          view: this.msaaTexture!.createView(),
          resolveTarget: this.context.getCurrentTexture().createView(),
          clearValue: { r: bg[0], g: bg[1], b: bg[2], a: 1 },
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
      depthStencilAttachment: { view: this.depthTexture!.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setBindGroup(0, this.frameBindGroup);
    let currentPipeline: GPURenderPipeline | null = null;
    draws.forEach((o, i) => {
      const mat = o.material!;
      const pipeline = mat.doubleSided ? this.meshPipelineDoubleSided : this.meshPipelineCulled;
      if (pipeline !== currentPipeline) {
        pass.setPipeline(pipeline);
        currentPipeline = pipeline;
      }
      const gpu = o.mesh!.gpu!;
      pass.setBindGroup(1, materialGroups.get(mat)!);
      pass.setBindGroup(2, this.objectBindGroup!, [i * OBJECT_STRIDE]);
      pass.setVertexBuffer(0, gpu.vertexBuffer);
      pass.setIndexBuffer(gpu.indexBuffer, 'uint32');
      pass.drawIndexed(o.mesh!.indices.length);
      stats.drawCalls++;
      stats.triangles += o.mesh!.triangleCount;
    });

    if (options.grid) {
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
    pass.end();

    device.queue.submit([encoder.finish()]);
    return stats;
  }
}
