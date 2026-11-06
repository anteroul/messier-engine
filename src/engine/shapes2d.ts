import { Component } from './component';
import type { Mat4, Vec4 } from './math';
import { ellipsePoints, rectPoints, regularPolygonPoints, type Batch2D, type Point2 } from './draw2d';
import { fontAtlas, layoutText, TEXT_ALIGNS, TEXT_BASELINES, type TextAlign, type TextBaseline, type TextLayout } from './font';

/**
 * Where a 2D renderer draws. `world`: on its object's local XY plane (facing +Z), in world units, depth tested
 * against the scene. `screen`: over the viewport like a HUD, in CSS pixels from `anchor` with +Y up, ignoring the
 * camera; the object's transform still places, rotates and scales it (its Z is ignored).
 */
export type Space2D = 'world' | 'screen';
export const SPACES_2D: readonly Space2D[] = ['world', 'screen'];

export type Anchor2D = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';
export const ANCHORS_2D: readonly Anchor2D[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

/** Viewport point (CSS pixels, y down) of a screen anchor. */
export function anchorPoint(anchor: Anchor2D, width: number, height: number): [number, number] {
  const x = anchor.endsWith('left') ? 0 : anchor.endsWith('right') ? width : width / 2;
  const y = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? height : height / 2;
  return [x, y];
}

/** Base of the 2D components: Shape2D and Text2D. Colors are display-space RGBA (like CSS), not linear. */
export abstract class Renderer2D extends Component {
  space: Space2D = 'world';
  /** Screen space: the viewport point the object's position is measured from. */
  anchor: Anchor2D = 'center';
  /** Draw order: higher draws on top (within the same space). */
  order = 0;

  /** Appends this renderer's triangles to `batch`, whose matrix is already set to the local → target transform. */
  abstract build(batch: Batch2D): void;

  /** Local-space bounds (x0, y0, x1, y1) of what build() draws. */
  abstract localBounds(): [number, number, number, number];

  /**
   * The local → target matrix: the world matrix in world space; for screen space, the world matrix's XY mapped to
   * viewport pixels from the anchor (y flipped to point down). `out` is overwritten.
   */
  targetMatrix(viewWidth: number, viewHeight: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const w = this.transform.worldMatrix;
    out.set(w);
    if (this.space === 'screen') {
      const [ax, ay] = anchorPoint(this.anchor, viewWidth, viewHeight);
      for (const c of [0, 4, 12]) out[c + 1] = -w[c + 1];
      out[12] += ax;
      out[13] += ay;
      out[2] = out[6] = out[14] = 0;
    }
    return out;
  }
}

export type ShapeKind2D = 'rectangle' | 'ellipse' | 'polygon' | 'path';
export const SHAPE_KINDS_2D: readonly ShapeKind2D[] = ['rectangle', 'ellipse', 'polygon', 'path'];

/** Fields saved with a scene (`points` is saved separately because its length varies). Keep in sync with clone(). */
export const SHAPE2D_FIELDS = [
  'space', 'anchor', 'order', 'shape', 'width', 'height', 'cornerRadius', 'sides', 'closed', 'filled', 'fillColor', 'strokeWidth', 'strokeColor',
] as const;

type Shape2DInit = Partial<Pick<Shape2D, (typeof SHAPE2D_FIELDS)[number] | 'points'>>;

/**
 * A filled and/or outlined 2D shape centered on its object: a (rounded) rectangle, an ellipse, a regular polygon, or a
 * path through `points`.
 */
export class Shape2D extends Renderer2D {
  shape: ShapeKind2D = 'rectangle';
  /** Size in local units (meters in world space, pixels in screen space). */
  width = 1;
  height = 1;
  /** Rectangle: corner radius. */
  cornerRadius = 0;
  /** Polygon: number of sides. */
  sides = 6;
  /** Path: flat list of local x, y coordinates. */
  points: number[] = [];
  /** Path: join the last point back to the first (open paths are only stroked). */
  closed = true;
  filled = true;
  fillColor: Vec4 = [1, 1, 1, 1];
  /** Outline width in local units; 0 = no outline. */
  strokeWidth = 0;
  strokeColor: Vec4 = [0, 0, 0, 1];

  constructor(init: Shape2DInit = {}) {
    super();
    Object.assign(this, init);
  }

  /** The shape's outline in local coordinates. */
  outline(): Point2[] {
    const hw = this.width / 2, hh = this.height / 2;
    switch (this.shape) {
      case 'ellipse':
        return ellipsePoints(0, 0, hw, hh, 64);
      case 'polygon':
        return regularPolygonPoints(0, 0, hw, hh, this.sides);
      case 'path': {
        const pts: Point2[] = [];
        for (let i = 0; i + 1 < this.points.length; i += 2) pts.push([this.points[i], this.points[i + 1]]);
        return pts;
      }
      default:
        return rectPoints(-hw, -hh, hw, hh, this.cornerRadius);
    }
  }

  build(batch: Batch2D): void {
    const pts = this.outline();
    const closed = this.shape !== 'path' || this.closed;
    if (this.filled && closed) {
      if (this.shape === 'path') batch.fillPolygon(pts, this.fillColor);
      else batch.fillConvex(pts, this.fillColor);
    }
    if (this.strokeWidth > 0) batch.stroke(pts, closed, this.strokeWidth, this.strokeColor);
  }

  localBounds(): [number, number, number, number] {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of this.outline()) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (x0 > x1) return [0, 0, 0, 0];
    const s = this.strokeWidth > 0 ? this.strokeWidth / 2 : 0;
    return [x0 - s, y0 - s, x1 + s, y1 + s];
  }
}

/** Fields saved with a scene. Keep in sync with clone(). */
export const TEXT2D_FIELDS = [
  'space', 'anchor', 'order', 'text', 'fontSize', 'fontFamily', 'bold', 'color', 'align', 'verticalAlign', 'lineHeight', 'maxWidth',
  'outlineWidth', 'outlineColor',
] as const;

type Text2DInit = Partial<Pick<Text2D, (typeof TEXT2D_FIELDS)[number]>>;

/** Text drawn with a distance-field font, so it stays sharp at any size. */
export class Text2D extends Renderer2D {
  text = 'Text';
  /** Em size in local units (meters in world space, pixels in screen space). */
  fontSize = 0.5;
  /** CSS font family, e.g. 'sans-serif', 'serif', 'monospace' or 'Georgia, serif'. */
  fontFamily = 'sans-serif';
  bold = false;
  color: Vec4 = [1, 1, 1, 1];
  /** Which side of each line is at the object's origin. */
  align: TextAlign = 'center';
  /** Which side of the text block is at the object's origin. */
  verticalAlign: TextBaseline = 'middle';
  /** Line spacing as a multiple of the font size. */
  lineHeight = 1.2;
  /** Wraps at spaces to fit this width in local units; 0 = no wrapping. */
  maxWidth = 0;
  /** Outline width in local units; 0 = none. Reaches up to about 0.15 × fontSize. */
  outlineWidth = 0;
  outlineColor: Vec4 = [0, 0, 0, 1];

  private _layout: TextLayout | null = null;
  private _layoutKey = '';

  constructor(init: Text2DInit = {}) {
    super();
    Object.assign(this, init);
  }

  /** The current layout, cached until a field that affects it (or the font atlas) changes. */
  layout(): TextLayout {
    const align = TEXT_ALIGNS.includes(this.align) ? this.align : 'left';
    const verticalAlign = TEXT_BASELINES.includes(this.verticalAlign) ? this.verticalAlign : 'top';
    const key = [fontAtlas.generation, this.text, this.fontSize, this.fontFamily, this.bold, align, verticalAlign, this.lineHeight, this.maxWidth].join('\u0001');
    if (!this._layout || key !== this._layoutKey) {
      this._layout = layoutText(String(this.text), {
        size: this.fontSize,
        family: this.fontFamily,
        bold: this.bold,
        align,
        verticalAlign,
        lineHeight: this.lineHeight,
        maxWidth: this.maxWidth,
      });
      this._layoutKey = key;
    }
    return this._layout;
  }

  build(batch: Batch2D): void {
    batch.text(this.layout(), this.fontSize, this.color, this.outlineWidth, this.outlineColor);
  }

  localBounds(): [number, number, number, number] {
    const l = this.layout();
    if (l.minX > l.maxX) return [0, l.minY, 0, l.maxY];
    const o = Math.max(0, this.outlineWidth);
    return [l.minX - o, l.minY - o, l.maxX + o, l.maxY + o];
  }
}
