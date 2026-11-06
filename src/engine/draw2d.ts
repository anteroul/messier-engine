import type { Mat4, Vec3, Vec4 } from './math';
import { fontAtlas, layoutText, outlineThreshold, SDF_EDGE, type FontAtlas, type TextAlign, type TextBaseline, type TextLayout } from './font';

// CPU tessellation of 2D shapes and text into one vertex stream, plus the immediate-mode `draw2d` API for HUDs.
// Shapes are filled and stroked as triangles (the main pass's MSAA smooths their edges); glyphs are quads that sample
// the font atlas's distance field.

/** Floats per 2D vertex: position(3) + uv(2) + color(4) + threshold(1). Threshold < 0 = solid, else SDF edge. */
export const VERTEX2D_FLOATS = 10;

export type Point2 = readonly [number, number];

/**
 * A color for 2D drawing: display-space RGB(A) 0…1 (like CSS colors, not linear like materials), or a CSS hex string
 * ('#rgb', '#rrggbb', '#rrggbbaa').
 */
export type Color2D = Readonly<Vec4> | Readonly<Vec3> | string;

export function toColor(c: Color2D | undefined, fallback: Readonly<Vec4> = [1, 1, 1, 1]): Vec4 {
  if (c === undefined) return [...fallback] as Vec4;
  if (typeof c !== 'string') return [c[0], c[1], c[2], c.length > 3 ? (c as Vec4)[3] : 1];
  let h = c.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
  const v = parseInt(h, 16);
  if (!/^[0-9a-f]+$/i.test(h) || (h.length !== 6 && h.length !== 8)) return [...fallback] as Vec4;
  if (h.length === 6) return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1];
  return [((v >>> 24) & 255) / 255, ((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

// ---- outlines --------------------------------------------------------------------------------------------------

/** Rectangle outline, optionally with rounded corners (radius clamped to half the shorter side). */
export function rectPoints(x0: number, y0: number, x1: number, y1: number, radius = 0, cornerSegments = 8): Point2[] {
  const r = Math.max(0, Math.min(radius, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2));
  const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
  if (r <= 0) return [[lx, ly], [hx, ly], [hx, hy], [lx, hy]];
  const pts: Point2[] = [];
  const corners: [number, number, number][] = [[hx - r, ly + r, -90], [hx - r, hy - r, 0], [lx + r, hy - r, 90], [lx + r, ly + r, 180]];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= cornerSegments; i++) {
      const a = ((start + (90 * i) / cornerSegments) * Math.PI) / 180;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

export function ellipsePoints(cx: number, cy: number, rx: number, ry: number, segments = 64): Point2[] {
  const pts: Point2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

/** Regular polygon inscribed in the ellipse, with a vertex pointing up (+y). */
export function regularPolygonPoints(cx: number, cy: number, rx: number, ry: number, sides: number): Point2[] {
  const n = Math.max(3, Math.min(256, Math.round(sides)));
  const pts: Point2[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

function signedArea(pts: readonly Point2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

/** Triangle indices of a simple polygon (convex or not) by ear clipping. Degenerate input gives fewer triangles. */
export function triangulate(pts: readonly Point2[]): number[] {
  const n = pts.length;
  const out: number[] = [];
  if (n < 3) return out;
  const idx = Array.from({ length: n }, (_, i) => i);
  if (signedArea(pts) < 0) idx.reverse();
  const cross = (a: Point2, b: Point2, c: Point2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p: Point2, a: Point2, b: Point2, c: Point2) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = n * n;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      const cr = cross(a, b, c);
      if (cr < 0) continue;
      if (cr === 0) {
        // Collinear: drop the middle point.
        idx.splice(i, 1);
        clipped = true;
        break;
      }
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inside(pts[j], a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // self-intersecting: give up on the rest
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

// ---- batch -----------------------------------------------------------------------------------------------------

/**
 * Growable 2D vertex stream. Points are given in a local 2D frame and mapped through `matrix` (local x, y, 0 → the
 * batch's target space: world units for world-space batches, CSS pixels with y down for screen-space ones).
 */
export class Batch2D {
  data = new Float32Array(4096);
  length = 0;
  /** Local → target transform, column-major; null = identity. */
  matrix: Mat4 | null = null;

  get vertexCount(): number {
    return this.length / VERTEX2D_FLOATS;
  }

  reset(): void {
    this.length = 0;
    this.matrix = null;
  }

  private reserve(floats: number): void {
    if (this.length + floats <= this.data.length) return;
    let cap = this.data.length;
    while (cap < this.length + floats) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  private vertex(x: number, y: number, u: number, v: number, c: Readonly<Vec4>, t: number): void {
    const m = this.matrix, d = this.data;
    let o = this.length;
    if (m) {
      d[o++] = m[0] * x + m[4] * y + m[12];
      d[o++] = m[1] * x + m[5] * y + m[13];
      d[o++] = m[2] * x + m[6] * y + m[14];
    } else {
      d[o++] = x;
      d[o++] = y;
      d[o++] = 0;
    }
    d[o++] = u;
    d[o++] = v;
    d[o++] = c[0];
    d[o++] = c[1];
    d[o++] = c[2];
    d[o++] = c[3];
    d[o++] = t;
    this.length = o;
  }

  triangle(a: Point2, b: Point2, c: Point2, color: Readonly<Vec4>): void {
    this.reserve(3 * VERTEX2D_FLOATS);
    this.vertex(a[0], a[1], 0, 0, color, -1);
    this.vertex(b[0], b[1], 0, 0, color, -1);
    this.vertex(c[0], c[1], 0, 0, color, -1);
  }

  /** Fills a convex polygon as a fan. */
  fillConvex(pts: readonly Point2[], color: Readonly<Vec4>): void {
    if (color[3] <= 0) return;
    for (let i = 1; i < pts.length - 1; i++) this.triangle(pts[0], pts[i], pts[i + 1], color);
  }

  /** Fills any simple polygon (concave too). */
  fillPolygon(pts: readonly Point2[], color: Readonly<Vec4>): void {
    if (color[3] <= 0) return;
    const tris = triangulate(pts);
    for (let i = 0; i < tris.length; i += 3) this.triangle(pts[tris[i]], pts[tris[i + 1]], pts[tris[i + 2]], color);
  }

  /** Strokes a polyline `width` wide, centered on it, with mitered joins (beveled past 4× the width) and butt ends. */
  stroke(input: readonly Point2[], closed: boolean, width: number, color: Readonly<Vec4>): void {
    if (width <= 0 || color[3] <= 0) return;
    // Drop repeated points, which have no direction.
    const pts: Point2[] = [];
    for (const p of input) {
      const q = pts[pts.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) pts.push(p);
    }
    if (closed && pts.length > 2) {
      const a = pts[0], b = pts[pts.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9) pts.pop();
    }
    const n = pts.length;
    if (n < 2) return;
    const hw = width / 2;
    const normal = (a: Point2, b: Point2): [number, number] => {
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
      return [-dy / l, dx / l];
    };
    // Offset of each vertex's left (+) side.
    const offsets: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
      const n0 = hasPrev ? normal(pts[(i - 1 + n) % n], pts[i]) : null;
      const n1 = hasNext ? normal(pts[i], pts[(i + 1) % n]) : null;
      if (!n0 || !n1) {
        const nn = (n0 ?? n1)!;
        offsets.push([nn[0] * hw, nn[1] * hw]);
        continue;
      }
      let mx = n0[0] + n1[0], my = n0[1] + n1[1];
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) {
        offsets.push([n1[0] * hw, n1[1] * hw]);
        continue;
      }
      mx /= ml;
      my /= ml;
      const cos = mx * n1[0] + my * n1[1];
      const scale = Math.min(hw / Math.max(cos, 1e-6), hw * 4);
      offsets.push([mx * scale, my * scale]);
    }
    const segments = closed ? n : n - 1;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % n;
      const a = pts[i], b = pts[j], oa = offsets[i], ob = offsets[j];
      const al: Point2 = [a[0] + oa[0], a[1] + oa[1]], ar: Point2 = [a[0] - oa[0], a[1] - oa[1]];
      const bl: Point2 = [b[0] + ob[0], b[1] + ob[1]], br: Point2 = [b[0] - ob[0], b[1] - ob[1]];
      this.triangle(al, ar, br, color);
      this.triangle(al, br, bl, color);
    }
  }

  /** Glyph quads of a layout. `threshold` is the distance-field edge (SDF_EDGE for the glyph itself). */
  glyphs(layout: TextLayout, size: number, color: Readonly<Vec4>, threshold = SDF_EDGE): void {
    if (color[3] <= 0 || size <= 0) return;
    this.reserve(layout.glyphs.length * 6 * VERTEX2D_FLOATS);
    for (const { glyph: g, x, y } of layout.glyphs) {
      const x0 = x + g.x0 * size, x1 = x + g.x1 * size, y0 = y + g.y0 * size, y1 = y + g.y1 * size;
      this.vertex(x0, y0, g.u0, g.v0, color, threshold);
      this.vertex(x1, y0, g.u1, g.v0, color, threshold);
      this.vertex(x1, y1, g.u1, g.v1, color, threshold);
      this.vertex(x0, y0, g.u0, g.v0, color, threshold);
      this.vertex(x1, y1, g.u1, g.v1, color, threshold);
      this.vertex(x0, y1, g.u0, g.v1, color, threshold);
    }
  }

  /** Text with an optional outline (drawn first, `outlineWidth` in local units). */
  text(layout: TextLayout, size: number, color: Readonly<Vec4>, outlineWidth = 0, outlineColor: Readonly<Vec4> = [0, 0, 0, 1]): void {
    if (outlineWidth > 0 && size > 0) this.glyphs(layout, size, outlineColor, outlineThreshold(outlineWidth / size));
    this.glyphs(layout, size, color);
  }
}

// ---- immediate mode --------------------------------------------------------------------------------------------

export interface ShapeStyle2D {
  /** Fill color; omit for no fill (a stroke-only shape). Defaults to white when there's no stroke either. */
  fill?: Color2D;
  stroke?: Color2D;
  /** Outline width in pixels (default 1 when `stroke` is set). */
  strokeWidth?: number;
}

export interface TextStyle2D {
  /** Pixels per em (default 16). */
  size?: number;
  color?: Color2D;
  font?: string;
  bold?: boolean;
  /** Which side of the text `x` is at (default 'left'). */
  align?: TextAlign;
  /** Which side of the text `y` is at (default 'top'). */
  baseline?: TextBaseline;
  lineHeight?: number;
  maxWidth?: number;
  outlineWidth?: number;
  outlineColor?: Color2D;
}

/**
 * Immediate-mode 2D drawing on top of the frame, for HUDs and debug drawing from scripts. Coordinates are CSS pixels
 * from the viewport's top-left corner, y down. Everything drawn during a frame (in update, lateUpdate…) is shown in
 * that frame and then cleared, so draw again every frame.
 */
export class Draw2D {
  readonly batch = new Batch2D();
  /** Viewport size in CSS pixels, as of the last rendered frame. */
  width = 0;
  height = 0;
  private readonly flip = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  constructor(private readonly atlas: FontAtlas = fontAtlas) {}

  /** Drops everything drawn so far this frame (the engine does this after each frame). */
  clear(): void {
    this.batch.reset();
  }

  private shape(pts: Point2[], style: ShapeStyle2D, convex: boolean): void {
    const b = this.batch;
    b.matrix = null;
    const fill = style.fill !== undefined || style.stroke === undefined ? toColor(style.fill) : null;
    if (fill) convex ? b.fillConvex(pts, fill) : b.fillPolygon(pts, fill);
    if (style.stroke !== undefined) b.stroke(pts, true, style.strokeWidth ?? 1, toColor(style.stroke));
  }

  rect(x: number, y: number, width: number, height: number, style: ShapeStyle2D = {}, radius = 0): void {
    this.shape(rectPoints(x, y, x + width, y + height, radius), style, true);
  }

  circle(cx: number, cy: number, radius: number, style: ShapeStyle2D = {}): void {
    this.ellipse(cx, cy, radius, radius, style);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, style: ShapeStyle2D = {}): void {
    const segments = Math.max(12, Math.min(128, Math.ceil(Math.max(rx, ry) * 0.75)));
    this.shape(ellipsePoints(cx, cy, rx, ry, segments), style, true);
  }

  /** Any simple polygon, given as [x, y] points. */
  polygon(points: readonly Point2[], style: ShapeStyle2D = {}): void {
    this.shape([...points], style, false);
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Color2D = '#fff', width = 1): void {
    this.polyline([[x1, y1], [x2, y2]], color, width);
  }

  polyline(points: readonly Point2[], color: Color2D = '#fff', width = 1, closed = false): void {
    this.batch.matrix = null;
    this.batch.stroke(points, closed, width, toColor(color));
  }

  private layout(str: string, s: TextStyle2D): TextLayout {
    return layoutText(
      str,
      {
        size: s.size ?? 16,
        family: s.font ?? 'sans-serif',
        bold: s.bold ?? false,
        align: s.align ?? 'left',
        verticalAlign: s.baseline ?? 'top',
        lineHeight: s.lineHeight ?? 1.2,
        maxWidth: s.maxWidth ?? 0,
      },
      this.atlas,
    );
  }

  text(str: string, x: number, y: number, style: TextStyle2D = {}): void {
    const layout = this.layout(String(str), style);
    const f = this.flip;
    f[12] = x;
    f[13] = y;
    this.batch.matrix = f;
    this.batch.text(layout, style.size ?? 16, toColor(style.color), style.outlineWidth ?? 0, toColor(style.outlineColor, [0, 0, 0, 1]));
    this.batch.matrix = null;
  }

  /** Size in pixels that text() would cover. */
  measureText(str: string, style: TextStyle2D = {}): { width: number; height: number } {
    const l = this.layout(String(str), style);
    return { width: Math.max(0, l.maxX - l.minX), height: l.maxY - l.minY };
  }
}

/** The engine's immediate-mode 2D layer (drawn over the frame, cleared after it). */
export const draw2d = new Draw2D();
