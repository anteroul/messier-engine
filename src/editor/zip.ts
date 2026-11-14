// Minimal ZIP writer (no dependencies): deflated entries where the platform has CompressionStream('deflate-raw'),
// stored ones otherwise or when deflate doesn't help. No ZIP64, so entries and the archive stay under 4 GiB.

export interface ZipEntry {
  /** Path inside the archive, with `/` separators. */
  name: string;
  data: Uint8Array<ArrayBuffer> | string;
}

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800;

export async function createZip(entries: ZipEntry[], date = new Date()): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = Math.max(0, ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const deflated = await deflateRaw(raw);
    const useDeflate = deflated !== null && deflated.byteLength < raw.byteLength;
    const body = useDeflate ? deflated : raw;
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed: 2.0
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, useDeflate ? METHOD_DEFLATE : METHOD_STORE, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.byteLength, true);
    lv.setUint32(22, raw.byteLength, true);
    lv.setUint16(26, name.byteLength, true);
    local.set(name, 30);

    const dir = new Uint8Array(46 + name.byteLength);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true); // made by: 2.0 (MS-DOS attributes)
    dir.set(local.subarray(4, 30), 6); // version needed … name length: same as the local header
    // extra length, comment length, disk number, internal attributes, external attributes: 0
    dv.setUint32(42, offset, true);
    dir.set(name, 46);

    parts.push(local, body);
    central.push(dir);
    offset += local.byteLength + body.byteLength;
  }

  const dirSize = central.reduce((n, d) => n + d.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + dirSize + end.byteLength);
  let at = 0;
  for (const p of [...parts, ...central, end]) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function deflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null; // 'deflate-raw' is missing in some older browsers
  }
}

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
