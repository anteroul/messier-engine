// Bloom, as a chain of fullscreen passes over half, quarter, … resolution targets. Standalone.
//
// prefilter: the HDR image (multisampled with MSAA, fs_prefilter_ms; or the TAA output, fs_prefilter) to half
//   resolution, keeping only what's brighter than the threshold (soft knee). The 2×2 pixels of each texel are averaged
//   with weights 1 / (1 + luma) (Karis), so a single very bright pixel doesn't flicker as a blob from frame to frame.
// down: each level from the one above with a 13-tap filter (Jimenez, "Next generation post processing in Call of
//   Duty"), which doesn't alias when the image moves.
// up: from the smallest level back up, each level a mix of its own downsampled image and the tent-filtered level
//   below it (by `scatter`), into a separate chain. The tonemap pass adds the top of that chain to the scene.
//
// The color is premultiplied by coverage (see tonemap.wgsl), so empty pixels add no light.

struct Params {
  // x = threshold, y = knee (both in radiance before exposure), z = scatter
  values: vec4f,
};

@group(0) @binding(0) var hdrMS: texture_multisampled_2d<f32>;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<uniform> params: Params;
@group(0) @binding(5) var high: texture_2d<f32>;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: VSOut;
  out.clip = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y);
  return out;
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn threshold(c: vec3f) -> vec3f {
  let t = params.values.x;
  let knee = params.values.y;
  let brightness = max(c.r, max(c.g, c.b));
  var soft = clamp(brightness - t + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-5);
  return c * (max(soft, brightness - t) / max(brightness, 1e-5));
}

// The Karis average of four colors, thresholded. Half floats past their range come back as infinity: clamp.
fn prefilter4(a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec4f {
  let wa = 1.0 / (1.0 + luma(a));
  let wb = 1.0 / (1.0 + luma(b));
  let wc = 1.0 / (1.0 + luma(c));
  let wd = 1.0 / (1.0 + luma(d));
  let sum = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
  return vec4f(threshold(min(sum, vec3f(65504.0))), 1.0);
}

fn loadMS(p: vec2i) -> vec3f {
  let size = vec2i(textureDimensions(hdrMS));
  let q = clamp(p, vec2i(0), size - 1);
  let n = i32(textureNumSamples(hdrMS));
  var c = vec3f(0.0);
  for (var i = 0; i < n; i++) {
    c += min(textureLoad(hdrMS, q, i).rgb, vec3f(65504.0));
  }
  return c / f32(n);
}

fn load(p: vec2i) -> vec3f {
  let size = vec2i(textureDimensions(hdr));
  return min(textureLoad(hdr, clamp(p, vec2i(0), size - 1), 0).rgb, vec3f(65504.0));
}

@fragment
fn fs_prefilter_ms(in: VSOut) -> @location(0) vec4f {
  let p = vec2i(in.clip.xy) * 2;
  return prefilter4(loadMS(p), loadMS(p + vec2i(1, 0)), loadMS(p + vec2i(0, 1)), loadMS(p + vec2i(1, 1)));
}

@fragment
fn fs_prefilter(in: VSOut) -> @location(0) vec4f {
  let p = vec2i(in.clip.xy) * 2;
  return prefilter4(load(p), load(p + vec2i(1, 0)), load(p + vec2i(0, 1)), load(p + vec2i(1, 1)));
}

fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(source, linearSampler, uv, 0.0).rgb;
}

@fragment
fn fs_down(in: VSOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(source));
  let uv = in.uv;
  let a = tap(uv + t * vec2f(-2.0, -2.0));
  let b = tap(uv + t * vec2f(0.0, -2.0));
  let c = tap(uv + t * vec2f(2.0, -2.0));
  let d = tap(uv + t * vec2f(-2.0, 0.0));
  let e = tap(uv);
  let f = tap(uv + t * vec2f(2.0, 0.0));
  let g = tap(uv + t * vec2f(-2.0, 2.0));
  let h = tap(uv + t * vec2f(0.0, 2.0));
  let i = tap(uv + t * vec2f(2.0, 2.0));
  let j = tap(uv + t * vec2f(-1.0, -1.0));
  let k = tap(uv + t * vec2f(1.0, -1.0));
  let l = tap(uv + t * vec2f(-1.0, 1.0));
  let m = tap(uv + t * vec2f(1.0, 1.0));
  let c0 = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  return vec4f(c0, 1.0);
}

@fragment
fn fs_up(in: VSOut) -> @location(0) vec4f {
  // A 3×3 tent over the smaller level (`source`), one of its texels wide.
  let t = 1.0 / vec2f(textureDimensions(source));
  let uv = in.uv;
  var low = tap(uv) * 4.0;
  low += (tap(uv + vec2f(-t.x, 0.0)) + tap(uv + vec2f(t.x, 0.0)) + tap(uv + vec2f(0.0, -t.y)) + tap(uv + vec2f(0.0, t.y))) * 2.0;
  low += tap(uv + vec2f(-t.x, -t.y)) + tap(uv + vec2f(t.x, -t.y)) + tap(uv + vec2f(-t.x, t.y)) + tap(uv + vec2f(t.x, t.y));
  low /= 16.0;
  let own = textureSampleLevel(high, linearSampler, uv, 0.0).rgb;
  return vec4f(mix(own, low, params.values.z), 1.0);
}
