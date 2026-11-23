import { check, eq, near } from './harness';
import { Profiler, PROFILER_HISTORY } from '@root/src/engine/profiler.ts';
import { GpuTimer } from '@root/src/engine/gpuTimer.ts';
import { FrameGraph } from '@root/src/engine/frameGraph.ts';

// The profiler's bookkeeping on a fake clock, and the GPU pass timer against a fake device.

// ---- sections: nested, accumulated per frame, published in tree order
{
  const p = new Profiler();
  let t = 0;
  p.now = () => t;
  const section = (name: string, ms: number, inner?: () => void) => {
    p.begin(name);
    inner?.();
    t += ms;
    p.end();
  };
  section('ignored', 5);
  p.endFrame(16);
  eq('nothing is measured while disabled', [p.sections.length, p.frames, p.cpuMs], [0, 0, 0]);

  p.enabled = true;
  const frame = (fixedSteps: number) => {
    section('fixed update', 0, () => {
      for (let i = 0; i < fixedSteps; i++) {
        section('scripts', 1);
        section('physics', 2);
      }
    });
    section('render', 1, () => section('passes', 3));
  };
  frame(2);
  p.endFrame(20);
  eq('sections come in tree order with depths', p.sections.map((s) => `${s.depth}:${s.name}`), ['0:fixed update', '1:scripts', '1:physics', '0:render', '1:passes']);
  eq('repeated sections add up', p.sections.map((s) => [s.ms, s.calls]), [[6, 1], [2, 2], [4, 2], [4, 1], [3, 1]]);
  eq('cpu time is the top-level sections together', [p.cpuMs, p.frameMs, p.frames], [10, 20, 1]);
  eq('the first frame seeds the averages', [p.avgCpuMs, p.avgFrameMs, p.sections[2].avg], [10, 20, 4]);

  frame(0);
  p.endFrame(10);
  const physics = p.sections.find((s) => s.name === 'physics')!;
  eq('a section that did not run stays listed, at 0', [physics.ms, physics.calls], [0, 0]);
  near('averages follow new values slowly', [physics.avg, p.avgFrameMs, p.avgCpuMs], [3.6, 19, 9.4]);
  eq('history is a ring of frame times', [p.history[0], p.history[1], p.historyIndex], [20, 10, 2]);

  for (let i = 0; i < 200; i++) {
    section('render', 1);
    p.endFrame(10);
  }
  eq('sections idle for long are dropped', p.sections.map((s) => s.name), ['render']);
  eq('the history wraps', [p.historyIndex, p.history.length], [202 % PROFILER_HISTORY, PROFILER_HISTORY]);

  // An end() without its begin() (profiling turned on in between), and a section left open by an exception.
  p.end();
  p.begin('left open');
  p.endFrame(10);
  section('render', 1);
  p.endFrame(10);
  eq('unbalanced sections do not leak into the next frame', p.sections.filter((s) => s.depth > 0).length, 0);
  eq('measure() times a function and returns its result', [p.measure('m', () => 7), (p.endFrame(1), p.sections.some((s) => s.name === 'm'))], [7, true]);

  p.setGpuTimes(['shadow', 'main'], [1, 3]);
  p.setGpuTimes(['shadow', 'main'], [2, 3]);
  eq('gpu pass times', p.gpu.map((g) => [g.name, g.ms]), [['shadow', 2], ['main', 3]]);
  near('gpu averages', [p.gpu[0].avg, p.gpuMs, p.avgGpuMs], [1.1, 5, 4.1]);
  p.reset();
  eq('reset forgets everything', [p.sections.length, p.gpu.length, p.frames, p.history[0]], [0, 0, 0, 0]);
}

// ---- GPU timer: two timestamps per pass, resolved and read back after submit
{
  const log: string[] = [];
  const passDescs: any[] = [];
  let mapped: (() => void)[] = [];
  let buffers = 0;
  // What the "GPU" writes into the readback buffer: begin/end nanoseconds per pass.
  let stamps: bigint[] = [];
  const device = {
    createQuerySet: (d: any) => ({ count: d.count, destroy: () => log.push('destroy queries') }),
    createBuffer: (d: any) => {
      const id = ++buffers;
      return {
        label: d.label,
        mapAsync: () => new Promise<void>((resolve) => mapped.push(resolve)),
        getMappedRange: (_o: number, size: number) => {
          const data = new BigUint64Array(size / 8);
          data.set(stamps.slice(0, size / 8));
          return data.buffer;
        },
        unmap: () => log.push(`unmap ${id}`),
        destroy: () => log.push(`destroy ${id}`),
      };
    },
    createTexture: (d: any) => ({ ...d, createView: () => ({}), destroy() {} }),
    createCommandEncoder: () => ({
      pushDebugGroup() {},
      popDebugGroup() {},
      beginRenderPass(d: any) {
        passDescs.push(d);
        return { end() {} };
      },
      resolveQuerySet: (_q: any, first: number, count: number) => log.push(`resolve ${first}+${count}`),
      copyBufferToBuffer: (_s: any, _so: number, _d: any, _do: number, size: number) => log.push(`copy ${size}`),
      finish: () => ({}),
    }),
    queue: { submit: () => log.push('submit') },
  } as unknown as GPUDevice;

  const timer = new GpuTimer(device, 2);
  const results: [string[], number[]][] = [];
  timer.onResults = (names, ms) => results.push([names, ms]);
  const g = new FrameGraph(device);
  g.timer = timer;
  const frame = (passes: string[]) => {
    passDescs.length = 0;
    const out = g.importTexture('canvas', { format: 'bgra8unorm', sampleCount: 1, createView: () => ({}) } as unknown as GPUTexture);
    for (const name of passes) g.addRenderPass(name, (p) => (p.colorAttachment(out, { loadOp: 'load' }), () => undefined));
    g.execute();
  };
  const flush = async () => {
    const m = mapped;
    mapped = [];
    for (const resolve of m) resolve();
    await new Promise((r) => setTimeout(r, 0));
  };

  frame(['a', 'b', 'c']);
  eq('each timed pass gets a pair of query indices', passDescs.map((d) => d.timestampWrites && [d.timestampWrites.beginningOfPassWriteIndex, d.timestampWrites.endOfPassWriteIndex]), [[0, 1], [2, 3], undefined]);
  eq('queries are resolved and copied before the submit', log, ['resolve 0+4', 'copy 32', 'submit']);
  stamps = [1_000_000n, 3_500_000n, 9_000_000n, 8_000_000n];
  await flush();
  eq('results arrive after the readback, in milliseconds', results, [[['a', 'b'], [2.5, 0]]]);
  check('the readback buffer is unmapped for reuse', log.includes('unmap 2'), log.join(', '));

  // Readbacks still waiting: frames go untimed instead of piling up buffers.
  for (let i = 0; i < 6; i++) frame(['a']);
  eq('at most four readbacks wait at once', [buffers, !!passDescs[0].timestampWrites], [5, false]);
  await flush();
  frame(['a']);
  check('timing resumes when a readback returns', !!passDescs[0].timestampWrites);

  g.timer = null;
  frame(['a']);
  check('no timer, no timestamp writes', passDescs[0].timestampWrites === undefined);
}
