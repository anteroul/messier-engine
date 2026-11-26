// HDR → display: exposure, ACES and gamma 2.2 (the canvas isn't sRGB). Standalone (common.wgsl isn't prepended).
//
// A fullscreen triangle into the multisampled display target, shaded once per sample: each sample is tone mapped on
// its own and the MSAA resolve averages the results, so edges look as they did when the scene shaders tone mapped.
// Alpha is coverage: 0 where nothing was drawn (the display-space background shows there), 1 under opaque meshes and
// the sky, in between where only blended surfaces were drawn over nothing. Blending leaves the color premultiplied
// by it, so it's divided out before the curve.

struct Params {
  // rgb = background (display space), w = exposure
  background: vec4f,
};

@group(0) @binding(0) var hdr: texture_multisampled_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;

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

@fragment
fn fs_main(@builtin(position) pos: vec4f, @builtin(sample_index) sample: u32) -> @location(0) vec4f {
  let c = textureLoad(hdr, vec2i(pos.xy), i32(sample));
  // Radiance past half float's range is stored as infinity, which the curve would turn into NaN.
  let radiance = min(c.rgb / max(c.a, 1e-4), vec3f(65504.0));
  let display = pow(acesTonemap(radiance * params.background.w), vec3f(1.0 / 2.2));
  return vec4f(mix(params.background.rgb, display, c.a), 1.0);
}
