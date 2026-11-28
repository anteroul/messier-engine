// Shared declarations, prepended to mesh/grid/overlay/sky shaders by the renderer.
// Layout must match the frame packing in Renderer.render().

struct Frame {
  viewProj: mat4x4f,
  cameraPos: vec4f,
  // rgb = ambient color (linear), w = exposure (unused here: the tonemap pass applies it)
  ambient: vec4f,
  lightCount: u32,
  shadowIndex: i32,
  time: f32,
  // 1 / shadow map size: a texel in the shadow map's UV space
  shadowTexel: f32,
  invViewProj: mat4x4f,
  // Gradient sky colors (linear). skyTop.w = image sky intensity.
  skyTop: vec4f,
  skyHorizon: vec4f,
  skyGround: vec4f,
  // xyz = direction toward the sun, w = cos(sun disc radius); w >= 1 means no sun.
  sunDir: vec4f,
  // rgb = sun color × intensity, w = glow strength
  sunColor: vec4f,
  // x = mode (0 color, 1 gradient, 2 image), y = lighting strength, z = image rotation (radians), w = image mip count
  sky: vec4f,
  // xyz = camera forward, w = cascade count (0: no shadows)
  cameraForward: vec4f,
  // Per cascade (x, y, z, w = cascades 0..3): view depth where it ends, world size of a texel, depth bias.
  cascadeFar: vec4f,
  cascadeTexel: vec4f,
  cascadeBias: vec4f,
  // World to each cascade's shadow map clip space (normal Z).
  cascades: array<mat4x4f, 4>,
  // The previous frame's viewProj, for motion vectors (temporal antialiasing).
  prevViewProj: mat4x4f,
  // xy = this frame's subpixel offset in NDC, added to mesh clip positions (0 without temporal antialiasing). viewProj
  // itself isn't jittered, so the overlay pass's helpers drawn after the resolve stay put.
  jitter: vec4f,
};

// 64 bytes per light, see Renderer.writeLights().
struct Light {
  // xyz = world position, w = type (0 directional, 1 point, 2 spot)
  position: vec4f,
  // xyz = world direction, w = range
  direction: vec4f,
  // rgb = linear color, a = intensity
  color: vec4f,
  // x = cos(inner angle), y = cos(outer angle), z = first point/spot shadow layer (-1: no shadow),
  // w = shadow texel size per unit of distance from the light
  params: vec4f,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(4) var skyTex: texture_2d<f32>;
@group(0) @binding(5) var skySampler: sampler;

const PI = 3.14159265359;

// Linear radiance of the sky toward unit direction d. `level` is the image sky's mip to read (the environment capture
// reads a smaller one than the screen, so the panorama doesn't alias); `sunDisc` (0 or 1) includes the gradient sky's
// sun disc, which the environment capture leaves out: lit surfaces already get the sun's highlight from its light.
fn skyRadiance(d: vec3f, level: f32, sunDisc: f32) -> vec3f {
  if (frame.sky.x > 1.5) {
    let u = atan2(d.x, -d.z) / (2.0 * PI) + 0.5 + frame.sky.z / (2.0 * PI);
    let v = acos(clamp(d.y, -1.0, 1.0)) / PI;
    return textureSampleLevel(skyTex, skySampler, vec2f(u, v), level).rgb * frame.skyTop.w;
  }
  let up = mix(frame.skyHorizon.rgb, frame.skyTop.rgb, pow(clamp(d.y, 0.0, 1.0), 0.5));
  let down = mix(frame.skyHorizon.rgb, frame.skyGround.rgb, pow(clamp(-d.y, 0.0, 1.0), 0.35));
  var c = mix(down, up, smoothstep(-0.015, 0.015, d.y));
  if (frame.sunDir.w < 1.0) {
    let cosA = dot(d, frame.sunDir.xyz);
    let edge = 1.0 - frame.sunDir.w;
    let disc = smoothstep(frame.sunDir.w - edge * 0.3, frame.sunDir.w + edge * 0.05, cosA) * sunDisc;
    let glow = pow(max(cosA, 0.0), 48.0) * frame.sunColor.w;
    c += frame.sunColor.rgb * (disc * 25.0 + glow * 0.3);
  }
  return c;
}
