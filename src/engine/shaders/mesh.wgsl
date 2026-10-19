// Forward PBR shader (metallic-roughness, GGX) with N dynamic lights and a
// PCF-filtered shadow map for one directional light.

struct Material {
  baseColor: vec4f,
  // rgb = emissive (linear, pre-multiplied by strength), w = metallic
  emissive: vec4f,
  // x = roughness, y = unlit flag, z = alpha cutoff
  params: vec4f,
};

struct Object {
  model: mat4x4f,
  normal: mat4x4f,
};

@group(0) @binding(1) var<storage, read> lights: array<Light>;
@group(0) @binding(2) var shadowMap: texture_depth_2d;
@group(0) @binding(3) var shadowSampler: sampler_comparison;

@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var baseColorTex: texture_2d<f32>;
@group(1) @binding(2) var baseSampler: sampler;

@group(2) @binding(0) var<uniform> object: Object;

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
fn vs_main(in: VSIn) -> VSOut {
  var out: VSOut;
  let world = object.model * vec4f(in.position, 1.0);
  out.worldPos = world.xyz;
  out.normal = (object.normal * vec4f(in.normal, 0.0)).xyz;
  out.uv = in.uv;
  out.clip = frame.viewProj * world;
  return out;
}

const PI = 3.14159265359;

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

fn acesTonemap(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn toDisplay(color: vec3f) -> vec3f {
  return pow(acesTonemap(color * frame.ambient.w), vec3f(1.0 / 2.2));
}

fn shadowFactor(worldPos: vec3f, N: vec3f, L: vec3f) -> f32 {
  let NdotL = clamp(dot(N, L), 0.0, 1.0);
  // Normal offset reduces acne on surfaces at grazing angles.
  let offsetPos = worldPos + N * (0.02 + 0.04 * (1.0 - NdotL));
  let lp = frame.lightViewProj * vec4f(offsetPos, 1.0);
  let ndc = lp.xyz / lp.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, -ndc.y * 0.5 + 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || ndc.z > 1.0) {
    return 1.0;
  }
  let depth = ndc.z - 0.0008;
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2f(f32(x), f32(y)) * frame.shadowTexel;
      sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, depth);
    }
  }
  return sum / 9.0;
}

@fragment
fn fs_main(in: VSOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let tex = textureSample(baseColorTex, baseSampler, in.uv);
  let base = material.baseColor * tex;
  if (material.params.z > 0.0 && base.a < material.params.z) {
    discard;
  }
  if (material.params.y > 0.5) {
    return vec4f(toDisplay(base.rgb + material.emissive.rgb), 1.0);
  }

  var N = normalize(in.normal);
  if (!frontFacing) {
    N = -N;
  }
  let V = normalize(frame.cameraPos.xyz - in.worldPos);
  let metallic = clamp(material.emissive.w, 0.0, 1.0);
  let roughness = clamp(material.params.x, 0.04, 1.0);
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

  // Hemispheric ambient diffuse: brighter from above.
  let hemi = mix(0.55, 1.0, N.y * 0.5 + 0.5);
  let Fa = F0 + (max(vec3f(1.0 - roughness), F0) - F0) * pow(1.0 - NdotV, 5.0);
  let ambientDiffuse = frame.ambient.rgb * hemi * base.rgb * (vec3f(1.0) - Fa) * (1.0 - metallic);
  // Cheap environment specular: reflect into a sky/ground gradient so metals
  // aren't black without image-based lighting. Rough surfaces see a blurrier,
  // dimmer environment.
  let R = reflect(-V, N);
  let sky = mix(vec3f(0.18, 0.17, 0.16), vec3f(1.6, 1.7, 1.9), smoothstep(-0.3, 0.7, R.y));
  let env = mix(sky, vec3f(0.8), roughness * roughness);
  let ambientSpecular = frame.ambient.rgb * env * Fa * (1.0 - 0.6 * roughness) * 2.5;
  let color = Lo + ambientDiffuse + ambientSpecular + material.emissive.rgb;
  return vec4f(toDisplay(color), 1.0);
}
