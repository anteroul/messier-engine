// Depth-only pass for the directional shadow map. meshData.wgsl (Material, Object) is prepended.

struct ShadowFrame {
  lightViewProj: mat4x4f,
};

@group(0) @binding(0) var<uniform> shadow: ShadowFrame;
@group(1) @binding(0) var<uniform> object: Object;

@vertex
fn vs_main(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return shadow.lightViewProj * object.model * vec4f(position, 1.0);
}

// Alpha-tested casters (materials with an alpha cutoff): UVs in, and a fragment stage that leaves the shadow map
// alone where the base color is transparent, as the main pass discards those pixels. The material is group 2 (the
// same bind group as the main pass's group 1; the shadow pass's group 0 isn't the frame group).

@group(2) @binding(0) var<uniform> material: Material;
@group(2) @binding(1) var baseColorTex: texture_2d<f32>;
@group(2) @binding(2) var baseSampler: sampler;

struct AlphaOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_alpha(@location(0) position: vec3f, @location(1) uv: vec2f) -> AlphaOut {
  var out: AlphaOut;
  out.clip = shadow.lightViewProj * object.model * vec4f(position, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fs_alpha(in: AlphaOut) {
  // Sampled before the branch: textureSample needs uniform control flow.
  let alpha = textureSample(baseColorTex, baseSampler, in.uv).a * material.baseColor.a;
  if (alpha < material.params.z) {
    discard;
  }
}
