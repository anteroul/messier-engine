// Forward PBR shader (metallic-roughness, GGX) with N dynamic lights and
// PCF-filtered cascaded shadow maps for one directional light. Material textures follow
// glTF: base color and emissive are sRGB; normal, metallic-roughness (G, B) and
// occlusion (R) are linear. Meshes carry no tangents, so normal maps use a
// tangent frame built per pixel from screen-space derivatives of position and UV.

@group(0) @binding(1) var<storage, read> lights: array<Light>;
@group(0) @binding(2) var shadowMap: texture_depth_2d_array;
@group(0) @binding(3) var shadowSampler: sampler_comparison;

@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var baseColorTex: texture_2d<f32>;
@group(1) @binding(2) var baseSampler: sampler;
@group(1) @binding(3) var normalTex: texture_2d<f32>;
@group(1) @binding(4) var metallicRoughnessTex: texture_2d<f32>;
@group(1) @binding(5) var occlusionTex: texture_2d<f32>;
@group(1) @binding(6) var emissiveTex: texture_2d<f32>;

// One entry per instance; a batch's instances are consecutive, starting at the draw's first instance.
@group(2) @binding(0) var<storage, read> objects: array<Object>;

struct VSIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

@vertex
fn vs_main(in: VSIn, @builtin(instance_index) instance: u32) -> VSOut {
  var out: VSOut;
  let object = objects[instance];
  let world = object.model * vec4f(in.position, 1.0);
  out.worldPos = world.xyz;
  out.normal = (object.normal * vec4f(in.normal, 0.0)).xyz;
  out.uv = in.uv;
  out.clip = frame.viewProj * world;
  return out;
}

fn distributionGGX(NdotH: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = r * r / 8.0;
  let gv = NdotV / (NdotV * (1.0 - k) + k);
  let gl = NdotL / (NdotL * (1.0 - k) + k);
  return gv * gl;
}

fn fresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
  return F0 + (vec3f(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// PCF over a 3×3 texel area of cascade `c`; 1 where the point is outside it.
fn cascadeShadow(c: i32, worldPos: vec3f, N: vec3f, NdotL: f32) -> f32 {
  // Normal offset (in texels of this cascade, which grow with distance) reduces acne at grazing angles.
  let offsetPos = worldPos + N * frame.cascadeTexel[c] * (1.3 + 2.6 * (1.0 - NdotL));
  let lp = frame.cascades[c] * vec4f(offsetPos, 1.0);
  let ndc = lp.xyz / lp.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, -ndc.y * 0.5 + 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || ndc.z > 1.0) {
    return 1.0;
  }
  let depth = ndc.z - frame.cascadeBias[c];
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2f(f32(x), f32(y)) * frame.shadowTexel;
      sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, c, depth);
    }
  }
  return sum / 9.0;
}

// Picks the cascade by view depth. Over the last tenth of a cascade it blends into the next one, so the change in
// sharpness has no visible seam, and the last one fades out toward the shadow distance.
fn shadowFactor(worldPos: vec3f, N: vec3f, L: vec3f) -> f32 {
  let count = i32(frame.cameraForward.w);
  let z = dot(worldPos - frame.cameraPos.xyz, frame.cameraForward.xyz);
  var c = 0;
  while (c < count - 1 && z > frame.cascadeFar[c]) {
    c++;
  }
  if (count == 0 || z > frame.cascadeFar[c]) {
    return 1.0;
  }
  let far = frame.cascadeFar[c];
  let NdotL = clamp(dot(N, L), 0.0, 1.0);
  let s = cascadeShadow(c, worldPos, N, NdotL);
  let start = select(0.0, frame.cascadeFar[max(c - 1, 0)], c > 0);
  let band = (far - start) * 0.1;
  let t = smoothstep(far - band, far, z);
  if (t <= 0.0) {
    return s;
  }
  var next = 1.0;
  if (c + 1 < count) {
    next = cascadeShadow(c + 1, worldPos, N, NdotL);
  }
  return mix(s, next, t);
}

// Applies a tangent-space normal `n` to N. dp* and duv* are the screen-space derivatives of the world position and the
// UV (Schüler's cotangent frame), so mirrored and rotated UV islands work without stored tangents.
fn perturbNormal(N: vec3f, dp1: vec3f, dp2: vec3f, duv1: vec2f, duv2: vec2f, n: vec3f) -> vec3f {
  let dp2perp = cross(dp2, N);
  let dp1perp = cross(N, dp1);
  // The surface gradients of u and v, times the determinant below (whose sign is restored).
  let T = dp2perp * duv1.x + dp1perp * duv2.x;
  let B = dp2perp * duv1.y + dp1perp * duv2.y;
  let len2 = max(dot(T, T), dot(B, B));
  if (len2 < 1e-30) {
    // The UVs don't vary here: there is no tangent frame.
    return N;
  }
  let s = select(-1.0, 1.0, dot(cross(dp1, dp2), N) >= 0.0) * inverseSqrt(len2);
  // Image rows run down (v grows downwards), so the map's +Y points along -v.
  return normalize(T * (s * n.x) - B * (s * n.y) + N * n.z);
}

@fragment
fn fs_main(in: VSOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  // Samples and derivatives need uniform control flow, so they all come before any branch.
  let tex = textureSample(baseColorTex, baseSampler, in.uv);
  let normalSample = textureSample(normalTex, baseSampler, in.uv).xyz;
  let mr = textureSample(metallicRoughnessTex, baseSampler, in.uv);
  let ao = textureSample(occlusionTex, baseSampler, in.uv).r;
  let emissiveSample = textureSample(emissiveTex, baseSampler, in.uv).rgb;
  let dp1 = dpdx(in.worldPos);
  let dp2 = dpdy(in.worldPos);
  let duv1 = dpdx(in.uv);
  let duv2 = dpdy(in.uv);

  let base = material.baseColor * tex;
  if (material.params.z > 0.0 && base.a < material.params.z) {
    discard;
  }
  let emissive = material.emissive.rgb * emissiveSample;
  // Opaque surfaces cover the pixel; blended ones hand their opacity to the blend state.
  let alpha = mix(1.0, base.a, material.maps.z);
  if (material.params.y > 0.5) {
    return vec4f(base.rgb + emissive, alpha);
  }

  var N = normalize(in.normal);
  if (!frontFacing) {
    N = -N;
  }
  if (material.params.w > 0.5) {
    let n = (normalSample * 2.0 - 1.0) * vec3f(material.maps.x, material.maps.x, 1.0);
    N = perturbNormal(N, dp1, dp2, duv1, duv2, normalize(n));
  }
  let V = normalize(frame.cameraPos.xyz - in.worldPos);
  let metallic = clamp(material.emissive.w * mr.b, 0.0, 1.0);
  let roughness = clamp(material.params.x * mr.g, 0.04, 1.0);
  let occlusion = mix(1.0, ao, material.maps.y);
  let F0 = mix(vec3f(0.04), base.rgb, metallic);
  let NdotV = max(dot(N, V), 1e-4);

  var Lo = vec3f(0.0);
  let count = min(frame.lightCount, arrayLength(&lights));
  for (var i = 0u; i < count; i++) {
    let light = lights[i];
    let kind = light.position.w;
    var L: vec3f;
    var radiance = light.color.rgb * light.color.a;
    if (kind < 0.5) {
      L = normalize(-light.direction.xyz);
    } else {
      let toLight = light.position.xyz - in.worldPos;
      let dist = length(toLight);
      L = toLight / max(dist, 1e-4);
      let range = max(light.direction.w, 1e-3);
      let falloff = clamp(1.0 - pow(dist / range, 4.0), 0.0, 1.0);
      radiance *= falloff * falloff / (dist * dist + 1.0);
      if (kind > 1.5) {
        let cd = dot(-L, normalize(light.direction.xyz));
        radiance *= smoothstep(light.params.y, light.params.x, cd);
      }
    }
    let NdotL = dot(N, L);
    if (NdotL <= 0.0) {
      continue;
    }
    if (i32(i) == frame.shadowIndex) {
      radiance *= shadowFactor(in.worldPos, N, L);
    }
    let H = normalize(V + L);
    let NdotH = max(dot(N, H), 0.0);
    let HdotV = max(dot(H, V), 0.0);
    let D = distributionGGX(NdotH, roughness * roughness);
    let G = geometrySmith(NdotV, NdotL, roughness);
    let F = fresnelSchlick(HdotV, F0);
    let specular = D * G * F / (4.0 * NdotV * NdotL + 1e-4);
    let kd = (vec3f(1.0) - F) * (1.0 - metallic);
    Lo += (kd * base.rgb / PI + specular) * radiance * NdotL;
  }

  let Fa = F0 + (max(vec3f(1.0 - roughness), F0) - F0) * pow(1.0 - NdotV, 5.0);
  let R = reflect(-V, N);
  var ambientDiffuse: vec3f;
  var ambientSpecular: vec3f;
  if (frame.sky.x > 0.5) {
    // The sky lights the scene: diffuse from a very blurred sky around the normal, specular from the sky in the
    // reflected direction, blurred by roughness.
    let strength = frame.sky.y;
    ambientDiffuse = skyRadiance(N, 0.85) * strength * base.rgb * (vec3f(1.0) - Fa) * (1.0 - metallic);
    ambientSpecular = skyRadiance(R, roughness) * strength * Fa;
  } else {
    // Hemispheric ambient diffuse: brighter from above.
    let hemi = mix(0.55, 1.0, N.y * 0.5 + 0.5);
    ambientDiffuse = frame.ambient.rgb * hemi * base.rgb * (vec3f(1.0) - Fa) * (1.0 - metallic);
    // Cheap environment specular: reflect into a sky/ground gradient so metals
    // aren't black without image-based lighting. Rough surfaces see a blurrier,
    // dimmer environment.
    let sky = mix(vec3f(0.18, 0.17, 0.16), vec3f(1.6, 1.7, 1.9), smoothstep(-0.3, 0.7, R.y));
    let env = mix(sky, vec3f(0.8), roughness * roughness);
    ambientSpecular = frame.ambient.rgb * env * Fa * (1.0 - 0.6 * roughness) * 2.5;
  }
  let color = Lo + (ambientDiffuse + ambientSpecular) * occlusion + emissive;
  return vec4f(color, alpha);
}
