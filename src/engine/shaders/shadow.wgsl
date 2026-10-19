// Depth-only pass for the directional shadow map.

struct ShadowFrame {
  lightViewProj: mat4x4f,
};

struct Object {
  model: mat4x4f,
  normal: mat4x4f,
};

@group(0) @binding(0) var<uniform> shadow: ShadowFrame;
@group(1) @binding(0) var<uniform> object: Object;

@vertex
fn vs_main(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return shadow.lightViewProj * object.model * vec4f(position, 1.0);
}
