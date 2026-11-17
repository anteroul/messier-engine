// Writes examples/MaterialLab/: the Material Lab example project (src/materialLab/), a showcase of normal,
// metallic-roughness, occlusion and emissive maps, as a project folder. Like examples/Demo/ it is a git repository
// of its own. Run via `npm run generate:materials` after changing its builders or material-lab.glb
// (`npm run generate:materials-glb`); tests/unit checks it's current.
import { importTS, readModelFile, writeExampleFolder } from './example-project.mjs';

const { buildMaterialLabProject } = await importTS(`export { buildMaterialLabProject } from './src/materialLab/index.ts';`);
await writeExampleFolder('examples/MaterialLab', await buildMaterialLabProject(readModelFile));
