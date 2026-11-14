// Runtime of a built game (File → Build). The editor bundles this file into the exported page, next to the
// project data: a .messier file in base64, inside <script id="messier-project" type="application/octet-stream">.
// It plays the project's scenes in order, starting with the first, through each scene's camera.
import { Engine, Project, ProjectResources, ScriptAsset, ScriptLibrary, input, sceneManager } from './engine';

// Keys the browser would otherwise act on (scrolling, Space activating focused elements).
const CAPTURED_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab']);

async function main(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  let project: Project;
  try {
    const data = document.getElementById('messier-project')?.textContent ?? '';
    project = Project.decode(base64ToBytes(data.trim()));
  } catch (err) {
    fail('This game is damaged', (err as Error).message);
    return;
  }

  let engine: Engine;
  try {
    engine = await Engine.create(canvas);
  } catch (err) {
    fail(
      'WebGPU unavailable',
      `${(err as Error).message}\nUse a recent Chromium-based browser (Chrome / Edge 113+), Safari 26+ or Firefox 141+.`,
    );
    return;
  }
  engine.showGrid = false;
  engine.useSceneCamera = true;

  const scripts = new ScriptLibrary();
  scripts.onRuntimeError = (asset, diag, isNew) => {
    if (isNew) console.error(`${asset.name}.ts${diag.line ? `:${diag.line}` : ''}: ${diag.message}${diag.object ? ` (on ${diag.object})` : ''}`);
  };
  for (const { name, source } of project.scripts) {
    const asset = scripts.add(new ScriptAsset(name, source));
    if (!asset.compile()) for (const d of asset.diagnostics) console.error(`${name}.ts${d.line ? `:${d.line}` : ''}: ${d.message}`);
  }

  const resources = new ProjectResources(project);
  sceneManager.attach(engine, {
    names: project.scenes.map((s) => s.name),
    load: async (index) => {
      const warnings: string[] = [];
      const scene = await resources.instantiate(project.scenes[index], scripts, warnings);
      for (const w of warnings) console.warn(w);
      return scene;
    },
  });
  bindInput(canvas);
  // The first load makes the scene active and running; it starts with Play already on.
  engine.setPlaying(true);
  if (!(await sceneManager.loadScene(0))) {
    fail('The game could not start', 'Its first scene failed to load. See the console for details.');
    return;
  }
  engine.start();
  canvas.focus();
  // Expose for console tinkering.
  Object.assign(window, { engine, sceneManager });
}

function bindInput(canvas: HTMLCanvasElement): void {
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts alone
    input.keyDown(e.code);
    if (CAPTURED_KEYS.has(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => input.keyUp(e.code));
  window.addEventListener('blur', () => input.reset());
  canvas.addEventListener('pointerdown', () => canvas.focus());
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function fail(title: string, message: string): void {
  const box = document.getElementById('error')!;
  box.hidden = false;
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  box.replaceChildren(h, p);
  console.error(`${title}: ${message}`);
}

void main();
