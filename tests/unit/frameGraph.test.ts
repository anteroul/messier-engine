import { check, eq, throws } from './harness';
import { FrameGraph, type TextureHandle } from '@root/src/engine/frameGraph.ts';

// The frame graph's scheduling (order, culling, pooling, store ops) against a fake GPU device that records calls.

interface FakeTexture {
  id: number;
  label: string;
  size: number[];
  format: string;
  usage: number;
  sampleCount: number;
  destroyed: boolean;
  destroy(): void;
  createView(): { texture: FakeTexture };
}

let nextTexture = 1;
const created: FakeTexture[] = [];
const log: string[] = [];
const passDescs = new Map<string, any>();

function fakeTexture(desc: any): FakeTexture {
  const t: FakeTexture = {
    id: nextTexture++,
    label: desc.label,
    size: desc.size,
    format: desc.format,
    usage: desc.usage,
    sampleCount: desc.sampleCount ?? 1,
    destroyed: false,
    destroy() {
      t.destroyed = true;
    },
    createView: () => ({ texture: t }),
  };
  return t;
}

const passEncoder = (name: string) => ({ end: () => log.push(`end ${name}`) });
const device = {
  createTexture(desc: any) {
    const t = fakeTexture(desc);
    created.push(t);
    return t;
  },
  createCommandEncoder: () => ({
    pushDebugGroup: (n: string) => log.push(`push ${n}`),
    popDebugGroup: () => log.push('pop'),
    beginRenderPass(desc: any) {
      passDescs.set(desc.label, desc);
      log.push(`begin ${desc.label}`);
      return passEncoder(desc.label);
    },
    beginComputePass(desc: any) {
      log.push(`compute ${desc.label}`);
      return passEncoder(desc.label);
    },
    finish: () => ({}),
  }),
  queue: { submit: () => log.push('submit') },
} as unknown as GPUDevice;

const reset = () => {
  log.length = 0;
  passDescs.clear();
};
const imported = (label: string, format = 'bgra8unorm') => fakeTexture({ label, size: [8, 8], format, usage: 0 }) as unknown as GPUTexture;
const targets = new Map<string, unknown>();
const ran: string[] = [];
const exec = (name: string) => () => void ran.push(name);
const tex = (d: any) => (passDescs.get(d)?.colorAttachments[0]?.view.texture as FakeTexture | undefined);

const g = new FrameGraph(device);
g.setOutputSize(100, 50);

// ---- order: a read comes after its writer, whatever the declaration order; otherwise declaration order
{
  reset();
  ran.length = 0;
  const out = g.importTexture('canvas', imported('canvas'));
  const a = g.createTexture('a', { format: 'rgba8unorm' });
  const b = g.createTexture('b', { format: 'rgba8unorm', scale: 0.5 });
  g.addRenderPass('composite', (p) => {
    p.read(a);
    p.read(b);
    p.colorAttachment(out);
    return exec('composite');
  });
  g.addRenderPass('make a', (p) => {
    p.colorAttachment(a);
    return exec('make a');
  });
  g.addRenderPass('make b', (p) => {
    p.read(a);
    p.colorAttachment(b);
    return exec('make b');
  });
  const frame = g.execute();
  eq('passes run after what they read', frame.passes, ['make a', 'make b', 'composite']);
  eq('execute functions run in that order', ran, ['make a', 'make b', 'composite']);
  eq('one encoder, a debug group per pass', log, [
    'push make a', 'begin make a', 'end make a', 'pop', 'push make b', 'begin make b', 'end make b', 'pop',
    'push composite', 'begin composite', 'end composite', 'pop', 'submit',
  ]);
  const ta = tex('make a')!, tb = tex('make b')!;
  eq('transient sizes follow the output size', [ta.size, tb.size], [[100, 50], [50, 25]]);
  check('usage is inferred from use', ta.usage === (0x10 | 0x04) && tb.usage === (0x10 | 0x04), `${ta.usage} ${tb.usage}`);
  eq('render passes are labeled', [...passDescs.keys()], ['make a', 'make b', 'composite']);
}

// ---- culling
{
  reset();
  ran.length = 0;
  const out = g.importTexture('canvas', imported('canvas'));
  const unused = g.createTexture('unused', { format: 'rgba8unorm' });
  const fx = g.createTexture('fx', { format: 'rgba8unorm' });
  g.addRenderPass('dead end', (p) => {
    p.colorAttachment(unused);
    return exec('dead end');
  });
  g.addRenderPass('feeds the dead end', (p) => {
    p.colorAttachment(fx);
    return exec('feeds');
  });
  g.addRenderPass('reads fx, writes nothing used', (p) => {
    p.read(fx);
    p.colorAttachment(unused);
    return exec('x');
  });
  g.addRenderPass('picking readback', (p) => {
    p.sideEffect();
    return exec('picking');
  });
  g.addRenderPass('final', (p) => {
    p.colorAttachment(out);
    return exec('final');
  });
  const frame = g.execute();
  eq('passes whose outputs nothing reads are culled', frame.culled, ['dead end', 'feeds the dead end', 'reads fx, writes nothing used']);
  eq('imported writers and side effects survive', frame.passes, ['picking readback', 'final']);
  eq('culled passes never run', ran, ['picking', 'final']);
}

// ---- pooling: aliasing within a frame, reuse across frames, release after idle frames and on resize
const chain = (sameSize: boolean) => {
  const out = g.importTexture('canvas', imported('canvas'));
  const t1 = g.createTexture('t1', { format: 'rgba16float' });
  const t2 = g.createTexture('t2', { format: 'rgba16float' });
  const t3 = g.createTexture('t3', { format: 'rgba16float', ...(sameSize ? {} : { scale: 0.5 }) });
  const step = (name: string, read: TextureHandle | null, write: TextureHandle) =>
    g.addRenderPass(name, (p) => {
      if (read) p.read(read);
      p.colorAttachment(write);
      return exec(name);
    });
  step('p1', null, t1);
  step('p2', t1, t2);
  step('p3', t2, t3);
  step('p4', t3, out);
};
{
  const before = created.length;
  reset();
  chain(true);
  g.execute();
  const [t1, t2, t3] = ['p1', 'p2', 'p3'].map((n) => tex(n)!);
  check('a texture whose lifetime ended is reused in the same frame', t1 === t3 && t1 !== t2, `${t1.id} ${t2.id} ${t3.id}`);
  eq('so two textures cover three transients', created.length - before, 2);

  reset();
  chain(true);
  g.execute();
  check('the next frame reuses the pool', created.length - before === 2 && tex('p1') === t1 && tex('p2') === t2);

  // Overlapping lifetimes: p3 reads t1 and t2 together.
  reset();
  const out = g.importTexture('canvas', imported('canvas'));
  const a = g.createTexture('a', { format: 'rgba16float' });
  const b = g.createTexture('b', { format: 'rgba16float' });
  g.addRenderPass('a', (p) => (p.colorAttachment(a), exec('a')));
  g.addRenderPass('b', (p) => (p.colorAttachment(b), exec('b')));
  g.addRenderPass('both', (p) => (p.read(a), p.read(b), p.colorAttachment(out), exec('both')));
  g.execute();
  check('textures whose lifetimes overlap don\'t share', tex('a') !== tex('b'));

  // Idle entries go after 3 frames without use.
  const pooled = g.pooledTextures;
  const idle = () => {
    reset();
    const o = g.importTexture('canvas', imported('canvas'));
    g.addRenderPass('only', (p) => (p.colorAttachment(o), exec('only')));
    g.execute();
  };
  idle();
  idle();
  check('idle textures are kept for a while', g.pooledTextures === pooled && !t1.destroyed, `${g.pooledTextures}`);
  idle();
  check('and destroyed after 3 idle frames', g.pooledTextures === 0 && t1.destroyed && t2.destroyed, `${g.pooledTextures}`);

  reset();
  chain(false);
  g.execute();
  const kept = created.slice(-3).filter((t) => !t.destroyed);
  g.setOutputSize(100, 50);
  check('the same size keeps the pool', g.pooledTextures === kept.length && kept.every((t) => !t.destroyed));
  g.setOutputSize(200, 100);
  check('a new output size frees the pool', g.pooledTextures === 0 && kept.every((t) => t.destroyed));
}

// ---- store ops
{
  reset();
  const out = g.importTexture('canvas', imported('canvas'));
  const shadow = g.importTexture('shadow map', imported('shadow', 'depth32float'));
  const msaa = g.createTexture('msaa', { format: 'bgra8unorm', sampleCount: 4 });
  const depth = g.createTexture('depth', { format: 'depth32float', sampleCount: 4 });
  const hdr = g.createTexture('hdr', { format: 'rgba16float' });
  g.addRenderPass('shadow', (p) => (p.depthAttachment(shadow, { depthClearValue: 1 }), (_e, res) => void targets.set('shadow', res.target)));
  g.addRenderPass('main', (p) => {
    p.read(shadow);
    p.colorAttachment(hdr, { clearValue: { r: 0, g: 0, b: 0, a: 1 } });
    p.depthAttachment(depth, { depthClearValue: 0 });
    return (_e, res) => void targets.set('main', res.target);
  });
  g.addRenderPass('tonemap', (p) => {
    p.read(hdr);
    p.colorAttachment(msaa, { resolveTarget: out });
    return exec('tonemap');
  });
  g.execute();
  const main = passDescs.get('main'), tonemap = passDescs.get('tonemap'), sh = passDescs.get('shadow');
  eq('an attachment a later pass reads is stored, others discarded',
    [main.colorAttachments[0].storeOp, main.depthStencilAttachment.depthStoreOp, tonemap.colorAttachments[0].storeOp],
    ['store', 'discard', 'discard']);
  eq('imported attachments are always stored', [sh.depthStencilAttachment.depthStoreOp, sh.depthStencilAttachment.depthClearValue], ['store', 1]);
  eq('passes see their attachments\' formats', [targets.get('main'), targets.get('shadow')], [
    { colorFormats: ['rgba16float'], depthFormat: 'depth32float', sampleCount: 1 },
    { colorFormats: [], depthFormat: 'depth32float', sampleCount: 1 },
  ]);
  check('the resolve target is the imported texture', (tonemap.colorAttachments[0].resolveTarget.texture as FakeTexture).label === 'canvas');
  eq('clear values and load ops pass through', [main.colorAttachments[0].loadOp, main.colorAttachments[0].clearValue, main.depthStencilAttachment.depthLoadOp],
    ['clear', { r: 0, g: 0, b: 0, a: 1 }, 'clear']);
  const depthTex = main.depthStencilAttachment.view.texture as FakeTexture;
  eq('a multisampled depth texture: sample count, attachment-only usage', [depthTex.sampleCount, depthTex.usage], [4, 0x10]);
}

// ---- compute passes and loads
{
  reset();
  ran.length = 0;
  const out = g.importTexture('canvas', imported('canvas'));
  const bright = g.createTexture('bright', { format: 'rgba16float', scale: 0.5 });
  const blur = g.createTexture('blur', { format: 'rgba16float', scale: 0.5 });
  g.addRenderPass('draw', (p) => (p.colorAttachment(out), exec('draw')));
  g.addComputePass('threshold', (p) => (p.writeStorage(bright), exec('threshold')));
  g.addComputePass('blur', (p) => (p.readStorage(bright), p.writeStorage(blur), exec('blur')));
  g.addRenderPass('add bloom', (p) => (p.read(blur), p.colorAttachment(out, { loadOp: 'load' }), exec('add bloom')));
  const frame = g.execute();
  eq('compute passes take part like render passes', frame.passes, ['draw', 'threshold', 'blur', 'add bloom']);
  check('storage usage is inferred', created.some((t) => t.label === 'bright' && t.usage === 0x08) && created.some((t) => t.label === 'blur' && t.usage === (0x08 | 0x04)));
  check('compute passes are recorded', log.includes('compute threshold') && log.includes('compute blur'));
  eq('a loaded attachment keeps its contents', passDescs.get('add bloom').colorAttachments[0].loadOp, 'load');
}

// ---- errors
{
  reset();
  const out = g.importTexture('canvas', imported('canvas'));
  const never = g.createTexture('never written', { format: 'rgba8unorm' });
  g.addRenderPass('reader', (p) => (p.read(never), p.colorAttachment(out), exec('reader')));
  throws('reading a texture no pass writes fails', () => g.execute(), /"reader" reads "never written", which no earlier pass writes/);

  const x = g.createTexture('x', { format: 'rgba8unorm' });
  const y = g.createTexture('y', { format: 'rgba8unorm' });
  const o = g.importTexture('canvas', imported('canvas'));
  g.addRenderPass('A', (p) => (p.read(y), p.colorAttachment(x), exec('A')));
  g.addRenderPass('B', (p) => (p.read(x), p.colorAttachment(y), exec('B')));
  g.addRenderPass('C', (p) => (p.read(x), p.colorAttachment(o), exec('C')));
  throws('a cycle fails', () => g.execute(), /"A", "B", "C" depend on each other in a cycle/);

  const stale = g.createTexture('stale', { format: 'rgba8unorm' });
  g.execute();
  throws('handles are only valid in their frame', () => g.addRenderPass('late', (p) => (p.colorAttachment(stale), exec('late'))), /another frame/);
  check('a failed frame leaves the graph usable', g.compile().passes.length === 0);
}
