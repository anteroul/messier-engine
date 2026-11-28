// Cube map texel directions, prepended to envCapture.wgsl and environment.wgsl. Faces are in WebGPU's layer order
// (+X, −X, +Y, −Y, +Z, −Z); `uv` runs from −1 to 1 across a face, u to the right and v down, as the texel grid does.

fn cubeDir(face: u32, uv: vec2f) -> vec3f {
  let u = uv.x;
  let v = uv.y;
  switch face {
    case 0u: { return normalize(vec3f(1.0, -v, -u)); }
    case 1u: { return normalize(vec3f(-1.0, -v, u)); }
    case 2u: { return normalize(vec3f(u, 1.0, v)); }
    case 3u: { return normalize(vec3f(u, -1.0, -v)); }
    case 4u: { return normalize(vec3f(u, -v, 1.0)); }
    default: { return normalize(vec3f(-u, -v, -1.0)); }
  }
}

// The direction through the center of texel `id.xy` of face `id.z` on a `size`² face.
fn texelDir(id: vec3u, size: u32) -> vec3f {
  let uv = (vec2f(id.xy) + 0.5) / f32(size) * 2.0 - 1.0;
  return cubeDir(id.z, uv);
}
