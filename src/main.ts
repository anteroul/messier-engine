import './editor/editor.css';
import { Engine, loadModelAssetFromURL, type Vec3 } from './engine';
import { Editor } from './editor/editor';
import { buildDemoScene } from './demo';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main(): Promise<void> {
  const canvas = $<HTMLCanvasElement>('gpu-canvas');
  let engine: Engine;
  try {
    engine = await Engine.create(canvas);
  } catch (err) {
    const box = $('error');
    box.hidden = false;
    box.innerHTML = `<div><h2>WebGPU unavailable</h2><p>${(err as Error).message}</p>
      <p>Use a recent Chromium-based browser (Chrome / Edge 113+) or Firefox 141+.<br/>
      On Linux Chromium you may need <code>--enable-unsafe-webgpu --enable-features=Vulkan</code>
      or <code>chrome://flags/#enable-unsafe-webgpu</code>.</p></div>`;
    console.error(err);
    return;
  }

  const editor = new Editor(engine, {
    viewport: $('viewport'),
    canvas,
    hierarchy: $('hierarchy'),
    inspector: $('inspector'),
    toolbar: $('toolbar'),
    stats: $('stats'),
    toasts: $('toasts'),
    dropOverlay: $('drop-overlay'),
    importInput: $<HTMLInputElement>('import-input'),
    help: $('help'),
    scriptsView: $('scripts-view'),
  });

  engine.start();
  // Expose for console tinkering.
  Object.assign(window, { engine, editor });

  // Continue where the last session left off, or start with the demo.
  if (!(await editor.project.restoreAutosave())) await loadDemo(engine, editor);
}

async function loadDemo(engine: Engine, editor: Editor): Promise<void> {
  buildDemoScene(engine.scene);
  editor.restoreLegacyScripts();
  editor.afterSceneLoad();
  // Sample assets exercising the glTF and OBJ loaders. They become project assets, so the demo saves like any scene.
  const samples: [string, Vec3][] = [
    [`${import.meta.env.BASE_URL}models/lantern.glb`, [2.6, 0, 3.4]],
    [`${import.meta.env.BASE_URL}models/icosahedron.obj`, [-3.2, 0.9, -3]],
  ];
  await Promise.all(
    samples.map(async ([url, pos]) => {
      try {
        const { model, asset } = await loadModelAssetFromURL(url);
        editor.project.addAsset(asset, model);
        model.transform.position = pos;
        engine.scene.add(model);
        editor.hierarchy.markDirty();
      } catch (err) {
        editor.notify(`Could not load ${url}: ${(err as Error).message}`, 'error');
      }
    }),
  );
  editor.project.adoptCurrentScene('Demo');
}

void main();
