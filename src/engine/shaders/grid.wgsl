// Editor ground grid on the XZ plane, following the camera, with anti-aliased
// lines (fwidth) and distance fade. X axis is red, Z axis is blue.

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPos: vec3f,
};

const GRID_HALF_SIZE = 250.0;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  let c = corners[vi] * GRID_HALF_SIZE;
  let center = floor(frame.cameraPos.xz / 10.0) * 10.0;
  let p = vec3f(c.x + center.x, 0.002, c.y + center.y);
  var out: VSOut;
  out.worldPos = p;
  out.clip = frame.viewProj * vec4f(p, 1.0);
  return out;
}

fn gridLine(coord: vec2f, spacing: f32) -> f32 {
  let c = coord / spacing;
  let d = fwidth(c);
  let g = abs(fract(c - 0.5) - 0.5) / max(d, vec2f(1e-5));
  return 1.0 - min(min(g.x, g.y), 1.0);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let coord = in.worldPos.xz;
  let minor = gridLine(coord, 1.0);
  let major = gridLine(coord, 10.0);
  let fw = fwidth(coord);
  let dist = distance(in.worldPos, frame.cameraPos.xyz);
  let fade = 1.0 - smoothstep(20.0, 120.0, dist);

  var color = vec3f(0.42, 0.44, 0.48);
  var alpha = max(minor * 0.22, major * 0.45);
  let xAxis = 1.0 - min(abs(coord.y) / max(fw.y * 1.5, 1e-5), 1.0);
  let zAxis = 1.0 - min(abs(coord.x) / max(fw.x * 1.5, 1e-5), 1.0);
  if (xAxis > 0.0) {
    color = mix(color, vec3f(0.9, 0.25, 0.25), xAxis);
    alpha = max(alpha, xAxis * 0.85);
  }
  if (zAxis > 0.0) {
    color = mix(color, vec3f(0.25, 0.45, 0.95), zAxis);
    alpha = max(alpha, zAxis * 0.85);
  }
  return vec4f(color, alpha * fade);
}
