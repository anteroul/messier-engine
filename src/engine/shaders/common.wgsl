// Shared declarations, prepended to mesh/grid/overlay shaders by the renderer.
// Layout must match Renderer.writeFrameUniforms().

struct Frame {
  viewProj: mat4x4f,
  lightViewProj: mat4x4f,
  cameraPos: vec4f,
  // rgb = ambient color (linear), w = exposure
  ambient: vec4f,
  lightCount: u32,
  shadowIndex: i32,
  time: f32,
  shadowTexel: f32,
};

// 64 bytes per light, see Renderer.writeLights().
struct Light {
  // xyz = world position, w = type (0 directional, 1 point, 2 spot)
  position: vec4f,
  // xyz = world direction, w = range
  direction: vec4f,
  // rgb = linear color, a = intensity
  color: vec4f,
  // x = cos(inner angle), y = cos(outer angle)
  params: vec4f,
};

@group(0) @binding(0) var<uniform> frame: Frame;
