import { Project, Scene, ScriptLibrary, loadModelAsset, scenePath, serializeScene, type ResourceResolver, type Vec3 } from './engine';
import { buildDemoScene } from './demo';
import { buildDemoGame } from './demoGame';
import { DEMO_GAMES } from './demos';

// The demo project, assembled from the scene builders. The editor opens it on a first visit, and
// scripts/generate-demo-project.mjs saves the same thing as the project folder examples/Demo/. It only uses the
// engine, so it also runs under Node, and everything in it is fixed (ids and paths included) so those files only
// change when a builder does.

/** Sample models exercising the glTF and OBJ loaders, placed in the Main scene. Files are in public/models/. */
const SAMPLE_MODELS: readonly (readonly [file: string, id: string, position: Vec3])[] = [
  ['lantern.glb', 'lantern', [2.6, 0, 3.4]],
  ['icosahedron.obj', 'icosahedron', [-3.2, 0.9, -3]],
];

const MAIN_SCENE = 'Main';

// Scene ids are their paths in a project folder.
const sceneId = scenePath;

/**
 * Builds the demo project. `readModelFile` supplies the sample model files (and their companions) by name; a model
 * that can't be loaded is left out with a warning.
 */
export async function buildDemoProject(readModelFile: ResourceResolver, warnings: string[] = []): Promise<Project> {
  const project = new Project();
  project.name = 'Demo';
  // Every scene shares the project's scripts, so they're all built against one library.
  const scripts = new ScriptLibrary();

  const main = new Scene(scripts);
  buildDemoScene(main);
  for (const [file, id, position] of SAMPLE_MODELS) {
    try {
      const { model, asset } = await loadModelAsset(file, await readModelFile(file), readModelFile, id);
      model.transform.position = position;
      main.add(model);
      project.assets.push({ ...asset, path: `models/${file}` });
    } catch (err) {
      warnings.push(`Could not load ${file}: ${(err as Error).message}`);
    }
  }
  project.scenes.push({ id: sceneId(MAIN_SCENE), name: MAIN_SCENE, data: serializeScene(main, warnings) });

  const games = [...DEMO_GAMES, { name: 'Gem Rush', build: buildDemoGame }];
  for (const { name, build } of games) {
    const scene = new Scene(scripts);
    build(scene);
    project.scenes.push({ id: sceneId(name), name, data: serializeScene(scene, warnings) });
  }

  project.scripts = scripts.scripts.map((s) => ({ name: s.name, source: s.source }));
  project.startScene = sceneId(MAIN_SCENE);
  // A build is the arcade: the menu first, then the games. The editor's own demo scene stays out of it.
  project.build.scenes = [...games.map((g) => ({ id: sceneId(g.name), enabled: true })), { id: sceneId(MAIN_SCENE), enabled: false }];
  return project;
}
