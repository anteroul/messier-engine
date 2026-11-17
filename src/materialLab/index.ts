import { Project, Scene, ScriptLibrary, loadModelAsset, scenePath, serializeScene, type ResourceResolver } from '../engine';
import { buildGallery, buildOrbit, labParts } from './scenes';

// The Material Lab example project: a showcase of material maps (normal, metallic-roughness, occlusion, emissive).
// scripts/generate-material-lab.mjs saves it as the project folder examples/MaterialLab/. Like the demo project it
// only uses the engine and everything in it is fixed, so its files only change when a builder or the model does.

/** The model the scenes are built from (in public/models/, made by scripts/generate-material-glb.mjs). */
export const MATERIAL_LAB_MODEL = 'material-lab.glb';

/** Scene names, in build order. */
export const MATERIAL_LAB_SCENES = ['Gallery', 'Orbit'] as const;

/** Builds the project. `readModelFile` supplies material-lab.glb by name. */
export async function buildMaterialLabProject(readModelFile: ResourceResolver): Promise<Project> {
  const project = new Project();
  project.name = 'Material Lab';
  project.build.title = 'Messier Material Lab';
  const scripts = new ScriptLibrary();

  const { model, asset } = await loadModelAsset(MATERIAL_LAB_MODEL, await readModelFile(MATERIAL_LAB_MODEL), readModelFile, 'material-lab');
  project.assets.push({ ...asset, path: `models/${MATERIAL_LAB_MODEL}` });
  const parts = labParts(model);

  const builders = { Gallery: buildGallery, Orbit: buildOrbit };
  for (const name of MATERIAL_LAB_SCENES) {
    const scene = new Scene(scripts);
    builders[name](scene, parts);
    const warnings: string[] = [];
    const data = serializeScene(scene, warnings);
    if (warnings.length) throw new Error(`Material Lab: ${warnings.join('; ')}`);
    project.scenes.push({ id: scenePath(name), name, data });
  }

  project.scripts = scripts.scripts.map((s) => ({ name: s.name, source: s.source }));
  project.startScene = scenePath(MATERIAL_LAB_SCENES[0]);
  project.build.scenes = MATERIAL_LAB_SCENES.map((name) => ({ id: scenePath(name), enabled: true }));
  return project;
}
