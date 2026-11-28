// Shared by the mesh shaders (prepended to mesh.wgsl and shadow.wgsl): the per-material uniforms and the per-instance
// object data. Layouts must match Renderer.prepareMaterial() (Material, 64 B) and DrawList's packing (Object, 192 B).

struct Material {
  baseColor: vec4f,
  // rgb = emissive (linear, pre-multiplied by strength), w = metallic
  emissive: vec4f,
  // x = roughness, y = unlit flag, z = alpha cutoff, w = has normal map
  params: vec4f,
  // x = normal scale, y = occlusion strength, z = blended (alpha out is the opacity; otherwise 1)
  maps: vec4f,
};

struct Object {
  model: mat4x4f,
  normal: mat4x4f,
  // The model matrix of the previous frame: motion vectors for temporal antialiasing.
  prevModel: mat4x4f,
};
