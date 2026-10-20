import { tokenize, type Token } from '../engine';
import { el } from './ui';

// A dependency-free code editor: a transparent <textarea> on top of a
// syntax-highlighted <pre>. Both share one font and padding and sit in one
// scroll container, so they line up without syncing scroll positions. Edits go
// through execCommand('insertText') where possible to keep the native undo stack.

const INDENT = '  ';
const LINE_HEIGHT = 20;
const PAD_Y = 8;
const PAD_X = 12;
const OPEN_CLOSE: Record<string, string> = { '{': '}', '[': ']', '(': ')' };

export interface CodeMarker {
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

export class CodeEditor {
  readonly root: HTMLElement;
  /** Called (synchronously) after every edit. */
  onChange: ((text: string) => void) | null = null;
  /** Ctrl/Cmd+S. */
  onSave: (() => void) | null = null;
  /** Caret moved or text changed. */
  onCursor: ((line: number, column: number) => void) | null = null;

  private readonly scroller: HTMLElement;
  private readonly gutter: HTMLElement;
  private readonly code: HTMLElement;
  private readonly marks: HTMLElement;
  private readonly caretLine: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
  private markers: CodeMarker[] = [];
  private lineCount = 0;
  private charWidth = 0;

  constructor(text = '') {
    this.textarea = el('textarea', { class: 'code-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': 'Script source' });
    this.code = el('code');
    this.marks = el('div', { class: 'code-marks' });
    this.caretLine = el('div', { class: 'code-caret-line' });
    this.marks.append(this.caretLine);
    this.gutter = el('div', { class: 'code-gutter', 'aria-hidden': 'true' });
    const sizer = el('div', { class: 'code-sizer' }, [this.marks, el('pre', { class: 'code-highlight', 'aria-hidden': 'true' }, [this.code]), this.textarea]);
    this.scroller = el('div', { class: 'code-scroll' }, [this.gutter, sizer]);
    this.root = el('div', { class: 'code-editor' }, [this.scroller]);
    this.textarea.value = text;

    this.textarea.addEventListener('input', () => {
      this.render();
      this.onChange?.(this.textarea.value);
      this.cursorMoved();
    });
    this.textarea.addEventListener('keydown', (e) => this.keydown(e));
    for (const ev of ['keyup', 'pointerup', 'focus', 'select']) this.textarea.addEventListener(ev, () => this.cursorMoved());
    // Clicks in the empty area below the text should still focus the editor.
    this.scroller.addEventListener('pointerdown', (e) => {
      if (e.target === this.scroller || e.target === this.gutter) {
        e.preventDefault();
        this.textarea.focus();
      }
    });
    this.render();
  }

  get value(): string {
    return this.textarea.value;
  }

  /** Replaces the whole document (resets the native undo history). */
  set value(text: string) {
    if (text === this.textarea.value) return;
    this.textarea.value = text;
    this.render();
  }

  focus(): void {
    this.textarea.focus({ preventScroll: true });
  }

  setMarkers(markers: CodeMarker[]): void {
    this.markers = markers;
    this.renderGutter(true);
    this.renderMarks();
  }

  /** Moves the caret to a 1-based line/column and scrolls it into view. */
  reveal(line: number, column = 1): void {
    const lines = this.textarea.value.split('\n');
    const l = Math.max(1, Math.min(line, lines.length));
    let offset = 0;
    for (let i = 0; i < l - 1; i++) offset += lines[i].length + 1;
    offset += Math.max(0, Math.min(column - 1, lines[l - 1].length));
    this.focus();
    this.textarea.setSelectionRange(offset, offset);
    this.cursorMoved(true);
  }

  cursor(): { line: number; column: number } {
    const before = this.textarea.value.slice(0, this.textarea.selectionStart);
    const line = before.split('\n').length;
    return { line, column: before.length - before.lastIndexOf('\n') };
  }

  // ------------------------------------------------------------ rendering

  private render(): void {
    const text = this.textarea.value;
    this.code.innerHTML = highlight(text) + '\n';
    this.renderGutter(false);
    this.renderMarks();
  }

  private renderGutter(force: boolean): void {
    const count = this.textarea.value.split('\n').length;
    if (count === this.lineCount && !force) return;
    this.lineCount = count;
    const byLine = new Map<number, CodeMarker>();
    for (const m of this.markers) if (!byLine.has(m.line) || m.severity === 'error') byLine.set(m.line, m);
    const rows: string[] = [];
    for (let i = 1; i <= count; i++) {
      const m = byLine.get(i);
      rows.push(m ? `<div class="ln ln-${m.severity}" title="${escapeHtml(m.message)}">${i}</div>` : `<div class="ln">${i}</div>`);
    }
    this.gutter.innerHTML = rows.join('');
  }

  /** Error bands, squiggles and inline messages, positioned on the monospace grid. */
  private renderMarks(): void {
    for (const n of [...this.marks.children]) if (n !== this.caretLine) n.remove();
    if (!this.markers.length) return;
    const cw = this.measureChar();
    const lines = this.textarea.value.split('\n');
    const shown = new Set<number>();
    for (const m of this.markers) {
      if (m.line < 1 || m.line > lines.length) continue;
      const top = PAD_Y + (m.line - 1) * LINE_HEIGHT;
      const text = lines[m.line - 1];
      const col = Math.max(1, Math.min(m.column || 1, text.length + 1));
      // Underline the word at the error (or the single character there).
      const word = /^[\w$#]+/.exec(text.slice(col - 1))?.[0] || text[col - 1]?.trim() || ' ';
      this.marks.append(
        el('div', { class: `code-band code-band-${m.severity}`, style: `top:${top}px` }),
        el('div', { class: `code-squiggle code-squiggle-${m.severity}`, style: `top:${top}px;left:${PAD_X + (col - 1) * cw}px`, text: word }),
      );
      if (!shown.has(m.line)) {
        shown.add(m.line);
        const left = PAD_X + (text.replace(/\t/g, INDENT).length + 3) * cw;
        this.marks.append(el('div', { class: `code-lens code-lens-${m.severity}`, style: `top:${top}px;left:${left}px`, text: m.message }));
      }
    }
  }

  private measureChar(): number {
    if (!this.charWidth || !this.root.isConnected) {
      const probe = el('span', { text: 'x'.repeat(20) });
      this.code.append(probe);
      const w = probe.getBoundingClientRect().width / 20;
      probe.remove();
      if (w > 0) this.charWidth = w;
    }
    return this.charWidth || 7.8;
  }

  private cursorMoved(center = false): void {
    const { line, column } = this.cursor();
    this.caretLine.style.top = `${PAD_Y + (line - 1) * LINE_HEIGHT}px`;
    // Keep the caret visible inside the outer scroll container.
    const s = this.scroller;
    const y = PAD_Y + (line - 1) * LINE_HEIGHT;
    if (center && (y < s.scrollTop || y + LINE_HEIGHT > s.scrollTop + s.clientHeight)) s.scrollTop = y - s.clientHeight / 2;
    else if (y < s.scrollTop) s.scrollTop = y - PAD_Y;
    else if (y + LINE_HEIGHT + PAD_Y > s.scrollTop + s.clientHeight) s.scrollTop = y + LINE_HEIGHT + PAD_Y - s.clientHeight;
    const gutterW = this.gutter.offsetWidth;
    const x = PAD_X + (column - 1) * this.measureChar();
    const viewW = s.clientWidth - gutterW;
    if (x < s.scrollLeft + PAD_X) s.scrollLeft = Math.max(0, x - PAD_X * 2);
    else if (x > s.scrollLeft + viewW - PAD_X * 2) s.scrollLeft = x - viewW + PAD_X * 4;
    this.onCursor?.(line, column);
  }

  // -------------------------------------------------------------- editing

  /** Replaces [start, end) with `text` through the browser's editing pipeline (undoable). */
  private insert(text: string, start: number, end: number): void {
    const ta = this.textarea;
    ta.setSelectionRange(start, end);
    // execCommand is deprecated but still the only way to keep the textarea's undo stack.
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, start, end, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  }

  private keydown(e: KeyboardEvent): void {
    const ta = this.textarea;
    const mod = e.ctrlKey || e.metaKey;
    const { selectionStart: s, selectionEnd: t, value } = ta;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.onSave?.();
      return;
    }
    if (mod && (e.key === '/' || e.code === 'Slash')) {
      e.preventDefault();
      this.toggleComment();
      return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const multiline = value.slice(s, t).includes('\n');
      if (e.shiftKey || multiline) this.indentLines(e.shiftKey ? -1 : 1);
      else {
        const col = s - value.lastIndexOf('\n', s - 1) - 1;
        this.insert(' '.repeat(INDENT.length - (col % INDENT.length)), s, t);
      }
      return;
    }
    if (e.key === 'Enter' && !mod && !e.altKey && !e.isComposing) {
      e.preventDefault();
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const indent = /^[ \t]*/.exec(value.slice(lineStart, s))![0];
      const before = value.slice(lineStart, s).trimEnd();
      const opener = before[before.length - 1];
      const after = value[t];
      if (opener in OPEN_CLOSE) {
        if (after === OPEN_CLOSE[opener]) {
          // Between a bracket pair: open an indented line and push the closer down.
          this.insert(`\n${indent}${INDENT}\n${indent}`, s, t);
          const caret = s + 1 + indent.length + INDENT.length;
          ta.setSelectionRange(caret, caret);
        } else this.insert(`\n${indent}${INDENT}`, s, t);
      } else this.insert(`\n${indent}`, s, t);
      this.cursorMoved();
      return;
    }
    if ((e.key === '}' || e.key === ']' || e.key === ')') && !mod && s === t) {
      // Typing a closer on an indent-only line dedents it.
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const lead = value.slice(lineStart, s);
      if (lead.length >= INDENT.length && /^ +$/.test(lead)) {
        e.preventDefault();
        this.insert(lead.slice(INDENT.length) + e.key, lineStart, s);
      }
    }
  }

  /** Full lines covered by the selection: [start, end) offsets. */
  private selectedLines(): [number, number] {
    const { selectionStart: s, selectionEnd: t, value } = this.textarea;
    const start = value.lastIndexOf('\n', s - 1) + 1;
    // A selection ending at column 0 doesn't include that line.
    const endAt = t > s && value[t - 1] === '\n' ? t - 1 : t;
    let end = value.indexOf('\n', endAt);
    if (end < 0) end = value.length;
    return [start, end];
  }

  private indentLines(dir: 1 | -1): void {
    const ta = this.textarea;
    const [start, end] = this.selectedLines();
    const { selectionStart: s, selectionEnd: t } = ta;
    const lines = ta.value.slice(start, end).split('\n');
    let firstDelta = 0, totalDelta = 0;
    const out = lines.map((line, i) => {
      let next: string;
      if (dir > 0) next = line.length ? INDENT + line : line;
      else next = line.replace(new RegExp(`^ {1,${INDENT.length}}|^\\t`), '');
      const d = next.length - line.length;
      if (i === 0) firstDelta = d;
      totalDelta += d;
      return next;
    });
    this.insert(out.join('\n'), start, end);
    ta.setSelectionRange(Math.max(start, s + firstDelta), Math.max(start, t + totalDelta));
    this.cursorMoved();
  }

  private toggleComment(): void {
    const ta = this.textarea;
    const [start, end] = this.selectedLines();
    const { selectionStart: s, selectionEnd: t } = ta;
    const lines = ta.value.slice(start, end).split('\n');
    const nonEmpty = lines.filter((l) => l.trim());
    const uncomment = nonEmpty.length > 0 && nonEmpty.every((l) => /^\s*\/\//.test(l));
    const minIndent = Math.min(...nonEmpty.map((l) => /^ */.exec(l)![0].length));
    let firstDelta = 0, totalDelta = 0;
    const out = lines.map((line, i) => {
      let next = line;
      if (uncomment) next = line.replace(/^(\s*)\/\/ ?/, '$1');
      else if (line.trim()) next = line.slice(0, minIndent) + '// ' + line.slice(minIndent);
      const d = next.length - line.length;
      if (i === 0) firstDelta = d;
      totalDelta += d;
      return next;
    });
    this.insert(out.join('\n'), start, end);
    ta.setSelectionRange(Math.max(start, s + firstDelta), Math.max(start, t + totalDelta));
    this.cursorMoved();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'this', 'super']);

/** Syntax-highlighted HTML for TypeScript source. */
export function highlight(src: string): string {
  let toks: Token[];
  try {
    toks = tokenize(src, true);
  } catch {
    return escapeHtml(src);
  }
  let html = '';
  let pos = 0;
  const significant = toks.filter((t) => t.kind !== 'comment');
  let si = 0;
  for (const t of toks) {
    if (t.kind === 'eof') break;
    html += escapeHtml(src.slice(pos, t.start));
    let cls = '';
    switch (t.kind) {
      case 'keyword':
        cls = LITERALS.has(t.value) ? 'tk-lit' : 'tk-kw';
        break;
      case 'ident': {
        while (significant[si] && significant[si].start <= t.start) si++;
        const next = significant[si];
        if (next?.value === '(' || (next?.value === '<' && /^[A-Z]/.test(t.value) === false && significant[si + 1]?.kind === 'ident')) cls = 'tk-fn';
        else if (/^[A-Z]/.test(t.value)) cls = 'tk-type';
        else if (t.value.startsWith('#')) cls = 'tk-priv';
        break;
      }
      case 'number':
        cls = 'tk-num';
        break;
      case 'string':
      case 'template':
        cls = 'tk-str';
        break;
      case 'regex':
        cls = 'tk-re';
        break;
      case 'comment':
        cls = 'tk-com';
        break;
    }
    const text = escapeHtml(t.value);
    html += cls ? `<span class="${cls}">${text}</span>` : text;
    pos = t.end;
  }
  return html + escapeHtml(src.slice(pos));
}
