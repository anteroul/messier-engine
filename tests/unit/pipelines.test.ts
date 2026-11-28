import { check, eq } from './harness';
import { MeshPipelines, allMeshVariantKeys, meshVariantKey, variantKeyString, type MeshVariantKey } from '@root/src/engine/pipelines.ts';
import { Material } from '@root/src/engine/material.ts';
import type { RenderTarget } from '@root/src/engine/frameGraph.ts';

// Mesh pipeline variants: keys from materials and targets, their string form, and the cache, against a fake device.

const main: RenderTarget = { colorFormats: ['rgba16float'], depthFormat: 'depth32float', sampleCount: 4 };
const shadow: RenderTarget = { colorFormats: [], depthFormat: 'depth32float', sampleCount: 1 };

// ---- keys
{
  const opaque = new Material('opaque');
  const leaf = Object.assign(new Material('leaf'), { alphaCutoff: 0.5, doubleSided: true });
  eq('main pass: culling from the material, formats from the target', meshVariantKey('main', opaque, null, main),
    { pass: 'main', cull: 'back', alphaTest: false, blend: 'opaque', colorFormat: 'rgba16float', velocityFormat: null, sampleCount: 4, depthFormat: 'depth32float', depthCompare: 'greater' });
  eq('double-sided materials draw both faces', meshVariantKey('main', leaf, null, main).cull, 'none');
  eq('the main pass alpha-tests at runtime, not by variant', meshVariantKey('main', leaf, null, main).alphaTest, false);
  eq('shadow pass: no culling, no color, normal Z', meshVariantKey('shadow', opaque, null, shadow),
    { pass: 'shadow', cull: 'none', alphaTest: false, blend: 'opaque', colorFormat: null, velocityFormat: null, sampleCount: 1, depthFormat: 'depth32float', depthCompare: 'less' });
  eq('an alpha cutoff gets the alpha-tested shadow', meshVariantKey('shadow', leaf, null, shadow).alphaTest, true);
  const glass = Object.assign(new Material('glass'), { blend: 'alpha' as const });
  eq('blended materials get a blending main variant, and no shadow variant of their own',
    [meshVariantKey('main', glass, null, main).blend, meshVariantKey('shadow', glass, null, shadow).blend], ['alpha', 'opaque']);
  eq('the string form has a fixed field order', variantKeyString(meshVariantKey('shadow', leaf, null, shadow)),
    'pass=shadow;cull=none;alphaTest=true;blend=opaque;colorFormat=null;velocityFormat=null;sampleCount=1;depthFormat=depth32float;depthCompare=less');
  const k = meshVariantKey('main', opaque, null, main);
  const shuffled = { depthCompare: k.depthCompare, sampleCount: k.sampleCount, cull: k.cull, pass: k.pass, colorFormat: k.colorFormat, velocityFormat: k.velocityFormat, alphaTest: k.alphaTest, depthFormat: k.depthFormat, blend: k.blend };
  check('whatever order its fields were set in', variantKeyString(shuffled) === variantKeyString(k));
  const taa: RenderTarget = { colorFormats: ['rgba16float', 'rg16float'], depthFormat: 'depth32float', sampleCount: 1 };
  eq('a second color target is the velocity target (temporal antialiasing)',
    [meshVariantKey('main', opaque, null, taa).velocityFormat, meshVariantKey('main', opaque, null, taa).sampleCount], ['rg16float', 1]);
  check('targets without depth are refused', (() => {
    try {
      meshVariantKey('main', opaque, null, { colorFormats: ['rgba16float'], depthFormat: null, sampleCount: 4 });
      return false;
    } catch {
      return true;
    }
  })());
}

// ---- enumeration
const all = allMeshVariantKeys({ main, shadow });
eq('every valid key, once', all.map(variantKeyString), [
  'pass=main;cull=back;alphaTest=false;blend=opaque;colorFormat=rgba16float;velocityFormat=null;sampleCount=4;depthFormat=depth32float;depthCompare=greater',
  'pass=main;cull=back;alphaTest=false;blend=alpha;colorFormat=rgba16float;velocityFormat=null;sampleCount=4;depthFormat=depth32float;depthCompare=greater',
  'pass=main;cull=back;alphaTest=false;blend=additive;colorFormat=rgba16float;velocityFormat=null;sampleCount=4;depthFormat=depth32float;depthCompare=greater',
  'pass=main;cull=none;alphaTest=false;blend=opaque;colorFormat=rgba16float;velocityFormat=null;sampleCount=4;depthFormat=depth32float;depthCompare=greater',
  'pass=main;cull=none;alphaTest=false;blend=alpha;colorFormat=rgba16float;velocityFormat=null;sampleCount=4;depthFormat=depth32float;depthCompare=greater',
  'pass=main;cull=none;alphaTest=false;blend=additive;colorFormat=rgba16float;velocityFormat=null;sampleCount=4;depthFormat=depth32float;depthCompare=greater',
  'pass=shadow;cull=none;alphaTest=false;blend=opaque;colorFormat=null;velocityFormat=null;sampleCount=1;depthFormat=depth32float;depthCompare=less',
  'pass=shadow;cull=none;alphaTest=true;blend=opaque;colorFormat=null;velocityFormat=null;sampleCount=1;depthFormat=depth32float;depthCompare=less',
]);

eq('several targets of a pass: the variants of each', allMeshVariantKeys({
  main: [main, { colorFormats: ['rgba16float', 'rg16float'], depthFormat: 'depth32float', sampleCount: 1 }],
  shadow,
}).length, all.length + 6);

// ---- cache
const calls = { pipelines: [] as any[], async: [] as any[], modules: [] as string[], layouts: [] as any[] };
const device = {
  createShaderModule: (d: any) => (calls.modules.push(d.label), { label: d.label, code: d.code }),
  createPipelineLayout: (d: any) => (calls.layouts.push(d), { label: d.label, groups: d.bindGroupLayouts }),
  createRenderPipeline: (d: any) => (calls.pipelines.push(d), { desc: d }),
  createRenderPipelineAsync: (d: any) => (calls.async.push(d), Promise.resolve({ desc: d, async: true })),
} as unknown as GPUDevice;
const L = (name: string) => ({ name }) as unknown as GPUBindGroupLayout;
const layouts = { frame: L('frame'), material: L('material'), object: L('object'), shadowFrame: L('shadowFrame') };
const cache = new MeshPipelines(device, { common: '/*common*/', meshData: '/*data*/', mesh: '/*mesh*/', shadow: '/*shadow*/', layouts, vertexStride: 32 });
{
  const [mainBack, mainAlpha, mainAdditive, mainNone, , , shadowOpaque, shadowAlpha] = all;
  const p1 = cache.get(mainBack);
  check('a miss builds and counts', cache.builds === 1 && calls.pipelines.length === 1);
  check('a hit returns the same pipeline without building', cache.get({ ...mainBack } as MeshVariantKey) === p1 && cache.builds === 1);
  cache.get(mainNone);
  cache.get(shadowOpaque);
  cache.get(shadowAlpha);
  eq('builds are counted', [cache.builds, cache.size], [4, 4]);
  eq('shader modules are shared between variants', calls.modules, ['mesh', 'shadow']);
  check('the main module is common + mesh data + mesh, the shadow one mesh data + shadow',
    calls.pipelines[0].vertex.module.code === '/*common*//*data*//*mesh*/' && calls.pipelines[2].vertex.module.code === '/*data*//*shadow*/');
  eq('pipeline layouts too', calls.layouts.map((l) => l.bindGroupLayouts.map((g: any) => g.name)),
    [['frame', 'material', 'object'], ['shadowFrame', 'object'], ['shadowFrame', 'object', 'material']]);
  const [, , opaqueDesc, alphaDesc] = calls.pipelines;
  check('the opaque shadow variant has no fragment stage and reads positions only',
    !opaqueDesc.fragment && opaqueDesc.vertex.entryPoint === 'vs_main' && opaqueDesc.vertex.buffers[0].attributes.length === 1);
  check('the alpha-tested one reads UVs and discards in a fragment stage',
    alphaDesc.fragment?.entryPoint === 'fs_alpha' && alphaDesc.fragment.targets.length === 0 && alphaDesc.vertex.entryPoint === 'vs_alpha' &&
    alphaDesc.vertex.buffers[0].attributes[1].offset === 24);
  eq('keys reach the pipeline state', [calls.pipelines[1].primitive.cullMode, calls.pipelines[0].multisample.count, calls.pipelines[0].depthStencil.depthCompare,
    opaqueDesc.depthStencil.depthCompare, calls.pipelines[0].fragment.targets[0].format], ['none', 4, 'greater', 'less', 'rgba16float']);
  const state = (key: MeshVariantKey) => {
    const d = (cache.get(key) as any).desc;
    return [d.fragment.targets[0].blend?.color.dstFactor ?? null, d.depthStencil.depthWriteEnabled];
  };
  const taaKeys = allMeshVariantKeys({ main: { colorFormats: ['rgba16float', 'rg16float'], depthFormat: 'depth32float', sampleCount: 1 }, shadow: [] });
  const velocity = (key: MeshVariantKey) => {
    const d = (cache.get(key) as any).desc;
    return [d.fragment.entryPoint, d.fragment.targets.length, d.fragment.targets[1].format, d.fragment.targets[1].writeMask];
  };
  eq('velocity variants write motion from opaque surfaces only', [velocity(taaKeys[0]), velocity(taaKeys[1])],
    [['fs_velocity', 2, 'rg16float', 0xf], ['fs_velocity', 2, 'rg16float', 0]]);
  eq('blended variants blend and leave depth alone', [state(mainBack), state(mainAlpha), state(mainAdditive)],
    [[null, true], ['one-minus-src-alpha', false], ['one', false]]);
}

// ---- prewarm
{
  const other: RenderTarget = { colorFormats: ['rgba16float'], depthFormat: 'depth32float', sampleCount: 1 };
  const keys = allMeshVariantKeys({ main: other, shadow });
  const builds = cache.builds;
  await cache.prewarm(keys);
  eq('prewarm builds only what is missing, in the background', [calls.async.length, cache.builds], [6, builds]);
  cache.get(keys[0]);
  check('after prewarming, get() is a hit', cache.builds === builds && cache.has(keys[1]));
  await Promise.all([cache.prewarm(keys), cache.prewarm(keys)]);
  check('prewarming again builds nothing', calls.async.length === 6);
}
