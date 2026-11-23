// GPU time per frame graph pass, from timestamp queries (the `timestamp-query` device feature).
//
// Each timed pass writes a timestamp when it begins and one when it ends. After the last pass the query set is
// resolved into a buffer and copied to a mappable one, which is read back once the GPU has run the frame, so
// results arrive a few frames late. Readback buffers are pooled; when all are still waiting, a frame goes untimed.

import type { PassTimer } from './frameGraph';

/** GPUBufferUsage / GPUMapMode values, spelled out so unit tests can run this without WebGPU's globals. */
const MAP_READ = 0x0001;
const COPY_SRC = 0x0004;
const COPY_DST = 0x0008;
const QUERY_RESOLVE = 0x0200;
const MAP_MODE_READ = 0x0001;

/** Readbacks that may be waiting at once. */
const MAX_READBACKS = 4;

export class GpuTimer implements PassTimer {
  /** Called with a frame's pass names (execution order) and their GPU times in milliseconds. */
  onResults: ((names: string[], ms: number[]) => void) | null = null;

  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly free: GPUBuffer[] = [];
  private readbacks = 0;
  private names: string[] = [];
  private target: GPUBuffer | null = null;
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    /** Passes timed per frame; later ones go untimed. */
    readonly maxPasses = 16,
  ) {
    this.querySet = device.createQuerySet({ label: 'pass times', type: 'timestamp', count: maxPasses * 2 });
    this.resolveBuffer = device.createBuffer({ label: 'pass times', size: maxPasses * 16, usage: QUERY_RESOLVE | COPY_SRC });
  }

  begin(): void {
    // A frame that threw before submitted() left its buffer here.
    if (this.target) this.free.push(this.target);
    this.names = [];
    this.target = this.free.pop() ?? null;
    if (!this.target && this.readbacks < MAX_READBACKS) {
      this.target = this.device.createBuffer({ label: 'pass times readback', size: this.maxPasses * 16, usage: MAP_READ | COPY_DST });
      this.readbacks++;
    }
  }

  timestampWrites(pass: string): GPURenderPassTimestampWrites | undefined {
    if (!this.target || this.names.length >= this.maxPasses) return undefined;
    const i = this.names.length;
    this.names.push(pass);
    return { querySet: this.querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }

  resolve(encoder: GPUCommandEncoder): void {
    const n = this.names.length;
    if (!this.target || n === 0) return;
    encoder.resolveQuerySet(this.querySet, 0, n * 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.target, 0, n * 16);
  }

  submitted(): void {
    const buffer = this.target;
    const names = this.names;
    this.target = null;
    if (!buffer) return;
    if (names.length === 0) {
      this.free.push(buffer);
      return;
    }
    buffer.mapAsync(MAP_MODE_READ, 0, names.length * 16).then(
      () => {
        if (this.destroyed) return;
        const t = new BigUint64Array(buffer.getMappedRange(0, names.length * 16));
        // Nanoseconds. A pair can come back out of order (the counter may reset): report 0 rather than nonsense.
        const ms = names.map((_, i) => (t[i * 2 + 1] > t[i * 2] ? Number(t[i * 2 + 1] - t[i * 2]) / 1e6 : 0));
        buffer.unmap();
        this.free.push(buffer);
        this.onResults?.(names, ms);
      },
      // The device was lost or the buffer destroyed: nothing to report.
      () => undefined,
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    for (const b of this.free) b.destroy();
    this.free.length = 0;
  }
}
