import { GameObject } from '../scene';
import { Mesh, computeNormals } from '../mesh';
import { Material, Texture } from '../material';
import { Light } from '../light';
import { mat4 } from '../math';
import { mimeFromName, type ResourceResolver } from './resources';

// glTF 2.0 loader (.gltf + .bin + images, or binary .glb).
// Supported: node hierarchy, TRS/matrix transforms, triangle primitives,
// metallic-roughness materials with base color textures, alpha mask,
// double-sided, KHR_lights_punctual, KHR_materials_emissive_strength.
// Not supported: skins, morph targets, animations, Draco/meshopt compression.

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const UNSUPPORTED_REQUIRED = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

interface Primitive {
  mesh: Mesh;
  material: Material;
}

export async function loadGLTF(data: ArrayBuffer, name: string, resolve: ResourceResolver): Promise<GameObject> {
  let json: Json;
  let glbBin: ArrayBuffer | null = null;

  const header = new DataView(data, 0, Math.min(12, data.byteLength));
  if (data.byteLength >= 12 && header.getUint32(0, true) === GLB_MAGIC) {
    const view = new DataView(data);
    const length = view.getUint32(8, true);
    let offset = 12;
    while (offset < length) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (chunkType === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, start, chunkLength)));
      else if (chunkType === CHUNK_BIN && !glbBin) glbBin = data.slice(start, start + chunkLength);
      offset = start + chunkLength;
    }
    if (!json) throw new Error('GLB file has no JSON chunk');
  } else {
    json = JSON.parse(new TextDecoder().decode(data));
  }

  if (!json.asset || !String(json.asset.version ?? '').startsWith('2')) {
    throw new Error('Only glTF 2.0 assets are supported');
  }
  const required: string[] = json.extensionsRequired ?? [];
  const blocked = required.filter((e) => UNSUPPORTED_REQUIRED.includes(e));
  if (blocked.length) throw new Error(`Unsupported required glTF extension(s): ${blocked.join(', ')}`);

  // --- Buffers --------------------------------------------------------------
  const buffers: ArrayBuffer[] = await Promise.all(
    (json.buffers ?? []).map(async (b: Json) => {
      if (b.uri === undefined) {
        if (!glbBin) throw new Error('Buffer without URI but no GLB binary chunk');
        return glbBin;
      }
      if (String(b.uri).startsWith('data:')) return (await fetch(b.uri)).arrayBuffer();
      return resolve(b.uri);
    }),
  );

  const bufferViewBytes = (index: number): Uint8Array => {
    const bv = json.bufferViews[index];
    return new Uint8Array(buffers[bv.buffer], bv.byteOffset ?? 0, bv.byteLength);
  };

  // --- Accessors ------------------------------------------------------------
  const readAccessor = (index: number, asIndices = false): Float32Array | Uint32Array => {
    const acc = json.accessors[index];
    const comps = COMPONENT_COUNT[acc.type];
    const count: number = acc.count;
    const out = asIndices ? new Uint32Array(count * comps) : new Float32Array(count * comps);
    if (acc.bufferView !== undefined) {
      const bv = json.bufferViews[acc.bufferView];
      const compSize = COMPONENT_SIZE[acc.componentType];
      const stride: number = bv.byteStride ?? compSize * comps;
      const view = new DataView(buffers[bv.buffer], (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0));
      const norm = !!acc.normalized && !asIndices;
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < comps; c++) {
          const off = i * stride + c * compSize;
          let v: number;
          switch (acc.componentType) {
            case 5126: v = view.getFloat32(off, true); break;
            case 5125: v = view.getUint32(off, true); break;
            case 5123: v = view.getUint16(off, true); if (norm) v /= 65535; break;
            case 5122: v = view.getInt16(off, true); if (norm) v = Math.max(v / 32767, -1); break;
            case 5121: v = view.getUint8(off); if (norm) v /= 255; break;
            case 5120: v = view.getInt8(off); if (norm) v = Math.max(v / 127, -1); break;
            default: throw new Error(`Unknown accessor component type ${acc.componentType}`);
          }
          out[i * comps + c] = v;
        }
      }
    }
    if (acc.sparse) {
      const sp = acc.sparse;
      const idxView = bufferViewBytes(sp.indices.bufferView);
      const idxData = new DataView(idxView.buffer, idxView.byteOffset + (sp.indices.byteOffset ?? 0));
      const valView = bufferViewBytes(sp.values.bufferView);
      const valData = new DataView(valView.buffer, valView.byteOffset + (sp.values.byteOffset ?? 0));
      const idxSize = COMPONENT_SIZE[sp.indices.componentType];
      for (let i = 0; i < sp.count; i++) {
        const target =
          idxSize === 1 ? idxData.getUint8(i) : idxSize === 2 ? idxData.getUint16(i * 2, true) : idxData.getUint32(i * 4, true);
        for (let c = 0; c < comps; c++) {
          // Sparse values: only float support (the common case for morph-free assets).
          out[target * comps + c] = acc.componentType === 5126 ? valData.getFloat32((i * comps + c) * 4, true) : out[target * comps + c];
        }
      }
    }
    return out;
  };

  // --- Images & textures ----------------------------------------------------
  const imageCache = new Map<number, Promise<Texture | null>>();
  const loadImage = (index: number): Promise<Texture | null> => {
    let p = imageCache.get(index);
    if (!p) {
      const img = json.images[index];
      p = (async () => {
        try {
          let bytes: ArrayBuffer;
          let mime: string = img.mimeType ?? '';
          if (img.bufferView !== undefined) {
            bytes = bufferViewBytes(img.bufferView).slice().buffer as ArrayBuffer;
          } else if (String(img.uri).startsWith('data:')) {
            bytes = await (await fetch(img.uri)).arrayBuffer();
          } else {
            bytes = await resolve(img.uri);
            mime ||= mimeFromName(img.uri);
          }
          return await Texture.fromBlob(new Blob([bytes], { type: mime }), img.name ?? img.uri ?? `image${index}`);
        } catch (err) {
          console.warn(`glTF: failed to load image ${index}`, err);
          return null;
        }
      })();
      imageCache.set(index, p);
    }
    return p;
  };
  const loadTexture = async (info: Json): Promise<Texture | null> => {
    if (!info) return null;
    const tex = json.textures?.[info.index];
    if (!tex || tex.source === undefined) return null;
    return loadImage(tex.source);
  };

  // --- Materials ------------------------------------------------------------
  const materials: Material[] = await Promise.all(
    (json.materials ?? []).map(async (m: Json, i: number) => {
      const mat = new Material(m.name ?? `${name}_material${i}`);
      const pbr = m.pbrMetallicRoughness ?? {};
      if (pbr.baseColorFactor) mat.baseColor = [...pbr.baseColorFactor] as Material['baseColor'];
      mat.metallic = pbr.metallicFactor ?? 1;
      mat.roughness = pbr.roughnessFactor ?? 1;
      mat.baseColorTexture = await loadTexture(pbr.baseColorTexture);
      if (m.emissiveFactor) mat.emissive = [...m.emissiveFactor] as Material['emissive'];
      mat.emissiveStrength = m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
      if (m.alphaMode === 'MASK') mat.alphaCutoff = m.alphaCutoff ?? 0.5;
      mat.doubleSided = !!m.doubleSided;
      mat.unlit = !!m.extensions?.KHR_materials_unlit;
      return mat;
    }),
  );
  let defaultMaterial: Material | null = null;
  const getDefaultMaterial = () => (defaultMaterial ??= new Material(`${name}_default`, { metallic: 0, roughness: 0.6 }));

  // --- Meshes ---------------------------------------------------------------
  const meshCache = new Map<number, Primitive[]>();
  const getMesh = (index: number): Primitive[] => {
    let prims = meshCache.get(index);
    if (prims) return prims;
    const m = json.meshes[index];
    prims = [];
    (m.primitives as Json[]).forEach((p, pi) => {
      const mode = p.mode ?? 4;
      if (mode !== 4) {
        console.warn(`glTF: skipping primitive with mode ${mode} (only triangles are supported)`);
        return;
      }
      if (p.attributes.POSITION === undefined) return;
      const positions = readAccessor(p.attributes.POSITION) as Float32Array;
      const indices = p.indices !== undefined ? (readAccessor(p.indices, true) as Uint32Array) : null;
      const idx = indices ?? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
      const normals = p.attributes.NORMAL !== undefined ? (readAccessor(p.attributes.NORMAL) as Float32Array) : computeNormals(positions, idx);
      const uvs = p.attributes.TEXCOORD_0 !== undefined ? (readAccessor(p.attributes.TEXCOORD_0) as Float32Array) : null;
      const meshName = `${m.name ?? `${name}_mesh${index}`}${m.primitives.length > 1 ? `_${pi}` : ''}`;
      prims!.push({
        mesh: Mesh.fromArrays(meshName, positions, normals, uvs, idx),
        material: p.material !== undefined ? materials[p.material] : getDefaultMaterial(),
      });
    });
    meshCache.set(index, prims);
    return prims;
  };

  // --- Lights ---------------------------------------------------------------
  const lightDefs: Json[] = json.extensions?.KHR_lights_punctual?.lights ?? [];
  const makeLight = (index: number): Light | null => {
    const def = lightDefs[index];
    if (!def) return null;
    const type = def.type === 'directional' ? 'directional' : def.type === 'spot' ? 'spot' : 'point';
    const light = new Light(type, def.color ? [...def.color] as Light['color'] : [1, 1, 1], def.intensity ?? 1);
    if (def.range) light.range = def.range;
    if (type === 'spot') {
      light.innerAngle = ((def.spot?.innerConeAngle ?? 0) * 180) / Math.PI;
      light.outerAngle = ((def.spot?.outerConeAngle ?? Math.PI / 4) * 180) / Math.PI;
    }
    if (type === 'directional') light.castShadows = true;
    return light;
  };

  // --- Nodes ----------------------------------------------------------------
  const buildNode = (index: number, depth: number): GameObject => {
    if (depth > 256) throw new Error('glTF node hierarchy too deep (cycle?)');
    const n = json.nodes[index];
    const obj = new GameObject(n.name ?? `Node ${index}`);
    if (n.matrix) {
      const { t, r, s } = mat4.decompose(new Float32Array(n.matrix));
      obj.transform.position = t;
      obj.transform.rotation = r;
      obj.transform.scale = s;
    } else {
      if (n.translation) obj.transform.position = [...n.translation] as GameObject['transform']['position'];
      if (n.rotation) obj.transform.rotation = [...n.rotation] as GameObject['transform']['rotation'];
      if (n.scale) obj.transform.scale = [...n.scale] as GameObject['transform']['scale'];
    }
    if (n.mesh !== undefined) {
      const prims = getMesh(n.mesh);
      if (prims.length === 1) {
        obj.mesh = prims[0].mesh;
        obj.material = prims[0].material;
      } else {
        prims.forEach((p, i) => {
          const child = new GameObject(`${obj.name} [${i}]`);
          child.mesh = p.mesh;
          child.material = p.material;
          obj.add(child);
        });
      }
    }
    const lightIndex = n.extensions?.KHR_lights_punctual?.light;
    if (lightIndex !== undefined) obj.light = makeLight(lightIndex);
    for (const c of n.children ?? []) obj.add(buildNode(c, depth + 1));
    return obj;
  };

  const sceneIndex = json.scene ?? 0;
  const roots: number[] =
    json.scenes?.[sceneIndex]?.nodes ??
    // No scenes: use every node that is not someone's child.
    (json.nodes ?? [])
      .map((_: Json, i: number) => i)
      .filter((i: number) => !(json.nodes as Json[]).some((n) => (n.children ?? []).includes(i)));
  // A single root node is returned directly instead of wrapping it.
  if (roots.length === 1) return buildNode(roots[0], 0);
  const root = new GameObject(name);
  for (const i of roots) root.add(buildNode(i, 0));
  return root;
}
