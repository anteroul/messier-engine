// Captures the sky (common.wgsl's skyRadiance, without the sun disc) into the environment cube's first mip. common.wgsl
// and cube.wgsl are prepended.

@group(1) @binding(0) var envOut: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn capture(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(envOut).x;
  if (id.x >= size || id.y >= size) {
    return;
  }
  // An image sky is read at about one panorama texel per cube texel: a face spans a quarter of its width.
  var level = 0.0;
  if (frame.sky.x > 1.5) {
    level = max(log2(f32(textureDimensions(skyTex).x) / (4.0 * f32(size))), 0.0);
  }
  let c = skyRadiance(texelDir(id, size), level, 0.0);
  textureStore(envOut, vec2u(id.xy), id.z, vec4f(min(c, vec3f(65504.0)), 1.0));
}
