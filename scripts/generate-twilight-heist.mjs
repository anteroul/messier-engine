// Writes examples/TwilightHeist/: the Twilight Heist example project (src/twilightHeist/), a stealth game that shows off
// cascaded, spot and point light shadows and blended materials, as a project folder. Like examples/Demo/ it is a git
// repository of its own. Run via `npm run generate:heist` after changing its builder; tests/unit checks it's current.
import { importTS, writeExampleFolder } from './example-project.mjs';

const { buildTwilightHeistProject } = await importTS(`export { buildTwilightHeistProject } from './src/twilightHeist/index.ts';`);
await writeExampleFolder('examples/TwilightHeist', buildTwilightHeistProject());
