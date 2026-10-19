// Downsamples one mip level into the next with a linear filter.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  // Fullscreen triangle.
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: VSOut;
  out.clip = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return textureSample(src, srcSampler, in.uv);
}
