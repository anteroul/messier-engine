// Tiny DOM toolkit for the editor panels. Every control is created with a
// getter/setter pair and returns a Binding whose sync() pulls the current value
// from the model, so the inspector stays live while objects move.

export interface Binding {
  sync(): void;
}

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

export function section(title: string, extra?: HTMLElement): { root: HTMLElement; body: HTMLElement } {
  const body = el('div', { class: 'section-body' });
  const header = el('div', { class: 'section-header' }, [el('span', { text: title }), extra ?? null]);
  const root = el('section', { class: 'section' }, [header, body]);
  return { root, body };
}

export function row(label: string | HTMLElement, ...controls: HTMLElement[]): HTMLElement {
  const l = typeof label === 'string' ? el('label', { class: 'row-label', text: label }) : label;
  return el('div', { class: 'row' }, [l, el('div', { class: 'row-controls' }, controls)]);
}

const isFocused = (e: Element) => document.activeElement === e;

function formatNumber(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(precision);
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
}

export interface NumberOptions {
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  /** Called before the first change of an edit gesture (focus / scrub start). */
  onBegin?: () => void;
  /** Called when an edit gesture ends (change / blur / scrub end). */
  onCommit?: () => void;
}

const clampOpt = (v: number, o: NumberOptions) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));

export function numberInput(get: () => number, set: (v: number) => void, opts: NumberOptions = {}): { input: HTMLInputElement; binding: Binding; scrub: (label: HTMLElement) => void } {
  const precision = opts.precision ?? 3;
  const input = el('input', { type: 'number', step: opts.step ?? 0.1, class: 'num' });
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  let last = NaN;
  const binding: Binding = {
    sync() {
      if (isFocused(input)) return;
      const v = get();
      if (v !== last) {
        last = v;
        input.value = formatNumber(v, precision);
      }
    },
  };
  input.addEventListener('focus', () => opts.onBegin?.());
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) set(clampOpt(v, opts));
  });
  input.addEventListener('change', () => {
    last = NaN;
    opts.onCommit?.();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    e.stopPropagation();
  });

  /** Makes `label` a horizontal drag handle that scrubs the value. */
  const scrub = (label: HTMLElement) => {
    label.classList.add('scrub');
    label.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      label.setPointerCapture(e.pointerId);
      opts.onBegin?.();
      let startX = e.clientX;
      let value = get();
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        startX = ev.clientX;
        const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
        value = clampOpt(value + dx * (opts.step ?? 0.1) * 0.5 * mult, opts);
        set(value);
      };
      const up = () => {
        label.removeEventListener('pointermove', move);
        label.removeEventListener('pointerup', up);
        label.removeEventListener('pointercancel', up);
        opts.onCommit?.();
      };
      label.addEventListener('pointermove', move);
      label.addEventListener('pointerup', up);
      label.addEventListener('pointercancel', up);
    });
  };
  binding.sync();
  return { input, binding, scrub };
}

/** Labeled number row with a scrubbable label. */
export function numberRow(label: string, get: () => number, set: (v: number) => void, opts: NumberOptions = {}): { row: HTMLElement; binding: Binding } {
  const n = numberInput(get, set, opts);
  const l = el('label', { class: 'row-label', text: label });
  n.scrub(l);
  return { row: row(l, n.input), binding: n.binding };
}

export function vec3Row(
  label: string,
  get: () => readonly [number, number, number],
  set: (v: [number, number, number]) => void,
  opts: NumberOptions = {},
): { row: HTMLElement; bindings: Binding[] } {
  const bindings: Binding[] = [];
  const controls = (['X', 'Y', 'Z'] as const).map((axis, i) => {
    const n = numberInput(
      () => get()[i],
      (v) => {
        const cur = [...get()] as [number, number, number];
        cur[i] = v;
        set(cur);
      },
      opts,
    );
    const tag = el('span', { class: `axis-tag axis-${axis.toLowerCase()}`, text: axis });
    n.scrub(tag);
    bindings.push(n.binding);
    return el('div', { class: 'vec-field' }, [tag, n.input]);
  });
  return { row: row(label, ...controls), bindings };
}

export function sliderRow(label: string, get: () => number, set: (v: number) => void, min: number, max: number, step = 0.01): { row: HTMLElement; binding: Binding } {
  const slider = el('input', { type: 'range', min, max, step, class: 'slider' });
  const value = el('span', { class: 'slider-value' });
  let last = NaN;
  const binding: Binding = {
    sync() {
      const v = get();
      if (v === last) return;
      last = v;
      if (!isFocused(slider)) slider.value = String(v);
      value.textContent = formatNumber(v, 2);
    },
  };
  slider.addEventListener('input', () => {
    set(parseFloat(slider.value));
    binding.sync();
  });
  binding.sync();
  return { row: row(label, slider, value), binding };
}

export function colorRow(label: string, get: () => string, set: (hex: string) => void): { row: HTMLElement; binding: Binding } {
  const input = el('input', { type: 'color', class: 'color' });
  const binding: Binding = {
    sync() {
      if (isFocused(input)) return;
      const v = get();
      if (input.value !== v) input.value = v;
    },
  };
  input.addEventListener('input', () => set(input.value));
  binding.sync();
  return { row: row(label, input), binding };
}

export function checkboxRow(label: string, get: () => boolean, set: (v: boolean) => void): { row: HTMLElement; binding: Binding } {
  const input = el('input', { type: 'checkbox' });
  const binding: Binding = {
    sync() {
      input.checked = get();
    },
  };
  input.addEventListener('change', () => set(input.checked));
  binding.sync();
  return { row: row(label, input), binding };
}

export function selectRow(label: string, options: string[], get: () => string, set: (v: string) => void): { row: HTMLElement; binding: Binding } {
  const select = el('select', {}, options.map((o) => el('option', { value: o, text: o })));
  const binding: Binding = {
    sync() {
      if (!isFocused(select) && select.value !== get()) select.value = get();
    },
  };
  select.addEventListener('change', () => set(select.value));
  binding.sync();
  return { row: row(label, select), binding };
}

export function textRow(label: string, get: () => string, set: (v: string) => void): { row: HTMLElement; binding: Binding } {
  const input = el('input', { type: 'text', class: 'text' });
  const binding: Binding = {
    sync() {
      if (!isFocused(input) && input.value !== get()) input.value = get();
    },
  };
  input.addEventListener('change', () => set(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    e.stopPropagation();
  });
  binding.sync();
  return { row: row(label, input), binding };
}

export function button(text: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
  const b = el('button', { class: cls, text, type: 'button' });
  b.addEventListener('click', onClick);
  return b;
}
