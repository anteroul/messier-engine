import { PROFILER_HISTORY, profiler, type RenderStats } from '../engine';

const GRAPH_WIDTH = 240;
const GRAPH_HEIGHT = 48;
/** Seconds between refreshes: fast enough to follow, slow enough to read. */
const REFRESH = 0.25;

const ms = (v: number) => v.toFixed(2);

/**
 * The viewport's profiler overlay: a frame-time graph, the engine's CPU sections, GPU time per render pass and the
 * renderer's counters. Showing it turns `profiler` on; hidden, nothing is measured.
 */
export class ProfilerPanel {
  readonly root = document.createElement('div');
  private readonly summary = document.createElement('div');
  private readonly graph = document.createElement('canvas');
  private readonly body = document.createElement('div');
  private timer = 0;

  constructor() {
    this.root.id = 'profiler';
    this.root.hidden = true;
    this.summary.className = 'profiler-summary';
    this.graph.width = GRAPH_WIDTH;
    this.graph.height = GRAPH_HEIGHT;
    this.body.className = 'profiler-body';
    this.root.append(this.summary, this.graph, this.body);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.root.hidden = !visible;
    profiler.enabled = visible;
    if (visible) {
      profiler.reset();
      this.summary.textContent = 'Measuring…';
      this.body.replaceChildren();
      this.timer = 0;
    }
  }

  /** Call once a frame. */
  update(dt: number, stats: RenderStats | null): void {
    if (!this.visible) return;
    this.timer += dt;
    if (this.timer < REFRESH || profiler.frames === 0) return;
    this.timer = 0;
    const p = profiler;
    const fps = p.avgFrameMs > 0 ? 1000 / p.avgFrameMs : 0;
    this.summary.textContent = `${ms(p.avgFrameMs)} ms · ${fps.toFixed(0)} fps`;
    this.drawGraph();

    const rows: HTMLElement[] = [heading('CPU', p.avgCpuMs)];
    for (const s of p.sections) rows.push(row(s.name, s.avg, s.depth + 1, s.calls > 1 ? `×${s.calls}` : ''));
    if (!p.gpuSupported) rows.push(note('GPU', 'pass timing needs the timestamp-query feature'));
    else if (p.gpu.length === 0) rows.push(note('GPU', 'waiting for results…'));
    else {
      rows.push(heading('GPU', p.avgGpuMs));
      for (const g of p.gpu) rows.push(row(g.name, g.avg, 1));
    }
    if (stats) {
      rows.push(note('Renderer', ''));
      rows.push(count('draw calls', stats.drawCalls), count('mesh instances', stats.instances), count('culled', stats.culled));
      rows.push(count('triangles', stats.triangles));
      rows.push(count('lights', stats.lights), count('shadow casters', stats.shadowCasters), count('2D elements', stats.elements2D));
      rows.push(count('pipeline builds', stats.pipelineBuilds));
    }
    this.body.replaceChildren(...rows);
  }

  /** Frame times as bars, oldest on the left, against 60 and 30 fps lines. */
  private drawGraph(): void {
    const ctx = this.graph.getContext('2d');
    if (!ctx) return;
    const p = profiler;
    const w = GRAPH_WIDTH, h = GRAPH_HEIGHT;
    // At least 30 fps tall, so the two reference lines are always in view.
    let top = 1000 / 30 / 0.9;
    for (const v of p.history) top = Math.max(top, v);
    ctx.clearRect(0, 0, w, h);
    const bar = w / PROFILER_HISTORY;
    for (let i = 0; i < PROFILER_HISTORY; i++) {
      const v = p.history[(p.historyIndex + i) % PROFILER_HISTORY];
      if (v <= 0) continue;
      ctx.fillStyle = v > 1000 / 30 ? '#ff5c5c' : v > 1000 / 55 ? '#f5c451' : '#3ee08f';
      const y = Math.min(h, (v / top) * h);
      ctx.fillRect(i * bar, h - y, Math.max(1, bar - 0.5), y);
    }
    ctx.fillStyle = '#ffffff40';
    for (const line of [1000 / 60, 1000 / 30]) ctx.fillRect(0, Math.round(h - (line / top) * h), w, 1);
  }
}

function el(className: string, ...children: (string | HTMLElement)[]): HTMLElement {
  const e = document.createElement('div');
  e.className = className;
  e.append(...children);
  return e;
}

function span(className: string, text: string): HTMLElement {
  const e = document.createElement('span');
  e.className = className;
  e.textContent = text;
  return e;
}

const heading = (name: string, value: number) => el('profiler-row profiler-heading', span('profiler-name', name), span('profiler-value', `${ms(value)} ms`));
const note = (name: string, text: string) => el('profiler-row profiler-heading', span('profiler-name', name), span('profiler-note', text));
const count = (name: string, value: number) => el('profiler-row', span('profiler-name', name), span('profiler-value', value.toLocaleString('en-US')));

function row(name: string, value: number, depth: number, extra = ''): HTMLElement {
  const label = span('profiler-name', name);
  label.style.paddingLeft = `${(depth - 1) * 10}px`;
  if (extra) label.append(span('profiler-note', ` ${extra}`));
  return el('profiler-row', label, span('profiler-value', ms(value)));
}
