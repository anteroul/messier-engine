// Generates public/models/material-lab.glb, the model the Material Lab example project is built from: two procedural
// texture sets with every map glTF has (base color, normal, metallic-roughness, occlusion, emissive), the materials
// that use them and a cube, a UV sphere and a panel to put them on. Run with: npm run generate:materials-glb
//
// - "Tiles": ceramic tiles with a brass stud each, set in grout that glows. The five "Stage" materials add its maps
//   one at a time, so the example can show what each one contributes.
// - "Hull": riveted steel plates with brushed metal, hazard stripes and glowing circuit traces.
//
// Normal maps come from height fields (in pixels) and follow glTF: +Y points up the image.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlbBuilder, box, png } from './glb.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'material-lab.glb');
const SIZE = 256;

/** Deterministic value in 0…1 for integer coordinates. */
function hash(...v) {
  let h = 2166136261;
  for (const x of v) h = Math.imul(h ^ (x | 0), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const byte = (v) => Math.round(clamp01(v) * 255);
/** Distance from p to the segment a–b. */
function segment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/**
 * Samples `texel(x, y)` (pixel centres) into a texture set: `height` in pixels and linear `base` (sRGB-encoded on
 * write), `occlusion`, `roughness`, `metallic` and `emissive`.
 */
function textureSet(texel) {
  const t = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) t.push(texel(x + 0.5, y + 0.5));
  const at = (x, y) => t[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)];
  const srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  return {
    base: png(SIZE, SIZE, (x, y) => [...at(x, y).base.map((c) => byte(srgb(c))), 255]),
    normal: png(SIZE, SIZE, (x, y) => {
      const dx = (at(x + 1, y).height - at(x - 1, y).height) / 2;
      const dy = (at(x, y + 1).height - at(x, y - 1).height) / 2;
      // Rows run down the image, so up is −row: n = (−∂h/∂x, +∂h/∂row, 1).
      const len = Math.hypot(dx, dy, 1);
      return [byte((-dx / len) * 0.5 + 0.5), byte((dy / len) * 0.5 + 0.5), byte((1 / len) * 0.5 + 0.5), 255];
    }),
    orm: png(SIZE, SIZE, (x, y) => {
      const p = at(x, y);
      return [byte(p.occlusion), byte(p.roughness), byte(p.metallic), 255];
    }),
    emissive: png(SIZE, SIZE, (x, y) => [...at(x, y).emissive.map((c) => byte(srgb(c))), 255]),
  };
}

// --- Tiles: 4 × 4 per image -------------------------------------------------
const TILE = SIZE / 4;
const tiles = textureSet((x, y) => {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  const lx = x - tx * TILE, ly = y - ty * TILE;
  const edge = Math.min(lx, TILE - lx, ly, TILE - ly);
  const r = Math.hypot(lx - TILE / 2, ly - TILE / 2);
  const STUD = 15;
  if (edge < 3) {
    return { height: 0, base: [0.02, 0.02, 0.025], occlusion: 0.25, roughness: 0.95, metallic: 0, emissive: [0.02, 0.6, 1] };
  }
  const bevel = smooth(3, 9, edge);
  const tint = 0.9 + 0.1 * hash(tx, ty);
  if (r < STUD) {
    const dome = Math.sqrt(STUD * STUD - r * r) * 0.55;
    return { height: 3 + dome, base: [0.85, 0.55, 0.2], occlusion: 1, roughness: 0.22, metallic: 1, emissive: [0, 0, 0] };
  }
  // Grime gathers where the stud meets the tile.
  const crease = smooth(STUD, STUD + 6, r);
  return {
    height: 3 * bevel,
    base: [0.62 * tint, 0.56 * tint, 0.45 * tint],
    occlusion: Math.min(0.45 + 0.55 * crease, 0.55 + 0.45 * bevel),
    roughness: 0.42 + 0.08 * hash(Math.floor(x / 4), Math.floor(y / 4)),
    metallic: 0,
    emissive: [0, 0, 0],
  };
});

// --- Hull: 2 × 2 plates per image -------------------------------------------
const PLATE = SIZE / 2;
const hull = textureSet((x, y) => {
  const tx = Math.floor(x / PLATE), ty = Math.floor(y / PLATE);
  const lx = x - tx * PLATE, ly = y - ty * PLATE;
  const edge = Math.min(lx, PLATE - lx, ly, PLATE - ly);
  if (edge < 2) return { height: 0, base: [0.01, 0.01, 0.012], occlusion: 0.2, roughness: 0.9, metallic: 0, emissive: [0, 0, 0] };
  const bevel = smooth(2, 5, edge);
  const plateHeight = 2.5 * bevel;

  // Rivets in a row along each edge.
  const INSET = 9;
  const along = (v) => Math.abs(((v - 8) % 16 + 16) % 16 - 8);
  let rivet = Infinity;
  if (Math.abs(lx - INSET) < 6 || Math.abs(lx - (PLATE - INSET)) < 6) rivet = Math.hypot(Math.min(Math.abs(lx - INSET), Math.abs(lx - (PLATE - INSET))), along(ly));
  if (Math.abs(ly - INSET) < 6 || Math.abs(ly - (PLATE - INSET)) < 6) rivet = Math.min(rivet, Math.hypot(Math.min(Math.abs(ly - INSET), Math.abs(ly - (PLATE - INSET))), along(lx)));
  if (rivet < 3.6) {
    return { height: plateHeight + Math.sqrt(3.6 * 3.6 - rivet * rivet) * 0.5, base: [0.5, 0.5, 0.52], occlusion: 1, roughness: 0.25, metallic: 1, emissive: [0, 0, 0] };
  }

  // Circuit traces, recessed and glowing, on two of the plates.
  if ((tx + ty) % 2 === 0) {
    const mirror = tx === 1;
    const X = (v) => (mirror ? PLATE - v : v);
    const d = Math.min(
      segment(lx, ly, X(24), 36, X(88), 36),
      segment(lx, ly, X(88), 36, X(104), 52),
      segment(lx, ly, X(104), 52, X(104), 100),
      segment(lx, ly, X(24), 60, X(64), 60),
      segment(lx, ly, X(64), 60, X(64), 96),
    );
    const pads = [[24, 36], [24, 60], [64, 96], [104, 100]].map(([px, py]) => Math.hypot(lx - X(px), ly - py));
    const pad = Math.min(...pads);
    if (d < 2.2 || pad < 5) {
      return { height: plateHeight - 1.5, base: [0.02, 0.02, 0.02], occlusion: 0.55, roughness: 0.6, metallic: 0, emissive: [1, 0.32, 0.05] };
    }
  }

  // Brushed steel: streaks along the rows. The other two plates carry a band of hazard stripes.
  const streak = hash(y, Math.floor(x / 23)) * 0.6 + hash(y, 7) * 0.4;
  const stripes = (tx + ty) % 2 === 1 && ly > 96 && ly < 114;
  if (stripes) {
    const orange = Math.floor((lx + ly) / 10) % 2 === 0;
    return { height: plateHeight, base: orange ? [0.8, 0.22, 0.02] : [0.015, 0.015, 0.015], occlusion: 0.6 + 0.4 * bevel, roughness: 0.65, metallic: 0, emissive: [0, 0, 0] };
  }
  const occlusion = Math.min(0.55 + 0.45 * bevel, rivet < 6 ? 0.75 + 0.25 * smooth(3.6, 6, rivet) : 1);
  return { height: plateHeight, base: [0.42, 0.44, 0.47], occlusion, roughness: 0.28 + 0.16 * streak, metallic: 1, emissive: [0, 0, 0] };
});

// --- Geometry ---------------------------------------------------------------
/** UV sphere; the texture repeats `ru` times around and `rv` times from pole to pole. Faces +Z at u = 0. */
function sphere(radius, segments, rings, ru, rv) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let i = 0; i <= rings; i++) {
    const theta = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const phi = (j / segments) * Math.PI * 2;
      const n = [Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi)];
      positions.push(...n.map((c) => c * radius));
      normals.push(...n);
      uvs.push((j / segments) * ru, (i / rings) * rv);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j, b = a + segments + 1;
      // a: top left, b: below it; counter-clockwise from outside.
      if (i > 0) indices.push(a, b, a + 1);
      if (i < rings - 1) indices.push(a + 1, b, b + 1);
    }
  }
  return { positions, normals, uvs, indices };
}

/** A 1 × 1 quad facing +Z. */
function panel() {
  return {
    positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

// --- Assembly ---------------------------------------------------------------
const glb = new GlbBuilder();
const images = [];
const addImage = (name, bytes) => {
  images.push({ name, bufferView: glb.addView(bytes), mimeType: 'image/png' });
  return images.length - 1;
};
const T = {
  tilesBase: addImage('tiles-base.png', tiles.base),
  tilesNormal: addImage('tiles-normal.png', tiles.normal),
  tilesOrm: addImage('tiles-orm.png', tiles.orm),
  tilesGlow: addImage('tiles-emissive.png', tiles.emissive),
  hullBase: addImage('hull-base.png', hull.base),
  hullNormal: addImage('hull-normal.png', hull.normal),
  hullOrm: addImage('hull-orm.png', hull.orm),
  hullGlow: addImage('hull-emissive.png', hull.emissive),
};

// The build-up: each stage adds one map to the one before.
const stages = [
  { name: 'Stage 1 Base Color', maps: [] },
  { name: 'Stage 2 Normal', maps: ['normal'] },
  { name: 'Stage 3 Metal Rough', maps: ['normal', 'mr'] },
  { name: 'Stage 4 Occlusion', maps: ['normal', 'mr', 'occlusion'] },
  { name: 'Stage 5 Emissive', maps: ['normal', 'mr', 'occlusion', 'emissive'] },
];
const tileMaterial = ({ name, maps }) => {
  const m = {
    name,
    pbrMetallicRoughness: { baseColorTexture: { index: T.tilesBase }, metallicFactor: 0, roughnessFactor: 0.45 },
  };
  if (maps.includes('normal')) m.normalTexture = { index: T.tilesNormal, scale: 1 };
  if (maps.includes('mr')) Object.assign(m.pbrMetallicRoughness, { metallicRoughnessTexture: { index: T.tilesOrm }, metallicFactor: 1, roughnessFactor: 1 });
  if (maps.includes('occlusion')) m.occlusionTexture = { index: T.tilesOrm, strength: 1 };
  if (maps.includes('emissive')) {
    m.emissiveTexture = { index: T.tilesGlow };
    m.emissiveFactor = [1, 1, 1];
    m.extensions = { KHR_materials_emissive_strength: { emissiveStrength: 2 } };
  }
  return m;
};
const materials = [
  ...stages.map(tileMaterial),
  {
    name: 'Hull Plating',
    pbrMetallicRoughness: { baseColorTexture: { index: T.hullBase }, metallicRoughnessTexture: { index: T.hullOrm }, metallicFactor: 1, roughnessFactor: 1 },
    normalTexture: { index: T.hullNormal, scale: 1 },
    occlusionTexture: { index: T.hullOrm, strength: 1 },
    emissiveTexture: { index: T.hullGlow },
    emissiveFactor: [1, 1, 1],
    extensions: { KHR_materials_emissive_strength: { emissiveStrength: 2.5 } },
  },
];
const HULL = materials.length - 1;

// Every material is on a node, so loading the model loads (and tags) all of its textures.
const meshes = [
  ...stages.map((s, i) => glb.addMesh(`Cube ${i + 1}`, box(1, 1, 1), i)),
  glb.addMesh('Sphere', sphere(0.5, 64, 32, 4, 2), HULL),
  glb.addMesh('Panel', panel(), HULL),
];
const nodes = [
  { name: 'Material Lab', children: meshes.map((_, i) => i + 1) },
  ...stages.map((s, i) => ({ name: s.name, mesh: i, translation: [i * 1.5, 0, 0] })),
  { name: 'Sphere', mesh: stages.length, translation: [0, 1.5, 0] },
  { name: 'Panel', mesh: stages.length + 1, translation: [1.5, 1.5, 0] },
];

const gltf = {
  asset: { version: '2.0', generator: 'messier-engine material lab generator' },
  extensionsUsed: ['KHR_materials_emissive_strength'],
  scene: 0,
  scenes: [{ name: 'Material Lab', nodes: [0] }],
  nodes,
  meshes,
  materials,
  textures: images.map((_, i) => ({ source: i, sampler: 0 })),
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
  images,
};
const size = glb.write(out, gltf);
console.log(`Wrote ${out} (${size} bytes)`);
