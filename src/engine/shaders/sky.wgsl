// The sky behind everything: a fullscreen triangle at the far plane (depth 0 in reversed-Z), drawn after the opaque
// meshes with 'greater-equal', so it only fills pixels nothing else covered.

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var out: VSOut;
  out.clip = vec4f(p, 0.0, 1.0);
  out.ndc = p;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  // The view ray through this pixel: from the near plane (z = 1) toward a point further out.
  let a = frame.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let b = frame.invViewProj * vec4f(in.ndc, 0.5, 1.0);
  let d = normalize(b.xyz / b.w - a.xyz / a.w);
  return vec4f(skyRadiance(d, 0.0), 1.0);
}
