// A frame graph (render graph). Each frame the renderer declares its passes and the textures each one reads and
// writes; the graph orders the passes by those dependencies, culls the ones whose results nothing uses, gives every
// transient texture a pooled GPU texture for the span of passes that use it (textures whose spans don't overlap
// share one), picks store ops, and records everything into one command encoder.
//
// Dependencies: a pass that reads a texture runs after every pass that writes it, wherever it was declared; passes
// writing the same texture run in declaration order; otherwise declaration order is kept. An attachment that is
// loaded (loadOp 'load') counts as read and written.
//
// No imports from the renderer and no DOM, so the scheduling runs (and is unit-tested) against a fake device.

/** GPUTextureUsage values, spelled out so the graph doesn't need WebGPU's globals (tests run without them). */
const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const STORAGE_BINDING = 0x08;

/** Frames a pooled texture may go unused before it's destroyed. */
const POOL_IDLE_FRAMES = 3;

/** A texture the graph allocates for the frame. Usage flags come from how passes use it. */
export interface TransientTextureDesc {
  format: GPUTextureFormat;
  /** Size in texels. Without it, the output size times `scale`. */
  size?: [number, number];
  /** Fraction of the output size (default 1), when `size` isn't given. */
  scale?: number;
  sampleCount?: number;
  mipLevelCount?: number;
}

/** A texture of one frame's graph. Only valid in the frame it was made in. */
export class TextureHandle {
  /** @internal */
  constructor(
    readonly name: string,
    readonly _graph: FrameGraph,
    readonly _frame: number,
    readonly _index: number,
  ) {}
}

export interface ColorAttachment {
  /** Default 'clear'; 'load' also counts as reading the texture. */
  loadOp?: GPULoadOp;
  clearValue?: GPUColor;
  /** A single-sample texture the (multisampled) attachment resolves into. */
  resolveTarget?: TextureHandle;
}

/** Depth only: the stencil aspect isn't handled yet. */
export interface DepthAttachment {
  /** Default 'clear'; 'load' also counts as reading the texture. */
  depthLoadOp?: GPULoadOp;
  depthClearValue?: number;
}

/** Formats and sample count of a render pass's attachments, for choosing pipelines that match them. */
export interface RenderTarget {
  colorFormats: GPUTextureFormat[];
  depthFormat: GPUTextureFormat | null;
  sampleCount: number;
}

/** The textures of the frame, for a pass's execute function. */
export interface FrameResources {
  texture(handle: TextureHandle): GPUTexture;
  /** A default view of the texture. */
  view(handle: TextureHandle): GPUTextureView;
  /** The pass's attachments (render passes; null in compute passes). */
  readonly target: RenderTarget | null;
}

interface PassBuilderBase {
  /** Samples the texture (a texture binding). */
  read(handle: TextureHandle): void;
  /** Never culled, even when nothing reads what it writes (it has effects outside the graph). */
  sideEffect(): void;
}

export interface RenderPassBuilder extends PassBuilderBase {
  colorAttachment(handle: TextureHandle, options?: ColorAttachment): void;
  depthAttachment(handle: TextureHandle, options?: DepthAttachment): void;
}

export interface ComputePassBuilder extends PassBuilderBase {
  /** Reads the texture as a storage texture. */
  readStorage(handle: TextureHandle): void;
  /** Writes the texture as a storage texture. */
  writeStorage(handle: TextureHandle): void;
}

export type RenderPassExecute = (pass: GPURenderPassEncoder, resources: FrameResources) => void;
export type ComputePassExecute = (pass: GPUComputePassEncoder, resources: FrameResources) => void;

/** What compile() decided: the passes in execution order and the ones culled. */
export interface CompiledFrame {
  passes: string[];
  culled: string[];
}

interface Resource {
  name: string;
  imported: GPUTexture | null;
  desc: (Required<Omit<TransientTextureDesc, 'size'>> & Pick<TransientTextureDesc, 'size'>) | null;
  usage: number;
  writers: Pass[];
  readers: Pass[];
  /** Execution positions of the first and last alive pass using it (-1: unused). */
  first: number;
  last: number;
  texture: GPUTexture | null;
  entry: PoolEntry | null;
}

interface Pass {
  name: string;
  index: number;
  kind: 'render' | 'compute';
  sideEffect: boolean;
  reads: Set<Resource>;
  writes: Set<Resource>;
  colors: { res: Resource; loadOp: GPULoadOp; clearValue?: GPUColor; resolve: Resource | null }[];
  depth: { res: Resource; depthLoadOp: GPULoadOp; depthClearValue?: number } | null;
  execute: RenderPassExecute | ComputePassExecute | null;
}

interface PoolEntry {
  key: string;
  texture: GPUTexture;
  lastUsed: number;
  inUse: boolean;
}

export class FrameGraph {
  private outputSize: [number, number] = [1, 1];
  private frame = 0;
  private resources: Resource[] = [];
  private passes: Pass[] = [];
  private readonly pool: PoolEntry[] = [];

  constructor(private readonly device: GPUDevice) {}

  /** The size transient textures scale from (the canvas). Changing it frees every pooled texture. */
  setOutputSize(width: number, height: number): void {
    if (width === this.outputSize[0] && height === this.outputSize[1]) return;
    this.outputSize = [width, height];
    this.releaseAll();
  }

  /** Pooled GPU textures (for tests and stats). */
  get pooledTextures(): number {
    return this.pool.length;
  }

  /** A texture this frame's passes share, allocated from the pool. */
  createTexture(name: string, desc: TransientTextureDesc): TextureHandle {
    return this.addResource({
      name,
      imported: null,
      desc: { format: desc.format, scale: desc.scale ?? 1, sampleCount: desc.sampleCount ?? 1, mipLevelCount: desc.mipLevelCount ?? 1, size: desc.size },
    });
  }

  /** A texture owned elsewhere (the canvas texture, a persistent shadow map). The graph never allocates or frees it. */
  importTexture(name: string, texture: GPUTexture): TextureHandle {
    return this.addResource({ name, imported: texture, desc: null });
  }

  addRenderPass(name: string, setup: (builder: RenderPassBuilder) => RenderPassExecute): void {
    const pass = this.newPass(name, 'render');
    const builder: RenderPassBuilder = {
      read: (h) => this.sample(pass, h),
      sideEffect: () => void (pass.sideEffect = true),
      colorAttachment: (h, o = {}) => {
        const res = this.resource(h);
        const resolve = o.resolveTarget ? this.resource(o.resolveTarget) : null;
        const loadOp = o.loadOp ?? 'clear';
        pass.colors.push({ res, loadOp, clearValue: o.clearValue, resolve });
        this.attach(pass, res, loadOp);
        if (resolve) this.attach(pass, resolve, 'clear');
      },
      depthAttachment: (h, o = {}) => {
        if (pass.depth) throw new Error(`Frame graph: pass "${name}" has two depth attachments`);
        const res = this.resource(h);
        const depthLoadOp = o.depthLoadOp ?? 'clear';
        pass.depth = { res, depthLoadOp, depthClearValue: o.depthClearValue };
        this.attach(pass, res, depthLoadOp);
      },
    };
    pass.execute = setup(builder);
  }

  addComputePass(name: string, setup: (builder: ComputePassBuilder) => ComputePassExecute): void {
    const pass = this.newPass(name, 'compute');
    const builder: ComputePassBuilder = {
      read: (h) => this.sample(pass, h),
      sideEffect: () => void (pass.sideEffect = true),
      readStorage: (h) => {
        const res = this.resource(h);
        pass.reads.add(res);
        res.usage |= STORAGE_BINDING;
      },
      writeStorage: (h) => {
        const res = this.resource(h);
        pass.writes.add(res);
        res.usage |= STORAGE_BINDING;
      },
    };
    pass.execute = setup(builder);
  }

  /**
   * Orders and culls this frame's passes. Throws when a pass reads a transient texture no pass writes, or when
   * passes depend on each other in a cycle.
   */
  compile(): CompiledFrame {
    const { order, run } = this.plan();
    return { passes: run.map((p) => p.name), culled: order.filter((p) => !run.includes(p)).map((p) => p.name) };
  }

  private plan(): { order: Pass[]; run: Pass[] } {
    const order = this.order();
    const alive = this.alive();
    return { order, run: order.filter((p) => alive.has(p)) };
  }

  /** Compiles and records this frame's passes into one command encoder, submits it, and starts the next frame. */
  execute(): CompiledFrame {
    try {
      const { order, run } = this.plan();
      this.lifetimes(run);
      const encoder = this.device.createCommandEncoder({ label: 'frame' });
      const texture = (h: TextureHandle) => this.gpuTexture(this.resource(h));
      const view = (h: TextureHandle) => this.gpuTexture(this.resource(h)).createView();
      run.forEach((pass, i) => {
        for (const r of this.resources) if (r.first === i && !r.imported) this.allocate(r);
        encoder.pushDebugGroup(pass.name);
        if (pass.kind === 'render') {
          const pe = encoder.beginRenderPass(this.renderPassDescriptor(pass, i, run));
          (pass.execute as RenderPassExecute)(pe, { texture, view, target: this.renderTarget(pass) });
          pe.end();
        } else {
          const pe = encoder.beginComputePass({ label: pass.name });
          (pass.execute as ComputePassExecute)(pe, { texture, view, target: null });
          pe.end();
        }
        encoder.popDebugGroup();
        // Free for transients that start later this frame.
        for (const r of this.resources) if (r.last === i && r.entry) r.entry.inUse = false;
      });
      this.device.queue.submit([encoder.finish()]);
      return { passes: run.map((p) => p.name), culled: order.filter((p) => !run.includes(p)).map((p) => p.name) };
    } finally {
      this.endFrame();
    }
  }

  /** Frees every pooled texture. */
  destroy(): void {
    this.releaseAll();
  }

  // ---- declaration

  private addResource(r: Pick<Resource, 'name' | 'imported' | 'desc'>): TextureHandle {
    this.resources.push({ ...r, usage: 0, writers: [], readers: [], first: -1, last: -1, texture: null, entry: null });
    return new TextureHandle(r.name, this, this.frame, this.resources.length - 1);
  }

  private resource(h: TextureHandle): Resource {
    if (h._graph !== this || h._frame !== this.frame || !this.resources[h._index]) {
      throw new Error(`Frame graph: texture "${h.name}" belongs to another frame`);
    }
    return this.resources[h._index];
  }

  private newPass(name: string, kind: Pass['kind']): Pass {
    const pass: Pass = { name, index: this.passes.length, kind, sideEffect: false, reads: new Set(), writes: new Set(), colors: [], depth: null, execute: null };
    this.passes.push(pass);
    return pass;
  }

  private sample(pass: Pass, h: TextureHandle): void {
    const res = this.resource(h);
    pass.reads.add(res);
    res.usage |= TEXTURE_BINDING;
  }

  private attach(pass: Pass, res: Resource, loadOp: GPULoadOp): void {
    pass.writes.add(res);
    if (loadOp === 'load') pass.reads.add(res);
    res.usage |= RENDER_ATTACHMENT;
  }

  // ---- compile

  /** Passes in execution order: dependencies first, declaration order otherwise. */
  private order(): Pass[] {
    for (const r of this.resources) {
      r.writers = this.passes.filter((p) => p.writes.has(r));
      r.readers = this.passes.filter((p) => p.reads.has(r));
    }
    const deps = new Map<Pass, Set<Pass>>(this.passes.map((p) => [p, new Set()]));
    for (const r of this.resources) {
      if (!r.imported && r.readers.length && (!r.writers.length || r.writers[0].reads.has(r))) {
        const reader = r.writers[0]?.reads.has(r) ? r.writers[0] : r.readers[0];
        throw new Error(`Frame graph: pass "${reader.name}" reads "${r.name}", which no earlier pass writes`);
      }
      r.writers.forEach((w, i) => i > 0 && deps.get(w)!.add(r.writers[i - 1]));
      // A load is ordered among the writers; a plain read comes after all of them.
      for (const p of r.readers) if (!p.writes.has(r)) for (const w of r.writers) deps.get(p)!.add(w);
    }
    const out: Pass[] = [];
    const done = new Set<Pass>();
    while (out.length < this.passes.length) {
      const next = this.passes.find((p) => !done.has(p) && [...deps.get(p)!].every((d) => done.has(d)));
      if (!next) {
        const stuck = this.passes.filter((p) => !done.has(p)).map((p) => `"${p.name}"`);
        throw new Error(`Frame graph: passes ${stuck.join(', ')} depend on each other in a cycle`);
      }
      done.add(next);
      out.push(next);
    }
    return out;
  }

  /** Passes whose results are used: the ones writing imported textures or marked sideEffect, and what they read. */
  private alive(): Set<Pass> {
    const alive = new Set(this.passes.filter((p) => p.sideEffect || [...p.writes].some((r) => r.imported)));
    const stack = [...alive];
    while (stack.length) {
      for (const r of stack.pop()!.reads) {
        for (const w of r.writers) {
          if (alive.has(w)) continue;
          alive.add(w);
          stack.push(w);
        }
      }
    }
    return alive;
  }

  private lifetimes(run: Pass[]): void {
    run.forEach((p, i) => {
      for (const r of [...p.reads, ...p.writes]) {
        if (r.first < 0) r.first = i;
        r.last = i;
      }
    });
  }

  // ---- execute

  private renderPassDescriptor(pass: Pass, at: number, run: Pass[]): GPURenderPassDescriptor {
    // An attachment no later pass reads needn't be written back to memory (imported ones always are).
    const storeOp = (r: Resource): GPUStoreOp => (r.imported || run.slice(at + 1).some((p) => p.reads.has(r)) ? 'store' : 'discard');
    const desc: GPURenderPassDescriptor = {
      label: pass.name,
      colorAttachments: pass.colors.map((c) => ({
        view: this.gpuTexture(c.res).createView(),
        ...(c.resolve ? { resolveTarget: this.gpuTexture(c.resolve).createView() } : {}),
        ...(c.clearValue !== undefined ? { clearValue: c.clearValue } : {}),
        loadOp: c.loadOp,
        storeOp: storeOp(c.res),
      })),
    };
    if (pass.depth) {
      const d = pass.depth;
      desc.depthStencilAttachment = {
        view: this.gpuTexture(d.res).createView(),
        ...(d.depthClearValue !== undefined ? { depthClearValue: d.depthClearValue } : {}),
        depthLoadOp: d.depthLoadOp,
        depthStoreOp: storeOp(d.res),
      };
    }
    return desc;
  }

  private renderTarget(pass: Pass): RenderTarget {
    const format = (r: Resource) => r.desc?.format ?? r.imported!.format;
    const first = pass.colors[0]?.res ?? pass.depth?.res;
    return {
      colorFormats: pass.colors.map((c) => format(c.res)),
      depthFormat: pass.depth ? format(pass.depth.res) : null,
      sampleCount: first ? (first.desc?.sampleCount ?? first.imported!.sampleCount) : 1,
    };
  }

  private gpuTexture(r: Resource): GPUTexture {
    const t = r.imported ?? r.texture;
    if (!t) throw new Error(`Frame graph: "${r.name}" isn't allocated outside the passes that use it`);
    return t;
  }

  private resolvedSize(r: Resource): [number, number] {
    const d = r.desc!;
    if (d.size) return [Math.max(1, Math.floor(d.size[0])), Math.max(1, Math.floor(d.size[1]))];
    return [Math.max(1, Math.floor(this.outputSize[0] * d.scale)), Math.max(1, Math.floor(this.outputSize[1] * d.scale))];
  }

  private allocate(r: Resource): void {
    const d = r.desc!;
    const [w, h] = this.resolvedSize(r);
    const key = `${d.format}|${w}x${h}|${d.sampleCount}|${d.mipLevelCount}|${r.usage}`;
    let entry = this.pool.find((e) => e.key === key && !e.inUse);
    if (!entry) {
      const texture = this.device.createTexture({
        label: r.name,
        size: [w, h],
        format: d.format,
        sampleCount: d.sampleCount,
        mipLevelCount: d.mipLevelCount,
        usage: r.usage,
      });
      entry = { key, texture, lastUsed: this.frame, inUse: false };
      this.pool.push(entry);
    }
    entry.inUse = true;
    entry.lastUsed = this.frame;
    r.entry = entry;
    r.texture = entry.texture;
  }

  private endFrame(): void {
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const e = this.pool[i];
      e.inUse = false;
      if (this.frame - e.lastUsed >= POOL_IDLE_FRAMES) {
        e.texture.destroy();
        this.pool.splice(i, 1);
      }
    }
    this.resources = [];
    this.passes = [];
    this.frame++;
  }

  private releaseAll(): void {
    for (const e of this.pool) e.texture.destroy();
    this.pool.length = 0;
  }
}
