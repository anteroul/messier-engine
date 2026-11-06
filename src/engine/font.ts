// Signed-distance-field glyph atlas and text layout for 2D text.
//
// Glyphs are rasterized once per font at SDF_EM pixels per em by a GlyphRasterizer (OffscreenCanvas in browsers),
// turned into a distance field and packed into one single-channel atlas. The renderer uploads the atlas and draws
// each glyph as a quad whose fragment thresholds the distance, so text stays sharp at any size and outlines are
// just a lower threshold. Without a rasterizer (Node) glyphs have estimated advances and no quads.

/** Pixels per em at which glyphs are rasterized into the atlas. */
export const SDF_EM = 48;
/** Distance-field reach in atlas pixels, and the empty border around each glyph. */
const SDF_RADIUS = 10;
const SDF_PAD = 10;
/** Distance value (0…1) of the glyph edge. tiny-sdf's 0.25 cutoff: more reach outside, where outlines go. */
export const SDF_EDGE = 0.75;
export const ATLAS_SIZE = 2048;

export interface FontStyle {
  /** CSS font family list, e.g. 'sans-serif' or 'Georgia, serif'. */
  family: string;
  bold: boolean;
}

/** A rasterized glyph: coverage (0…1) of a `width`×`height` bitmap whose pen origin is at (`originX`, `originY`), y down. */
export interface GlyphBitmap {
  width: number;
  height: number;
  coverage: ArrayLike<number>;
  originX: number;
  originY: number;
  /** Advance in pixels at SDF_EM. */
  advance: number;
}

/**
 * Turns characters into coverage bitmaps at `sizePx` pixels per em, with `pad` empty pixels on every side.
 * `metrics` gives the font's ascent and descent in pixels.
 */
export interface GlyphRasterizer {
  glyph(char: string, font: FontStyle, sizePx: number, pad: number): GlyphBitmap | null;
  metrics(font: FontStyle, sizePx: number): { ascent: number; descent: number };
}

/** A glyph in the atlas. Quad and advance are in ems relative to the pen on the baseline, y up. */
export interface Glyph {
  advance: number;
  /** False for blank glyphs (spaces) and when nothing could be rasterized. */
  visible: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

function canvasRasterizer(): GlyphRasterizer | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const size = SDF_EM * 3;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const setFont = (font: FontStyle, px: number) => {
    ctx.font = `${font.bold ? 'bold ' : ''}${px}px ${font.family || 'sans-serif'}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
  };
  return {
    glyph(char, font, px, pad) {
      setFont(font, px);
      const m = ctx.measureText(char);
      const left = Math.ceil(Math.max(0, m.actualBoundingBoxLeft));
      const right = Math.ceil(Math.max(0, m.actualBoundingBoxRight));
      const ascent = Math.ceil(Math.max(0, m.actualBoundingBoxAscent));
      const descent = Math.ceil(Math.max(0, m.actualBoundingBoxDescent));
      const width = Math.min(size, left + right + pad * 2);
      const height = Math.min(size, ascent + descent + pad * 2);
      const originX = pad + left, originY = pad + ascent;
      if (left + right === 0 || ascent + descent === 0) return { width: 0, height: 0, coverage: [], originX, originY, advance: m.width };
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#fff';
      ctx.fillText(char, originX, originY);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const coverage = new Float32Array(width * height);
      for (let i = 0; i < coverage.length; i++) coverage[i] = rgba[i * 4 + 3] / 255;
      return { width, height, coverage, originX, originY, advance: m.width };
    },
    metrics(font, px) {
      setFont(font, px);
      const m = ctx.measureText('Hg');
      // fontBoundingBox* is missing in older browsers; fall back to typical proportions.
      const ascent = m.fontBoundingBoxAscent ?? px * 0.8;
      const descent = m.fontBoundingBoxDescent ?? px * 0.2;
      return { ascent, descent };
    },
  };
}

const INF = 1e20;

/** 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in place along a strided line. */
function edt1d(grid: Float64Array, offset: number, stride: number, length: number, f: Float64Array, v: Uint16Array, z: Float64Array): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k], qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}

function edt(grid: Float64Array, width: number, height: number, f: Float64Array, v: Uint16Array, z: Float64Array): void {
  for (let x = 0; x < width; x++) edt1d(grid, x, width, height, f, v, z);
  for (let y = 0; y < height; y++) edt1d(grid, y * width, 1, width, f, v, z);
}

/**
 * Distance field of a coverage bitmap, as bytes: SDF_EDGE·255 on the edge, higher inside, falling to 0 at
 * SDF_RADIUS·SDF_EDGE pixels outside. Partial coverage places the edge between pixels (as in mapbox's tiny-sdf).
 */
export function coverageToSDF(coverage: ArrayLike<number>, width: number, height: number): Uint8Array {
  const n = width * height;
  const outer = new Float64Array(n), inner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = coverage[i];
    if (a >= 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else if (a <= 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  const len = Math.max(width, height);
  const f = new Float64Array(len), z = new Float64Array(len + 1), v = new Uint16Array(len);
  edt(outer, width, height, f, v, z);
  edt(inner, width, height, f, v, z);
  const out = new Uint8Array(n);
  const cutoff = 1 - SDF_EDGE;
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
    out[i] = Math.max(0, Math.min(255, Math.round(255 - 255 * (d / SDF_RADIUS + cutoff))));
  }
  return out;
}

/** Distance threshold that draws an outline `widthEm` ems outside the glyph edge (as far as the field reaches). */
export function outlineThreshold(widthEm: number): number {
  return Math.max(0.02, SDF_EDGE - (Math.max(0, widthEm) * SDF_EM) / SDF_RADIUS);
}

const fontKey = (f: FontStyle) => `${f.bold ? 'b' : 'n'}|${f.family}`;

/**
 * The glyph atlas shared by everything that draws text. Glyphs are added on first use; when the atlas is full it's
 * cleared and refilled, which bumps `generation` so cached layouts know to rebuild.
 */
export class FontAtlas {
  readonly size = ATLAS_SIZE;
  readonly data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE);
  /** Rows changed since the renderer last uploaded (dirtyMin > dirtyMax when clean). */
  dirtyMin = 0;
  dirtyMax = ATLAS_SIZE - 1;
  generation = 0;
  private rasterizer: GlyphRasterizer | null | undefined = undefined;
  private glyphs = new Map<string, Glyph>();
  private metrics = new Map<string, { ascent: number; descent: number }>();
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;

  /** Replaces the rasterizer (null = none) and clears the atlas. Tests use this to run without a browser. */
  setRasterizer(r: GlyphRasterizer | null): void {
    this.rasterizer = r;
    this.metrics.clear();
    this.clear();
  }

  private getRasterizer(): GlyphRasterizer | null {
    if (this.rasterizer === undefined) this.rasterizer = canvasRasterizer();
    return this.rasterizer;
  }

  get hasRasterizer(): boolean {
    return this.getRasterizer() !== null;
  }

  /** Ascent and descent in ems. */
  fontMetrics(font: FontStyle): { ascent: number; descent: number } {
    const key = fontKey(font);
    let m = this.metrics.get(key);
    if (!m) {
      const r = this.getRasterizer();
      const px = r?.metrics(font, SDF_EM);
      m = px ? { ascent: px.ascent / SDF_EM, descent: px.descent / SDF_EM } : { ascent: 0.8, descent: 0.2 };
      this.metrics.set(key, m);
    }
    return m;
  }

  glyph(char: string, font: FontStyle): Glyph {
    const key = `${fontKey(font)}|${char}`;
    let g = this.glyphs.get(key);
    if (g) return g;
    g = this.addGlyph(char, font);
    this.glyphs.set(key, g);
    return g;
  }

  private clear(): void {
    this.glyphs.clear();
    this.data.fill(0);
    this.shelfX = this.shelfY = this.shelfH = 0;
    this.dirtyMin = 0;
    this.dirtyMax = ATLAS_SIZE - 1;
    this.generation++;
  }

  private addGlyph(char: string, font: FontStyle): Glyph {
    const blank = (advance: number): Glyph => ({ advance, visible: false, x0: 0, y0: 0, x1: 0, y1: 0, u0: 0, v0: 0, u1: 0, v1: 0 });
    const r = this.getRasterizer();
    if (!r) return blank(char === ' ' ? 0.28 : /[\u0000-\u001f]/.test(char) ? 0 : 0.55);
    const bmp = r.glyph(char, font, SDF_EM, SDF_PAD);
    if (!bmp) return blank(0.5);
    const advance = bmp.advance / SDF_EM;
    if (bmp.width === 0 || bmp.height === 0) return blank(advance);
    const { width: w, height: h } = bmp;
    if (this.shelfX + w > ATLAS_SIZE) {
      this.shelfX = 0;
      this.shelfY += this.shelfH + 1;
      this.shelfH = 0;
    }
    if (this.shelfY + h > ATLAS_SIZE) {
      // Full: start over. Glyphs still in use are added again as they're asked for.
      this.clear();
    }
    const x = this.shelfX, y = this.shelfY;
    const sdf = coverageToSDF(bmp.coverage, w, h);
    for (let row = 0; row < h; row++) this.data.set(sdf.subarray(row * w, row * w + w), (y + row) * ATLAS_SIZE + x);
    this.shelfX += w + 1;
    this.shelfH = Math.max(this.shelfH, h);
    this.dirtyMin = Math.min(this.dirtyMin, y);
    this.dirtyMax = Math.max(this.dirtyMax, y + h - 1);
    return {
      advance,
      visible: true,
      x0: -bmp.originX / SDF_EM,
      x1: (w - bmp.originX) / SDF_EM,
      y0: (bmp.originY - h) / SDF_EM,
      y1: bmp.originY / SDF_EM,
      u0: x / ATLAS_SIZE,
      v0: (y + h) / ATLAS_SIZE,
      u1: (x + w) / ATLAS_SIZE,
      v1: y / ATLAS_SIZE,
    };
  }

  /** Marks the atlas uploaded. */
  markClean(): void {
    this.dirtyMin = ATLAS_SIZE;
    this.dirtyMax = -1;
  }
}

/** The atlas every text renderer uses. */
export const fontAtlas = new FontAtlas();

export type TextAlign = 'left' | 'center' | 'right';
export type TextBaseline = 'top' | 'middle' | 'bottom';
export const TEXT_ALIGNS: readonly TextAlign[] = ['left', 'center', 'right'];
export const TEXT_BASELINES: readonly TextBaseline[] = ['top', 'middle', 'bottom'];

export interface TextLayoutOptions extends FontStyle {
  /** Em size in local units. */
  size: number;
  align: TextAlign;
  verticalAlign: TextBaseline;
  /** Line spacing as a multiple of the size. */
  lineHeight: number;
  /** Wraps lines at spaces to fit this width (local units); 0 = no wrapping. */
  maxWidth: number;
}

export interface LaidOutGlyph {
  glyph: Glyph;
  /** Pen position on the baseline, local units, y up. */
  x: number;
  y: number;
}

export interface TextLayout {
  glyphs: LaidOutGlyph[];
  /** Block bounds in local units (y up), around the line boxes. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  lines: number;
}

/**
 * Lays `text` out around the local origin, y up: `align` puts the origin at the left, center or right of each line,
 * `verticalAlign` at the top, middle or bottom of the block. Newlines break lines.
 */
export function layoutText(text: string, o: TextLayoutOptions, atlas: FontAtlas = fontAtlas): TextLayout {
  const font: FontStyle = { family: o.family, bold: o.bold };
  const size = Math.max(0, o.size);
  const { ascent, descent } = atlas.fontMetrics(font);
  const advance = (s: string) => {
    let w = 0;
    for (const ch of s) w += atlas.glyph(ch, font).advance;
    return w;
  };
  const maxEm = o.maxWidth > 0 && size > 0 ? o.maxWidth / size : Infinity;
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    if (maxEm === Infinity) {
      lines.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && advance(next) > maxEm) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  const lh = o.lineHeight;
  const height = (lines.length - 1) * lh + ascent + descent;
  const top = o.verticalAlign === 'top' ? 0 : o.verticalAlign === 'middle' ? height / 2 : height;
  const out: LaidOutGlyph[] = [];
  let minX = Infinity, maxX = -Infinity;
  lines.forEach((line, i) => {
    const w = advance(line);
    let x = o.align === 'left' ? 0 : o.align === 'center' ? -w / 2 : -w;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x + w);
    const y = top - ascent - i * lh;
    for (const ch of line) {
      const glyph = atlas.glyph(ch, font);
      if (glyph.visible) out.push({ glyph, x: x * size, y: y * size });
      x += glyph.advance;
    }
  });
  return { glyphs: out, minX: minX * size, maxX: maxX * size, minY: (top - height) * size, maxY: top * size, lines: lines.length };
}
