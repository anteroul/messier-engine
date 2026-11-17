// Writes examples/Demo/: the demo project the editor starts with, as a project folder (Export to Folder writes the
// same, script types for code editors included). The folder is a git repository of its own
// (github.com/anteroul/messier-arcade, not tracked by the engine's).
// Run via `npm run generate:demo` after changing a demo scene builder or a sample model (tests/unit checks it's current).
import { importTS, readModelFile, writeExampleFolder } from './example-project.mjs';

const { buildDemoProject } = await importTS(`export { buildDemoProject } from './src/demoProject.ts';`);
const warnings = [];
const project = await buildDemoProject(readModelFile, warnings);
if (warnings.length) {
  console.error(warnings.join('\n'));
  process.exit(1);
}
await writeExampleFolder('examples/Demo', project);
