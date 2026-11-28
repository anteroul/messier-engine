import { Project, Scene, ScriptLibrary, scenePath, serializeScene } from '../engine';
import { buildGarden } from './scene';

// The Twilight Heist example project: a stealth game in a castle garden at dusk, built to show off shadows (the
// sun's cascades, the watchtower lamps' spot light shadows, the brazier's point light shadow) and blended materials.
// scripts/generate-twilight-heist.mjs saves it as the project folder examples/TwilightHeist/. Like the other examples
// it only uses the engine, and it's built from primitives, so its files only change when the builder does.

/** Scene names, in build order. */
export const TWILIGHT_HEIST_SCENES = ['Garden'] as const;

export function buildTwilightHeistProject(): Project {
  const project = new Project();
  project.name = 'Twilight Heist';
  project.build.title = 'Twilight Heist';
  const scripts = new ScriptLibrary();
  const builders = { Garden: buildGarden };
  for (const name of TWILIGHT_HEIST_SCENES) {
    const scene = new Scene(scripts);
    builders[name](scene);
    const warnings: string[] = [];
    const data = serializeScene(scene, warnings);
    if (warnings.length) throw new Error(`Twilight Heist: ${warnings.join('; ')}`);
    project.scenes.push({ id: scenePath(name), name, data });
  }
  project.scripts = scripts.scripts.map((s) => ({ name: s.name, source: s.source }));
  project.startScene = scenePath(TWILIGHT_HEIST_SCENES[0]);
  project.build.scenes = TWILIGHT_HEIST_SCENES.map((name) => ({ id: scenePath(name), enabled: true }));
  return project;
}
