// HDR → display: bloom, exposure, ACES and gamma 2.2 (the canvas isn't sRGB). Standalone (common.wgsl isn't
// prepended).
//
// A fullscreen triangle into the multisampled display target. With MSAA (fs_msaa) it's shaded once per sample: each
// sample is tone mapped on its own and the MSAA resolve averages the results, so edges look as they did when the
// scene shaders tone mapped. With temporal antialiasing (fs_resolved) the scene is one sample per pixel, already
// antialiased: it's tone mapped once per pixel, and its depth is written into the display depth target, so the
// overlay pass (still multisampled) tests the editor's helpers and world 2D against the scene.
//
// Alpha is coverage: 0 where nothing was drawn (the display-space background shows there), 1 under opaque meshes and
// the sky, in between where only blended surfaces were drawn over nothing. Blending leaves the color premultiplied
// by it, so it's divided out before the curve. Bloom spills over the background too: there it's added in display
// space.

struct Params {
  // rgb = background (display space), w = exposure
  background: vec4f,
  // xy = 1 / output size, z = bloom strength (0: off, and `bloom` is a black placeholder)
  bloom: vec4f,
};

@group(0) @binding(0) var hdr: texture_multisampled_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var bloomSampler: sampler;
@group(0) @binding(4) var resolved: texture_2d<f32>;
@group(0) @binding(5) var sceneDepth: texture_depth_2d;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}

fn acesTonemap(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn toDisplay(radiance: vec3f) -> vec3f {
  return pow(acesTonemap(radiance * params.background.w), vec3f(1.0 / 2.2));
}

fn finish(c: vec4f, pos: vec2f) -> vec4f {
  // Radiance past half float's range is stored as infinity, which the curve would turn into NaN.
  let radiance = min(c.rgb / max(c.a, 1e-4), vec3f(65504.0));
  if (params.bloom.z <= 0.0) {
    return vec4f(mix(params.background.rgb, toDisplay(radiance), c.a), 1.0);
  }
  let bloom = textureSampleLevel(bloomTex, bloomSampler, pos * params.bloom.xy, 0.0).rgb * params.bloom.z;
  let background = min(params.background.rgb + toDisplay(bloom), vec3f(1.0));
  return vec4f(mix(background, toDisplay(radiance + bloom), c.a), 1.0);
}

@fragment
fn fs_msaa(@builtin(position) pos: vec4f, @builtin(sample_index) sample: u32) -> @location(0) vec4f {
  return finish(textureLoad(hdr, vec2i(pos.xy), i32(sample)), pos.xy);
}

struct ResolvedOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fs_resolved(@builtin(position) pos: vec4f) -> ResolvedOut {
  let p = vec2i(pos.xy);
  var out: ResolvedOut;
  out.color = finish(textureLoad(resolved, p, 0), pos.xy);
  out.depth = textureLoad(sceneDepth, p, 0);
  return out;
}
