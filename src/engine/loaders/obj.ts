import { GameObject } from '../scene';
import { Mesh, computeNormals } from '../mesh';
import { Material, Texture } from '../material';
import { mimeFromName, type ResourceResolver } from './resources';

// Wavefront OBJ + MTL loader. Supports v/vt/vn, polygon faces (fan
// triangulated), negative indices, o/g groups, usemtl, and the MTL keys
// Kd, Ke, Ns, d/Tr, map_Kd. Each (group, material) pair becomes one child mesh.

interface Group {
  name: string;
  material: string;
  verts: number[];
  indices: number[];
  lookup: Map<string, number>;
  hasNormals: boolean;
}

export async function loadOBJ(text: string, name: string, resolve: ResourceResolver): Promise<GameObject> {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const groups: Group[] = [];
  const mtlFiles: string[] = [];

  let objectName = name;
  let materialName = '';
  let current: Group | null = null;
  const startGroup = () => {
    current = { name: objectName, material: materialName, verts: [], indices: [], lookup: new Map(), hasNormals: true };
    groups.push(current);
    return current;
  };

  const lines = text.split(/\r?\n/);
  for (let raw of lines) {
    // Join continuation lines is rare; strip comments.
    const hash = raw.indexOf('#');
    if (hash >= 0) raw = raw.slice(0, hash);
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const key = parts[0];
    switch (key) {
      case 'v':
        positions.push(+parts[1], +parts[2], +parts[3]);
        break;
      case 'vt':
        uvs.push(+parts[1], 1 - +(parts[2] ?? 0));
        break;
      case 'vn':
        normals.push(+parts[1], +parts[2], +parts[3]);
        break;
      case 'o':
      case 'g':
        objectName = parts.slice(1).join(' ') || name;
        current = null;
        break;
      case 'usemtl':
        materialName = parts.slice(1).join(' ');
        current = null;
        break;
      case 'mtllib':
        mtlFiles.push(parts.slice(1).join(' '));
        break;
      case 'f': {
        const g: Group = current ?? startGroup();
        const corner = (token: string): number => {
          let idx = g.lookup.get(token);
          if (idx !== undefined) return idx;
          const [vs, vts, vns] = token.split('/');
          const resolveIndex = (s: string | undefined, count: number) => {
            if (!s) return -1;
            const i = parseInt(s, 10);
            return i < 0 ? count + i : i - 1;
          };
          const vi = resolveIndex(vs, positions.length / 3);
          const ti = resolveIndex(vts, uvs.length / 2);
          const ni = resolveIndex(vns, normals.length / 3);
          if (ni < 0) g.hasNormals = false;
          g.verts.push(
            positions[vi * 3] ?? 0, positions[vi * 3 + 1] ?? 0, positions[vi * 3 + 2] ?? 0,
            ni >= 0 ? normals[ni * 3] : 0, ni >= 0 ? normals[ni * 3 + 1] : 0, ni >= 0 ? normals[ni * 3 + 2] : 0,
            ti >= 0 ? uvs[ti * 2] : 0, ti >= 0 ? uvs[ti * 2 + 1] : 0,
          );
          idx = g.verts.length / 8 - 1;
          g.lookup.set(token, idx);
          return idx;
        };
        const ids = parts.slice(1).map(corner);
        for (let i = 1; i < ids.length - 1; i++) g.indices.push(ids[0], ids[i], ids[i + 1]);
        break;
      }
      default:
        break;
    }
  }

  const materials = new Map<string, Material>();
  for (const file of mtlFiles) {
    try {
      const mtlText = new TextDecoder().decode(await resolve(file));
      for (const [k, v] of await parseMTL(mtlText, resolve)) materials.set(k, v);
    } catch (err) {
      console.warn(`OBJ: could not load material library "${file}"`, err);
    }
  }

  const root = new GameObject(name);
  const used = groups.filter((g) => g.indices.length > 0);
  let fallback: Material | null = null;
  for (const g of used) {
    const count = g.verts.length / 8;
    const v = new Float32Array(g.verts);
    if (!g.hasNormals) {
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) pos.set(v.subarray(i * 8, i * 8 + 3), i * 3);
      const n = computeNormals(pos, g.indices);
      for (let i = 0; i < count; i++) v.set(n.subarray(i * 3, i * 3 + 3), i * 8 + 3);
    }
    const mesh = new Mesh(g.name, v, new Uint32Array(g.indices));
    const material = materials.get(g.material) ?? (fallback ??= new Material(`${name}_default`, { roughness: 0.6 }));
    if (used.length === 1) {
      root.mesh = mesh;
      root.material = material;
    } else {
      const ambiguous = used.filter((o) => o.name === g.name).length > 1;
      const child = new GameObject(ambiguous && g.material ? `${g.name} · ${g.material}` : g.name);
      child.mesh = mesh;
      child.material = material;
      root.add(child);
    }
  }
  if (used.length === 0) throw new Error('OBJ file contains no faces');
  return root;
}

async function parseMTL(text: string, resolve: ResourceResolver): Promise<Map<string, Material>> {
  const out = new Map<string, Material>();
  const pending: Promise<void>[] = [];
  let m: Material | null = null;
  for (let raw of text.split(/\r?\n/)) {
    const hash = raw.indexOf('#');
    if (hash >= 0) raw = raw.slice(0, hash);
    const parts = raw.trim().split(/\s+/);
    const key = parts[0]?.toLowerCase();
    if (!key) continue;
    if (key === 'newmtl') {
      m = new Material(parts.slice(1).join(' '), { roughness: 0.6 });
      out.set(m.name, m);
      continue;
    }
    if (!m) continue;
    const mat: Material = m;
    switch (key) {
      case 'kd':
        mat.baseColor = [+parts[1], +parts[2], +parts[3], mat.baseColor[3]];
        break;
      case 'ke':
        mat.emissive = [+parts[1], +parts[2], +parts[3]];
        break;
      case 'ns':
        // Blinn-Phong exponent -> perceptual roughness.
        mat.roughness = Math.min(1, Math.max(0.04, Math.sqrt(2 / (+parts[1] + 2))));
        break;
      case 'd':
        mat.baseColor[3] = +parts[1];
        break;
      case 'tr':
        mat.baseColor[3] = 1 - +parts[1];
        break;
      case 'pm':
        mat.metallic = +parts[1];
        break;
      case 'pr':
        mat.roughness = +parts[1];
        break;
      case 'map_kd': {
        // Options like "-s 1 1 1" may precede the file name; the file is the last token.
        const file = parts[parts.length - 1];
        pending.push(
          resolve(file)
            .then((bytes) => Texture.fromBlob(new Blob([bytes], { type: mimeFromName(file) }), file))
            .then((t) => {
              mat.baseColorTexture = t;
            })
            .catch((err) => console.warn(`MTL: could not load texture "${file}"`, err)),
        );
        break;
      }
      default:
        break;
    }
  }
  await Promise.all(pending);
  return out;
}
