// Shared declarations, prepended to mesh/grid/overlay/sky shaders by the renderer.
// Layout must match the frame packing in Renderer.render().

struct Frame {
  viewProj: mat4x4f,
  lightViewProj: mat4x4f,
  cameraPos: vec4f,
  // rgb = ambient color (linear), w = exposure (unused here: the tonemap pass applies it)
  ambient: vec4f,
  lightCount: u32,
  shadowIndex: i32,
  time: f32,
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
@group(0) @binding(4) var skyTex: texture_2d<f32>;
@group(0) @binding(5) var skySampler: sampler;

const PI = 3.14159265359;

// Linear radiance of the sky toward unit direction d. `blur` (0 sharp … 1 diffuse) widens it for rough reflections
// and ambient light: the image sky reads a smaller mip, the gradient eases toward its average. The sun disc only
// shows unblurred, because lit surfaces already get the sun's highlight from its light.
fn skyRadiance(d: vec3f, blur: f32) -> vec3f {
  if (frame.sky.x > 1.5) {
    let u = atan2(d.x, -d.z) / (2.0 * PI) + 0.5 + frame.sky.z / (2.0 * PI);
    let v = acos(clamp(d.y, -1.0, 1.0)) / PI;
    let level = blur * max(frame.sky.w - 1.0, 0.0);
    return textureSampleLevel(skyTex, skySampler, vec2f(u, v), level).rgb * frame.skyTop.w;
  }
  let w = 0.015 + blur * 0.5;
  let up = mix(frame.skyHorizon.rgb, frame.skyTop.rgb, pow(clamp(d.y, 0.0, 1.0), mix(0.5, 1.0, blur)));
  let down = mix(frame.skyHorizon.rgb, frame.skyGround.rgb, pow(clamp(-d.y, 0.0, 1.0), mix(0.35, 1.0, blur)));
  var c = mix(down, up, smoothstep(-w, w, d.y));
  let average = (frame.skyTop.rgb + 2.0 * frame.skyHorizon.rgb + frame.skyGround.rgb) * 0.25;
  c = mix(c, average, blur * blur * 0.6);
  if (frame.sunDir.w < 1.0) {
    let cosA = dot(d, frame.sunDir.xyz);
    let edge = 1.0 - frame.sunDir.w;
    let disc = smoothstep(frame.sunDir.w - edge * 0.3, frame.sunDir.w + edge * 0.05, cosA) * (1.0 - smoothstep(0.0, 0.02, blur));
    let glow = pow(max(cosA, 0.0), mix(48.0, 3.0, blur)) * frame.sunColor.w;
    c += frame.sunColor.rgb * (disc * 25.0 + glow * 0.3);
  }
  return c;
}
