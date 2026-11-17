// Helpers for the scripts that generate sample glTF binaries (generate-sample-glb.mjs, generate-material-glb.mjs):
// an RGBA PNG encoder and a GLB writer that packs accessors and images into one binary chunk.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

/** Encodes a PNG; `pixel(x, y)` returns [r, g, b, a] bytes. */
export function png(width, height, pixel) {
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

// --- GLB writer -------------------------------------------------------------
/** Collects buffer views and accessors for one binary chunk; `write()` adds them to the glTF JSON. */
export class GlbBuilder {
  chunks = [];
  byteLength = 0;
  bufferViews = [];
  accessors = [];

  addView(buf, target) {
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) {
      this.chunks.push(Buffer.alloc(pad));
      this.byteLength += pad;
    }
    const view = { buffer: 0, byteOffset: this.byteLength, byteLength: buf.length };
    if (target) view.target = target;
    this.bufferViews.push(view);
    this.chunks.push(buf);
    this.byteLength += buf.length;
    return this.bufferViews.length - 1;
  }

  /** Float (5126) or unsigned short/int index (5123/5125) data. */
  addAccessor(data, type, componentType, withBounds = false) {
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
    const typed = componentType === 5126 ? new Float32Array(data) : componentType === 5125 ? new Uint32Array(data) : new Uint16Array(data);
    const buf = Buffer.from(typed.buffer);
    const acc = { bufferView: this.addView(buf, componentType === 5126 ? 34962 : 34963), componentType, count: data.length / comps, type };
    if (withBounds) {
      acc.min = Array.from({ length: comps }, (_, k) => Math.min(...data.filter((_, i) => i % comps === k)));
      acc.max = Array.from({ length: comps }, (_, k) => Math.max(...data.filter((_, i) => i % comps === k)));
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  /** A one-primitive mesh from { positions, normals, uvs, indices }. */
  addMesh(name, geo, material) {
    const indexType = geo.positions.length / 3 > 65535 ? 5125 : 5123;
    return {
      name,
      primitives: [
        {
          attributes: {
            POSITION: this.addAccessor(geo.positions, 'VEC3', 5126, true),
            NORMAL: this.addAccessor(geo.normals, 'VEC3', 5126),
            TEXCOORD_0: this.addAccessor(geo.uvs, 'VEC2', 5126),
          },
          indices: this.addAccessor(geo.indices, 'SCALAR', indexType),
          material,
        },
      ],
    };
  }

  /** Writes `gltf` (accessors, bufferViews and buffers filled in) with the binary chunk to `out`. Returns the size. */
  write(out, gltf) {
    gltf.accessors = this.accessors;
    gltf.bufferViews = this.bufferViews;
    gltf.buffers = [{ byteLength: this.byteLength }];
    const bin = Buffer.concat(this.chunks);
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
    return 12 + 16 + jsonBuf.length + binPadded.length;
  }
}

// --- Geometry ---------------------------------------------------------------
/** A box centred on the origin; each face maps the whole texture, upright (v = 0 at the top). */
export function box(sx, sy, sz) {
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
