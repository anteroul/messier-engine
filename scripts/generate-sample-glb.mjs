// Generates public/models/lantern.glb: a small glTF 2.0 binary asset exercising
// the loader (node hierarchy, embedded PNG texture, emissive material and a
// KHR_lights_punctual point light). Run with: npm run generate:sample
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlbBuilder, box, png } from './glb.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'lantern.glb');
const glb = new GlbBuilder();

const checker = png(64, 64, (x, y) => {
  const on = ((x >> 3) + (y >> 3)) % 2 === 0;
  return on ? [200, 196, 188, 255] : [90, 88, 84, 255];
});
const imageView = glb.addView(checker);

const meshes = [
  glb.addMesh('LanternBase', box(0.8, 0.25, 0.8), 0),
  glb.addMesh('LanternPole', box(0.12, 2.2, 0.12), 1),
  glb.addMesh('LanternCap', box(0.55, 0.08, 0.55), 1),
  glb.addMesh('LanternGlass', box(0.36, 0.4, 0.36), 2),
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
};

const size = glb.write(out, gltf);
console.log(`Wrote ${out} (${size} bytes)`);
