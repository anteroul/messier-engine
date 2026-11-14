import './editor/editor.css';
import { Engine, urlResolver } from './engine';
import { Editor } from './editor/editor';
import { buildDemoProject } from './demoProject';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main(): Promise<void> {
  for (const el of document.querySelectorAll('.app-version')) el.textContent = __APP_VERSION__;
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
  if (!(await editor.project.restoreAutosave())) await loadDemo(editor);
}

async function loadDemo(editor: Editor): Promise<void> {
  const warnings: string[] = [];
  const project = await buildDemoProject(urlResolver(`${import.meta.env.BASE_URL}models/`), warnings);
  for (const w of warnings) editor.notify(w, 'error');
  await editor.project.openProject(project);
  editor.restoreLegacyScripts();
}

void main();
