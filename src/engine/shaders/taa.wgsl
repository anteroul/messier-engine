// Temporal antialiasing resolve. Standalone.
//
// The main pass renders one jittered sample per pixel; this blends it into the history (the previous frames' result,
// reprojected), so over a few frames each pixel averages many subpixel positions. Reprojection follows the velocity of
// the nearest surface in the 3×3 neighbourhood (so edges move with the object in front), or, where nothing was drawn
// (the sky), the camera's motion through `reproject`. History that doesn't match the neighbourhood (disocclusion,
// lighting changes) is clipped toward the neighbourhood's color distribution (variance clipping), which keeps ghosting
// down. All of it happens on colors compressed by c / (1 + max(c)), so a few very bright pixels don't dominate.

struct Params {
  // Current NDC (x, y, reversed-Z depth) → previous frame's clip space, for pixels without a velocity.
  reproject: mat4x4f,
  // x = history valid (0 on the first frame and after a cut), y = weight of the current frame
  info: vec4f,
};

@group(0) @binding(0) var current: texture_2d<f32>;
@group(0) @binding(1) var velocityTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_depth_2d;
@group(0) @binding(3) var history: texture_2d<f32>;
@group(0) @binding(4) var historySampler: sampler;
@group(0) @binding(5) var<uniform> params: Params;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}

fn compress(c: vec4f) -> vec4f {
  let rgb = min(c.rgb, vec3f(65504.0));
  return vec4f(rgb / (1.0 + max(rgb.r, max(rgb.g, rgb.b))), c.a);
}

fn expand(c: vec4f) -> vec4f {
  return vec4f(c.rgb / max(1.0 - max(c.r, max(c.g, c.b)), 1e-4), c.a);
}

// Catmull-Rom filtered history from 9 bilinear taps: sharper than plain bilinear, which would blur a little more every
// frame.
fn sampleHistory(uv: vec2f, size: vec2f) -> vec4f {
  let samplePos = uv * size;
  let p1 = floor(samplePos - 0.5) + 0.5;
  let f = samplePos - p1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let p0 = (p1 - 1.0) / size;
  let p3 = (p1 + 2.0) / size;
  let p12 = (p1 + w2 / w12) / size;
  var c = vec4f(0.0);
  c += textureSampleLevel(history, historySampler, vec2f(p0.x, p0.y), 0.0) * w0.x * w0.y;
  c += textureSampleLevel(history, historySampler, vec2f(p12.x, p0.y), 0.0) * w12.x * w0.y;
  c += textureSampleLevel(history, historySampler, vec2f(p3.x, p0.y), 0.0) * w3.x * w0.y;
  c += textureSampleLevel(history, historySampler, vec2f(p0.x, p12.y), 0.0) * w0.x * w12.y;
  c += textureSampleLevel(history, historySampler, vec2f(p12.x, p12.y), 0.0) * w12.x * w12.y;
  c += textureSampleLevel(history, historySampler, vec2f(p3.x, p12.y), 0.0) * w3.x * w12.y;
  c += textureSampleLevel(history, historySampler, vec2f(p0.x, p3.y), 0.0) * w0.x * w3.y;
  c += textureSampleLevel(history, historySampler, vec2f(p12.x, p3.y), 0.0) * w12.x * w3.y;
  c += textureSampleLevel(history, historySampler, vec2f(p3.x, p3.y), 0.0) * w3.x * w3.y;
  return max(c, vec4f(0.0));
}

// Moves `c` toward `center` until it's inside the box center ± extent.
fn clipToBox(c: vec4f, center: vec4f, extent: vec4f) -> vec4f {
  let d = c - center;
  let unit = abs(d / max(extent, vec4f(1e-5)));
  let m = max(max(unit.x, unit.y), max(unit.z, unit.w));
  return select(c, center + d / m, m > 1.0);
}

@fragment
fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  let sizeI = vec2i(textureDimensions(current));
  let size = vec2f(sizeI);
  var m1 = vec4f(0.0);
  var m2 = vec4f(0.0);
  var center = vec4f(0.0);
  // Reversed-Z: the nearest surface has the greatest depth; 0 is nothing (the far plane).
  var nearest = -1.0;
  var nearestAt = p;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = clamp(p + vec2i(x, y), vec2i(0), sizeI - 1);
      let c = compress(textureLoad(current, q, 0));
      m1 += c;
      m2 += c * c;
      if (x == 0 && y == 0) {
        center = c;
      }
      let d = textureLoad(depthTex, q, 0);
      if (d > nearest) {
        nearest = d;
        nearestAt = q;
      }
    }
  }
  if (params.info.x < 0.5) {
    return expand(center);
  }
  let uv = (vec2f(p) + 0.5) / size;
  var previousUV: vec2f;
  if (nearest > 0.0) {
    previousUV = uv - textureLoad(velocityTex, nearestAt, 0).xy;
  } else {
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let clip = params.reproject * vec4f(ndc, 0.0, 1.0);
    let prev = clip.xy / clip.w;
    previousUV = vec2f(prev.x * 0.5 + 0.5, 0.5 - prev.y * 0.5);
  }
  if (any(previousUV < vec2f(0.0)) || any(previousUV > vec2f(1.0))) {
    return expand(center);
  }
  let mean = m1 / 9.0;
  let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec4f(0.0)));
  let past = clipToBox(compress(sampleHistory(previousUV, size)), mean, sigma * 1.25);
  return expand(mix(past, center, params.info.y));
}
