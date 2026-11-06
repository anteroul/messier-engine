// 2D shapes and distance-field text (standalone: doesn't use common.wgsl).
// Colors are display-space and written as is, like the overlay: no lighting, exposure or tone mapping.

struct View2D {
  // Target space → clip: the camera's view-projection (world space) or a pixel → NDC map (screen space).
  matrix: mat4x4f,
};

@group(0) @binding(0) var<uniform> view: View2D;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;

struct VSIn {
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  // < 0: solid triangle; otherwise the distance value of the glyph (or outline) edge.
  @location(3) threshold: f32,
};

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) threshold: f32,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
  var out: VSOut;
  out.clip = view.matrix * vec4f(in.position, 1.0);
  out.uv = in.uv;
  out.color = in.color;
  out.threshold = in.threshold;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  // Sample and take derivatives unconditionally (uniform control flow), then pick.
  let d = textureSample(atlas, atlasSampler, in.uv).r;
  let w = max(fwidth(d) * 0.75, 1e-4);
  let coverage = smoothstep(in.threshold - w, in.threshold + w, d);
  let a = select(coverage, 1.0, in.threshold < 0.0);
  if (in.color.a * a <= 0.002) {
    discard;
  }
  return vec4f(in.color.rgb, in.color.a * a);
}
