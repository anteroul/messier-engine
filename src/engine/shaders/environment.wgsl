// Filters the captured environment for image-based lighting (the split-sum approximation). cube.wgsl is prepended.
// Each entry point has its own bindings, all in group 0:
// - downsample: the environment cube's mips, each the average of the one above (prefiltering reads them).
// - prefilter: the specular cube, one roughness per mip, by GGX importance sampling of the environment.
// - irradiance: the diffuse cube, the cosine-weighted average of the environment around each direction.
// - brdfLut: the split-sum BRDF table, scale and bias to F0 by (N·V, roughness); made once.

const PI = 3.14159265359;

// ---- downsample

@group(0) @binding(0) var mipIn: texture_2d_array<f32>;
@group(0) @binding(1) var mipOut: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn downsample(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(mipOut).x;
  if (id.x >= size || id.y >= size) {
    return;
  }
  let p = vec2i(id.xy) * 2;
  let face = i32(id.z);
  let c = textureLoad(mipIn, p, face, 0) + textureLoad(mipIn, p + vec2i(1, 0), face, 0) +
    textureLoad(mipIn, p + vec2i(0, 1), face, 0) + textureLoad(mipIn, p + vec2i(1, 1), face, 0);
  textureStore(mipOut, vec2u(id.xy), id.z, c * 0.25);
}

// ---- GGX importance sampling

fn hammersley(i: u32, n: u32) -> vec2f {
  var bits = i;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return vec2f(f32(i) / f32(n), f32(bits) * 2.3283064365386963e-10);
}

// A half vector around N, distributed as GGX with alpha `a` (roughness squared).
fn sampleGGX(xi: vec2f, N: vec3f, a: f32) -> vec3f {
  let phi = 2.0 * PI * xi.x;
  let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(N.z) < 0.999);
  let T = normalize(cross(up, N));
  let B = cross(N, T);
  return normalize(T * (cos(phi) * sinTheta) + B * (sin(phi) * sinTheta) + N * cosTheta);
}

fn ggx(NdotH: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

// ---- prefilter

struct Filter {
  // x = roughness, y = samples, z = the environment's face size, w = its mip count
  params: vec4f,
};

@group(0) @binding(0) var envIn: texture_cube<f32>;
@group(0) @binding(1) var envSampler: sampler;
@group(0) @binding(2) var specOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> filterParams: Filter;

@compute @workgroup_size(8, 8, 1)
fn prefilter(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(specOut).x;
  if (id.x >= size || id.y >= size) {
    return;
  }
  // N = V = R: the usual split-sum assumption, which loses the stretched reflections of grazing angles.
  let N = texelDir(id, size);
  let roughness = filterParams.params.x;
  if (roughness <= 0.0) {
    textureStore(specOut, vec2u(id.xy), id.z, textureSampleLevel(envIn, envSampler, N, 0.0));
    return;
  }
  let a = roughness * roughness;
  let n = u32(filterParams.params.y);
  // Solid angle of one environment texel: each sample reads the mip whose texels are about as big as the solid angle
  // the sample stands for, so few samples don't sparkle.
  let texelAngle = 4.0 * PI / (6.0 * filterParams.params.z * filterParams.params.z);
  var sum = vec3f(0.0);
  var weight = 0.0;
  for (var i = 0u; i < n; i++) {
    let H = sampleGGX(hammersley(i, n), N, a);
    let L = normalize(2.0 * dot(N, H) * H - N);
    let NdotL = dot(N, L);
    if (NdotL <= 0.0) {
      continue;
    }
    let NdotH = max(dot(N, H), 0.0);
    // pdf of L = D · (N·H) / (4 · V·H), which is D / 4 with V = N.
    let pdf = ggx(NdotH, a) / 4.0 + 1e-4;
    let sampleAngle = 1.0 / (f32(n) * pdf);
    let level = clamp(0.5 * log2(sampleAngle / texelAngle) + 1.0, 0.0, filterParams.params.w - 1.0);
    sum += textureSampleLevel(envIn, envSampler, L, level).rgb * NdotL;
    weight += NdotL;
  }
  textureStore(specOut, vec2u(id.xy), id.z, vec4f(sum / max(weight, 1e-4), 1.0));
}

// ---- irradiance

@group(0) @binding(0) var irrIn: texture_cube<f32>;
@group(0) @binding(1) var irrSampler: sampler;
@group(0) @binding(2) var irrOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> irrFilter: Filter;

@compute @workgroup_size(8, 8, 1)
fn irradiance(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(irrOut).x;
  if (id.x >= size || id.y >= size) {
    return;
  }
  let N = texelDir(id, size);
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(N.y) < 0.999);
  let T = normalize(cross(up, N));
  let B = cross(N, T);
  // A grid over the hemisphere, weighted by cos θ · sin θ (the cosine, and the grid's solid angle), read from a small
  // mip: what's averaged is smooth anyway.
  let level = irrFilter.params.x;
  let steps = 32u;
  var sum = vec3f(0.0);
  var weight = 0.0;
  for (var i = 0u; i < steps * 2u; i++) {
    let phi = (f32(i) + 0.5) / f32(steps * 2u) * 2.0 * PI;
    for (var j = 0u; j < steps / 2u; j++) {
      let theta = (f32(j) + 0.5) / f32(steps / 2u) * 0.5 * PI;
      let d = T * (cos(phi) * sin(theta)) + B * (sin(phi) * sin(theta)) + N * cos(theta);
      let w = cos(theta) * sin(theta);
      sum += textureSampleLevel(irrIn, irrSampler, d, level).rgb * w;
      weight += w;
    }
  }
  // The cosine-weighted average radiance: times the albedo, it's the diffuse light.
  textureStore(irrOut, vec2u(id.xy), id.z, vec4f(sum / weight, 1.0));
}

// ---- BRDF table

@group(0) @binding(0) var lutOut: texture_storage_2d<rgba16float, write>;

fn smithG1(NdotX: f32, k: f32) -> f32 {
  return NdotX / (NdotX * (1.0 - k) + k);
}

@compute @workgroup_size(8, 8, 1)
fn brdfLut(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(lutOut);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let NdotV = max((f32(id.x) + 0.5) / f32(size.x), 1e-3);
  let roughness = (f32(id.y) + 0.5) / f32(size.y);
  let a = roughness * roughness;
  // IBL's Smith k (a / 2), not the analytic lights' remapped one.
  let k = a / 2.0;
  let V = vec3f(sqrt(1.0 - NdotV * NdotV), 0.0, NdotV);
  let N = vec3f(0.0, 0.0, 1.0);
  let n = 256u;
  var scale = 0.0;
  var bias = 0.0;
  for (var i = 0u; i < n; i++) {
    let H = sampleGGX(hammersley(i, n), N, a);
    let L = normalize(2.0 * dot(V, H) * H - V);
    let NdotL = max(L.z, 0.0);
    let NdotH = max(H.z, 0.0);
    let VdotH = max(dot(V, H), 0.0);
    if (NdotL > 0.0) {
      let G = smithG1(NdotV, k) * smithG1(NdotL, k);
      let visibility = G * VdotH / (NdotH * NdotV);
      let fc = pow(1.0 - VdotH, 5.0);
      scale += (1.0 - fc) * visibility;
      bias += fc * visibility;
    }
  }
  textureStore(lutOut, vec2u(id.xy), vec4f(scale / f32(n), bias / f32(n), 0.0, 1.0));
}
