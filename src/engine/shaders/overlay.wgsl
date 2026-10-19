// Unlit colored triangles for editor helpers (gizmos, light icons, bounds).

struct VSIn {
  @location(0) position: vec3f,
  @location(1) color: vec4f,
};

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
  var out: VSOut;
  out.clip = frame.viewProj * vec4f(in.position, 1.0);
  out.color = in.color;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return in.color;
}
