// Shared by the mesh shaders (prepended to mesh.wgsl and shadow.wgsl): the per-material uniforms and the per-instance
// object data. Layouts must match Renderer.prepareMaterial() (Material, 64 B) and DrawList's packing (Object, 128 B).

struct Material {
  baseColor: vec4f,
  // rgb = emissive (linear, pre-multiplied by strength), w = metallic
  emissive: vec4f,
  // x = roughness, y = unlit flag, z = alpha cutoff, w = has normal map
  params: vec4f,
  // x = normal scale, y = occlusion strength
  maps: vec4f,
};

struct Object {
  model: mat4x4f,
  normal: mat4x4f,
};
