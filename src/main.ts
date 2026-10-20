import './editor/editor.css';
import { Engine, loadModelFromURL, type Vec3 } from './engine';
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

  buildDemoScene(engine.scene);

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

  // Sample assets exercising the glTF and OBJ loaders.
  const samples: [string, Vec3][] = [
    [`${import.meta.env.BASE_URL}models/lantern.glb`, [2.6, 0, 3.4]],
    [`${import.meta.env.BASE_URL}models/icosahedron.obj`, [-3.2, 0.9, -3]],
  ];
  for (const [url, pos] of samples) {
    loadModelFromURL(url)
      .then((model) => {
        model.transform.position = pos;
        engine.scene.add(model);
        editor.hierarchy.markDirty();
      })
      .catch((err) => editor.notify(`Could not load ${url}: ${(err as Error).message}`, 'error'));
  }

  engine.start();
  // Expose for console tinkering.
  Object.assign(window, { engine, editor });
}

void main();
