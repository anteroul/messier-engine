import { check, eq, near } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { Batch2D, Draw2D, VERTEX2D_FLOATS, rectPoints, toColor, triangulate, type Point2 } from '@root/src/engine/draw2d.ts';
import { FontAtlas, SDF_EDGE, SDF_EM, coverageToSDF, fontAtlas, layoutText, outlineThreshold, type GlyphRasterizer } from '@root/src/engine/font.ts';
import { Shape2D, Text2D, anchorPoint } from '@root/src/engine/shapes2d.ts';
import { pickScreen2D, raycastScene, worldBounds } from '@root/src/engine/raycast.ts';
import { applySceneData, serializeScene } from '@root/src/engine/serialize.ts';

/** Every glyph is a solid box 0.5 em wide and 0.7 em tall with a 0.6 em advance; spaces are blank. */
const boxes: GlyphRasterizer = {
  glyph(ch, _font, px, pad) {
    const adv = 0.6 * px;
    if (ch === ' ') return { width: 0, height: 0, coverage: [], originX: 0, originY: 0, advance: adv };
    const w = Math.round(0.5 * px), h = Math.round(0.7 * px);
    const W = w + pad * 2, H = h + pad * 2;
    const cov = new Float32Array(W * H);
    for (let y = pad; y < pad + h; y++) for (let x = pad; x < pad + w; x++) cov[y * W + x] = 1;
    return { width: W, height: H, coverage: cov, originX: pad, originY: pad + h, advance: adv };
  },
  metrics: (_f, px) => ({ ascent: 0.8 * px, descent: 0.2 * px }),
};

/** Sum of triangle areas (positions only) in a batch. */
function area(b: Batch2D): number {
  let a = 0;
  const d = b.data;
  for (let i = 0; i < b.length; i += VERTEX2D_FLOATS * 3) {
    const ax = d[i], ay = d[i + 1], bx = d[i + VERTEX2D_FLOATS], by = d[i + VERTEX2D_FLOATS + 1];
    const cx = d[i + VERTEX2D_FLOATS * 2], cy = d[i + VERTEX2D_FLOATS * 2 + 1];
    a += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  return a;
}

// ---- colors
eq('hex color', toColor('#ff8000'), [1, 128 / 255, 0, 1]);
eq('short hex with alpha', toColor('#f008'), [1, 0, 0, 136 / 255]);
eq('rgb array gets alpha 1', toColor([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3, 1]);
eq('bad hex falls back', toColor('#zz', [0, 0, 0, 1]), [0, 0, 0, 1]);

// ---- tessellation
{
  const b = new Batch2D();
  b.fillConvex(rectPoints(0, 0, 4, 2), [1, 1, 1, 1]);
  near('rect fill area', area(b), 8);
  b.reset();
  b.fillConvex(rectPoints(0, 0, 4, 2, 0.5), [1, 1, 1, 1]);
  near('rounded rect area', area(b), 8 - (4 - Math.PI) * 0.25, 0.01);
  b.reset();
  // An L shape (concave): 3 unit squares.
  const L: Point2[] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  eq('L triangulates into 4 triangles', triangulate(L).length, 12);
  b.fillPolygon(L, [1, 1, 1, 1]);
  near('concave fill area', area(b), 3);
  b.reset();
  // Clockwise input works too.
  b.fillPolygon([...L].reverse(), [1, 1, 1, 1]);
  near('clockwise fill area', area(b), 3);
  b.reset();
  b.stroke(rectPoints(0, 0, 4, 2), true, 0.2, [1, 1, 1, 1]);
  // Ring between a 4.2×2.2 and a 3.8×1.8 rectangle.
  near('closed stroke area', area(b), 4.2 * 2.2 - 3.8 * 1.8, 1e-4);
  b.reset();
  b.stroke([[0, 0], [10, 0]], false, 2, [1, 1, 1, 1]);
  near('open stroke area', area(b), 20, 1e-4);
  b.reset();
  b.fillConvex(rectPoints(0, 0, 1, 1), [1, 1, 1, 0]);
  eq('transparent fill is skipped', b.length, 0);
  b.matrix = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 5, 0, 1, 1]);
  b.triangle([1, 1], [0, 0], [0, 0], [1, 1, 1, 1]);
  near('batch matrix maps points', [b.data[0], b.data[1], b.data[2]], [7, 2, 1]);
}

// ---- distance field
{
  const W = 30;
  const cov = new Float32Array(W * W);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) cov[y * W + x] = 1;
  const sdf = coverageToSDF(cov, W, W);
  const at = (x: number, y: number) => sdf[y * W + x] / 255;
  check('sdf inside above edge', at(15, 15) > SDF_EDGE, String(at(15, 15)));
  check('sdf outside below edge', at(5, 15) < SDF_EDGE && at(0, 0) < at(8, 15), `${at(5, 15)} ${at(0, 0)} ${at(8, 15)}`);
  check('sdf edge near threshold', Math.abs((at(9, 15) + at(10, 15)) / 2 - SDF_EDGE) < 0.06, `${at(9, 15)} ${at(10, 15)}`);
  check('outline threshold below edge', outlineThreshold(0.05) < SDF_EDGE && outlineThreshold(10) === 0.02);
}

// ---- layout
{
  const atlas = new FontAtlas();
  atlas.setRasterizer(null);
  const est = layoutText('ab', { size: 10, family: 'x', bold: false, align: 'left', verticalAlign: 'top', lineHeight: 1.2, maxWidth: 0 }, atlas);
  check('no rasterizer: no glyph quads, estimated width', est.glyphs.length === 0 && est.maxX > 0);

  atlas.setRasterizer(boxes);
  const opts = { size: 10, family: 'sans-serif', bold: false, align: 'left' as const, verticalAlign: 'top' as const, lineHeight: 1.5, maxWidth: 0 };
  const l = layoutText('ab c', opts, atlas);
  eq('glyph quads skip spaces', l.glyphs.length, 3);
  near('line width', [l.minX, l.maxX], [0, 24]);
  near('top-aligned block', [l.maxY, l.minY], [0, -10]);
  near('first baseline', l.glyphs[0].y, -8);
  const g = l.glyphs[0].glyph;
  near('glyph quad (em)', [g.x0, g.x1, g.y1 - g.y0], [-10 / SDF_EM, 24 / SDF_EM + 20 / SDF_EM - 10 / SDF_EM, (34 + 20) / SDF_EM], 1e-6);
  check('glyph uv inside atlas', g.u0 >= 0 && g.u1 <= 1 && g.v1 >= 0 && g.v0 <= 1 && g.u1 > g.u0 && g.v0 > g.v1);
  check('atlas has data', atlas.data.some((v) => v > 0));

  const two = layoutText('ab\ncd', { ...opts, align: 'center', verticalAlign: 'middle' }, atlas);
  eq('two lines', two.lines, 2);
  near('middle-aligned block is centered', two.maxY + two.minY, 0, 1e-6);
  near('center-aligned line', [two.minX, two.maxX], [-6, 6]);
  near('second line one line height lower', two.glyphs[0].y - two.glyphs[2].y, 15);

  const wrapped = layoutText('aa bb cc', { ...opts, maxWidth: 25 }, atlas);
  eq('wraps at spaces', wrapped.lines, 3);
  const right = layoutText('abc', { ...opts, align: 'right', verticalAlign: 'bottom' }, atlas);
  near('right/bottom aligned', [right.maxX, right.minY], [0, 0]);

  const cached = atlas.glyph('a', { family: 'sans-serif', bold: false });
  check('glyphs are cached', cached === g);
  check('bold is a separate glyph', atlas.glyph('a', { family: 'sans-serif', bold: true }) !== g);
}

// ---- components
fontAtlas.setRasterizer(boxes);
{
  const scene = new Scene();
  const panel = new GameObject('Panel');
  const shape = panel.addComponent(Shape2D, { width: 2, height: 1, strokeWidth: 0.2 });
  panel.transform.position = [0, 1, 0];
  scene.add(panel);
  scene.updateMatrices();
  near('shape bounds include the outline', shape.localBounds(), [-1.1, -0.6, 1.1, 0.6]);
  const b = worldBounds(panel)!;
  near('world bounds of a 2D shape', [...b.min, ...b.max], [-1.1, 0.4, 0, 1.1, 1.6, 0]);
  const hit = raycastScene(scene, { origin: [0.5, 1.2, 5], dir: [0, 0, -1] });
  check('raycast hits a world 2D shape', hit?.object === panel && Math.abs(hit.distance - 5) < 1e-6, String(hit?.distance));
  check('raycast misses beside it', raycastScene(scene, { origin: [3, 1, 5], dir: [0, 0, -1] }) === null);

  const tri = new Shape2D({ shape: 'polygon', sides: 3, width: 2, height: 2 });
  near('polygon points up', tri.outline()[0], [0, 1], 1e-9);
  const path = new Shape2D({ shape: 'path', points: [0, 0, 1, 0, 1, 1, 9] });
  eq('path ignores a dangling coordinate', path.outline().length, 3);

  // Screen space: pixels from the anchor, y up.
  eq('anchor points', [anchorPoint('top-left', 800, 600), anchorPoint('center', 800, 600), anchorPoint('bottom-right', 800, 600)], [[0, 0], [400, 300], [800, 600]]);
  const hud = new GameObject('HUD');
  const label = hud.addComponent(Text2D, { space: 'screen', anchor: 'top-right', text: 'abc', fontSize: 20, align: 'right', verticalAlign: 'top' });
  hud.transform.position = [-10, -10, 0];
  scene.add(hud);
  scene.updateMatrices();
  const m = label.targetMatrix(800, 600);
  near('screen matrix places origin from anchor', [m[12], m[13], m[14]], [790, 10, 0]);
  near('screen matrix flips y', [m[0], m[5]], [1, -1]);
  check('pick HUD text', pickScreen2D(scene, 780, 20, 800, 600) === label);
  check('pick misses outside', pickScreen2D(scene, 700, 20, 800, 600) === null);
  check('layout is cached', label.layout() === label.layout());
  const before = label.layout();
  label.text = 'abcd';
  check('layout rebuilds after an edit', label.layout() !== before && label.layout().glyphs.length === 4);

  const copy = hud.clone();
  const t2 = copy.getComponent(Text2D)!;
  check('text clone', t2 !== label && t2.text === 'abcd' && t2.space === 'screen' && t2.color !== label.color);

  // Save and load.
  path.fillColor = [0.1, 0.2, 0.3, 0.4];
  const holder = new GameObject('Path');
  holder.attachComponent(path);
  scene.add(holder);
  const data = serializeScene(scene);
  const loaded = new Scene();
  const warnings: string[] = [];
  applySceneData(loaded, JSON.parse(JSON.stringify(data)), { mesh: () => null, texture: () => null }, warnings);
  eq('2D round trip', JSON.stringify(serializeScene(loaded)) === JSON.stringify(data) && warnings.length === 0, true);
  const lp = loaded.findByName('Path')!.getComponent(Shape2D)!;
  eq('path points saved', lp.points, [0, 0, 1, 0, 1, 1]);
  const lt = loaded.findByName('HUD')!.getComponent(Text2D)!;
  check('text fields saved', lt.text === 'abcd' && lt.anchor === 'top-right' && lt.fontSize === 20);
  const bad = JSON.parse(JSON.stringify(data));
  bad.objects[1].text2d.anchor = 'nowhere';
  bad.objects[1].text2d.align = 7;
  bad.objects[0].shape2d.shape = 'blob';
  const fixed = new Scene();
  applySceneData(fixed, bad, { mesh: () => null, texture: () => null });
  const ft = fixed.findByName('HUD')!.getComponent(Text2D)!;
  check('bad 2D values keep defaults', ft.anchor === 'center' && ft.align === 'center' && fixed.findByName('Panel')!.getComponent(Shape2D)!.shape === 'rectangle');
}

// ---- immediate mode
{
  const d = new Draw2D();
  d.rect(10, 10, 100, 50, { fill: '#ff0000' });
  near('draw2d rect area', area(d.batch), 5000);
  const n = d.batch.length;
  d.rect(0, 0, 10, 10, { stroke: '#fff' });
  check('stroke-only rect has no fill', area(d.batch) - 5000 < 100 && d.batch.length > n);
  d.clear();
  d.text('ab', 100, 50, { size: 10, outlineWidth: 1 });
  eq('text with outline: 2 glyphs twice', d.batch.vertexCount, 24);
  // Glyphs are y up internally, flipped into y-down pixels below the top-left point.
  const ys: number[] = [];
  for (let i = 0; i < d.batch.length; i += VERTEX2D_FLOATS) ys.push(d.batch.data[i + 1]);
  check('text drawn below its top', Math.min(...ys) >= 50 - 3 && Math.max(...ys) <= 50 + 12, `${Math.min(...ys)}..${Math.max(...ys)}`);
  near('measureText', [d.measureText('ab', { size: 10 }).width], [12]);
}
