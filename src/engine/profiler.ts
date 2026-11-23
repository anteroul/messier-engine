// Frame profiling: where a frame's time goes on the CPU (nested named sections) and on the GPU (one time per frame
// graph pass, from timestamp queries). Off by default: begin()/end() are then a single branch, and the renderer
// writes no timestamps. The editor's profiler panel turns it on and reads `profiler` a few times a second.

/** Frames of frame-time history kept for the graph. */
export const PROFILER_HISTORY = 120;
/** How fast averages follow new values (an exponential moving average). */
const SMOOTHING = 0.1;
/** Frames a section may go without running before it's dropped from the list. */
const IDLE_FRAMES = 120;

/** One section of the last finished frame. Sections come in tree order: a parent, then its children (depth + 1). */
export interface ProfileSection {
  name: string;
  depth: number;
  /** Milliseconds spent in the section during the frame, all of its runs together. */
  ms: number;
  /** Smoothed `ms`. */
  avg: number;
  /** Times it ran during the frame (fixed steps run several times, or not at all). */
  calls: number;
}

/** GPU time of one frame graph pass. */
export interface GpuPassTime {
  name: string;
  ms: number;
  avg: number;
}

interface SectionNode {
  name: string;
  ms: number;
  calls: number;
  avg: number;
  start: number;
  idle: number;
  children: SectionNode[];
}

const newNode = (name: string): SectionNode => ({ name, ms: 0, calls: 0, avg: -1, start: 0, idle: 0, children: [] });
const smooth = (avg: number, value: number) => (avg < 0 ? value : avg + (value - avg) * SMOOTHING);

export class Profiler {
  /** Record sections and GPU pass times. While off, nothing is measured and the results keep their last values. */
  enabled = false;
  /** The clock, in milliseconds. Replaceable for tests. */
  now: () => number = () => performance.now();

  /** Time from the previous frame to the last finished one, in milliseconds. */
  frameMs = 0;
  avgFrameMs = 0;
  /** Time the engine spent on the last finished frame (the top-level sections together). */
  cpuMs = 0;
  avgCpuMs = 0;
  /** Frames finished while enabled. */
  frames = 0;
  /** The last PROFILER_HISTORY frame times, a ring: `historyIndex` is the oldest entry (the next one written). */
  readonly history = new Float32Array(PROFILER_HISTORY);
  historyIndex = 0;
  /** The last finished frame's sections, in tree order. */
  sections: ProfileSection[] = [];

  /** Whether the device can time passes (the `timestamp-query` feature). The renderer sets it. */
  gpuSupported = false;
  /** GPU time per frame graph pass, in execution order. A few frames behind: the results are read back asynchronously. */
  gpu: GpuPassTime[] = [];
  /** The passes of `gpu` together. */
  gpuMs = 0;
  avgGpuMs = 0;

  private readonly root = newNode('');
  private readonly stack: SectionNode[] = [];
  private readonly gpuAvg = new Map<string, number>();

  /** Opens a section inside the one that's open (or at the top level). Close it with end(). */
  begin(name: string): void {
    if (!this.enabled) return;
    const parent = this.stack.length ? this.stack[this.stack.length - 1] : this.root;
    let node: SectionNode | undefined;
    for (const c of parent.children) if (c.name === name) node = c;
    if (!node) parent.children.push((node = newNode(name)));
    node.start = this.now();
    this.stack.push(node);
  }

  /** Closes the section opened last. */
  end(): void {
    // Empty when profiling was turned on between a begin() and its end().
    const node = this.stack.pop();
    if (!node) return;
    node.ms += this.now() - node.start;
    node.calls++;
  }

  /** Times `fn` as a section. */
  measure<T>(name: string, fn: () => T): T {
    this.begin(name);
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  /** Publishes the frame's sections and starts the next frame. `frameMs` is the time since the previous frame. */
  endFrame(frameMs: number): void {
    if (!this.enabled) return;
    // Sections left open by an exception don't leak into the next frame.
    this.stack.length = 0;
    const out: ProfileSection[] = [];
    let cpu = 0;
    for (const c of this.root.children) cpu += c.ms;
    this.publish(this.root, 0, out);
    this.sections = out;
    this.cpuMs = cpu;
    this.frameMs = frameMs;
    this.avgCpuMs = this.frames ? smooth(this.avgCpuMs, cpu) : cpu;
    this.avgFrameMs = this.frames ? smooth(this.avgFrameMs, frameMs) : frameMs;
    this.history[this.historyIndex] = frameMs;
    this.historyIndex = (this.historyIndex + 1) % PROFILER_HISTORY;
    this.frames++;
  }

  /** GPU pass times of one frame, as the renderer's timer reads them back. */
  setGpuTimes(names: readonly string[], ms: readonly number[]): void {
    let total = 0;
    this.gpu = names.map((name, i) => {
      const avg = smooth(this.gpuAvg.get(name) ?? -1, ms[i]);
      this.gpuAvg.set(name, avg);
      total += ms[i];
      return { name, ms: ms[i], avg };
    });
    this.avgGpuMs = this.gpuMs || this.avgGpuMs ? smooth(this.avgGpuMs, total) : total;
    this.gpuMs = total;
  }

  /** Forgets everything measured so far. */
  reset(): void {
    this.root.children.length = 0;
    this.stack.length = 0;
    this.sections = [];
    this.gpu = [];
    this.gpuAvg.clear();
    this.history.fill(0);
    this.historyIndex = this.frames = 0;
    this.frameMs = this.avgFrameMs = this.cpuMs = this.avgCpuMs = this.gpuMs = this.avgGpuMs = 0;
  }

  private publish(parent: SectionNode, depth: number, out: ProfileSection[]): void {
    const children = parent.children;
    for (let i = 0; i < children.length; i++) {
      const n = children[i];
      n.idle = n.calls ? 0 : n.idle + 1;
      if (n.idle > IDLE_FRAMES) {
        children.splice(i--, 1);
        continue;
      }
      n.avg = smooth(n.avg, n.ms);
      out.push({ name: n.name, depth, ms: n.ms, avg: n.avg, calls: n.calls });
      n.ms = 0;
      n.calls = 0;
      this.publish(n, depth + 1, out);
    }
  }
}

/** The engine's profiler. Engine.step and the renderer report to it; add your own sections with begin()/end(). */
export const profiler = new Profiler();
