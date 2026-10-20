// Generates public/models/lantern.glb: a small glTF 2.0 binary asset exercising
// the loader (node hierarchy, embedded PNG texture, emissive material and a
// KHR_lights_punctual point light). Run with: npm run generate:sample
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'lantern.glb');

// --- PNG encoder (RGBA8, no interlace) --------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Geometry ---------------------------------------------------------------
function box(sx, sy, sz) {
  const faces = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const h = [sx / 2, sy / 2, sz / 2];
  const positions = [], normals = [], uvs = [], indices = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) positions.push((f.n[k] + f.u[k] * a + f.v[k] * b) * h[k]);
      normals.push(...f.n);
      uvs.push((a + 1) / 2, 1 - (b + 1) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, uvs, indices };
}

// --- Buffer assembly --------------------------------------------------------
const chunks = [];
let byteLength = 0;
const bufferViews = [];
const accessors = [];
function addView(buf, target) {
  const pad = (4 - (byteLength % 4)) % 4;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    byteLength += pad;
  }
  const view = { buffer: 0, byteOffset: byteLength, byteLength: buf.length };
  if (target) view.target = target;
  bufferViews.push(view);
  chunks.push(buf);
  byteLength += buf.length;
  return bufferViews.length - 1;
}
function addAccessor(data, type, componentType, withBounds = false) {
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
  const buf = componentType === 5126 ? Buffer.from(new Float32Array(data).buffer) : Buffer.from(new Uint16Array(data).buffer);
  const acc = { bufferView: addView(buf, componentType === 5126 ? 34962 : 34963), componentType, count: data.length / comps, type };
  if (withBounds) {
    acc.min = Array.from({ length: comps }, (_, k) => Math.min(...data.filter((_, i) => i % comps === k)));
    acc.max = Array.from({ length: comps }, (_, k) => Math.max(...data.filter((_, i) => i % comps === k)));
  }
  accessors.push(acc);
  return accessors.length - 1;
}
function addMesh(name, geo, material) {
  return {
    name,
    primitives: [
      {
        attributes: {
          POSITION: addAccessor(geo.positions, 'VEC3', 5126, true),
          NORMAL: addAccessor(geo.normals, 'VEC3', 5126),
          TEXCOORD_0: addAccessor(geo.uvs, 'VEC2', 5126),
        },
        indices: addAccessor(geo.indices, 'SCALAR', 5123),
        material,
      },
    ],
  };
}

const checker = png(64, 64, (x, y) => {
  const on = ((x >> 3) + (y >> 3)) % 2 === 0;
  return on ? [200, 196, 188, 255] : [90, 88, 84, 255];
});
const imageView = addView(checker);

const meshes = [
  addMesh('LanternBase', box(0.8, 0.25, 0.8), 0),
  addMesh('LanternPole', box(0.12, 2.2, 0.12), 1),
  addMesh('LanternCap', box(0.55, 0.08, 0.55), 1),
  addMesh('LanternGlass', box(0.36, 0.4, 0.36), 2),
];

const gltf = {
  asset: { version: '2.0', generator: 'messier-engine sample generator' },
  extensionsUsed: ['KHR_lights_punctual', 'KHR_materials_emissive_strength'],
  extensions: { KHR_lights_punctual: { lights: [{ name: 'LanternLight', type: 'point', color: [1, 0.72, 0.4], intensity: 6, range: 6 }] } },
  scene: 0,
  scenes: [{ name: 'Lantern', nodes: [0] }],
  nodes: [
    { name: 'Lantern', children: [1, 2] },
    { name: 'Base', mesh: 0, translation: [0, 0.125, 0] },
    { name: 'Pole', mesh: 1, translation: [0, 1.35, 0], children: [3] },
    { name: 'Head', translation: [0, 1.25, 0], rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)], children: [4, 5, 6] },
    { name: 'Glass', mesh: 3, translation: [0, 0, 0] },
    { name: 'Cap', mesh: 2, translation: [0, 0.24, 0] },
    { name: 'Light', translation: [0, 0, 0], extensions: { KHR_lights_punctual: { light: 0 } } },
  ],
  meshes,
  materials: [
    { name: 'Stone', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.85 } },
    { name: 'Iron', pbrMetallicRoughness: { baseColorFactor: [0.08, 0.08, 0.09, 1], metallicFactor: 0.9, roughnessFactor: 0.4 } },
    {
      name: 'Glow',
      pbrMetallicRoughness: { baseColorFactor: [1, 0.85, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.3 },
      emissiveFactor: [1, 0.62, 0.3],
      extensions: { KHR_materials_emissive_strength: { emissiveStrength: 3 } },
    },
  ],
  textures: [{ source: 0, sampler: 0 }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
  images: [{ name: 'checker.png', bufferView: imageView, mimeType: 'image/png' }],
  accessors,
  bufferViews,
  buffers: [{ byteLength }],
};

const bin = Buffer.concat(chunks);
const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binPadded.length, 8);
const chunkHeader = (len, type) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(len, 0);
  b.writeUInt32LE(type, 4);
  return b;
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, chunkHeader(jsonBuf.length, 0x4e4f534a), jsonBuf, chunkHeader(binPadded.length, 0x004e4942), binPadded]));
console.log(`Wrote ${out} (${12 + 16 + jsonBuf.length + binPadded.length} bytes)`);
