import { check, eq } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { History } from '@root/src/editor/history.ts';
import { Selection } from '@root/src/editor/selection.ts';
import { ObjectActions, topMost, uniqueName } from '@root/src/editor/objectActions.ts';

const names = (objs: readonly GameObject[]) => objs.map((o) => o.name);
const tree = (o: GameObject): string => (o.children.length ? `${o.name}(${o.children.map(tree).join(',')})` : o.name);
const sceneTree = (s: Scene) => s.root.children.map(tree).join(',');

// ---- selection model
{
  const objs = ['a', 'b', 'c', 'd', 'e'].map((n) => new GameObject(n));
  const [a, b, c, d, e] = objs;
  const sel = new Selection();
  let changes = 0;
  sel.changed.connect(() => changes++);

  sel.set(b);
  check('click selects one', sel.size === 1 && sel.active === b && changes === 1);
  sel.set(b);
  eq('selecting the same again is not a change', changes, 1);
  sel.toggle(d);
  check('ctrl+click adds and makes it active', sel.has(b) && sel.has(d) && sel.active === d);
  sel.toggle(d);
  check('ctrl+click again removes; active falls back', !sel.has(d) && sel.active === b && sel.size === 1);
  sel.toggle(b);
  check('toggling the last one off empties the selection', sel.size === 0 && sel.active === null);

  sel.set(b);
  sel.range(d, objs);
  eq('shift+click selects the visible range', names(sel.items), ['b', 'c', 'd']);
  check('…active is the clicked one', sel.active === d);
  sel.range(a, objs);
  eq('the anchor stays, so a second shift+click re-spans from it', names(sel.items), ['a', 'b']);
  sel.range(e, [a, c, e]);
  eq('an anchor that is not visible falls back to a plain click', names(sel.items), ['e']);

  sel.selectAll(objs);
  check('select all keeps the active object', sel.size === 5 && sel.active === e);
  sel.retain((o) => o !== e && o !== a);
  check('retain drops removed objects and moves active', sel.size === 3 && sel.active === d);
  sel.clear();
  check('clear (Esc, click on empty space)', sel.size === 0 && sel.active === null);
}

// ---- helpers
{
  const s = new Scene();
  const p = s.add(new GameObject('p'));
  const c = p.add(new GameObject('c'));
  const g = c.add(new GameObject('g'));
  const q = s.add(new GameObject('q'));
  eq('topMost keeps only the top-most selected ancestors, in tree order', names(topMost([g, q, c, p])), ['p', 'q']);
  eq('topMost skips detached objects', names(topMost([new GameObject('x'), g])), ['g']);

  const sib = ['Cube', 'Cube (1)', 'Cube (3)', 'Lamp'].map((n) => new GameObject(n));
  eq('unique names', [uniqueName('Cube', sib), uniqueName('Cube (1)', sib), uniqueName('Sphere', sib), uniqueName('Lamp', [])], ['Cube (2)', 'Cube (2)', 'Sphere', 'Lamp']);
}

/** A fresh scene `A(A1,A2), B, C` with its own history, selection and actions. */
function setup() {
  const scene = new Scene();
  const A = scene.add(new GameObject('A'));
  const A1 = A.add(new GameObject('A1'));
  const A2 = A.add(new GameObject('A2'));
  const B = scene.add(new GameObject('B'));
  const C = scene.add(new GameObject('C'));
  const history = new History();
  const selection = new Selection();
  let changed = 0;
  const actions = new ObjectActions({ scene, history, selection, objectsChanged: () => changed++ });
  /** Undo count: how many steps undo can take. */
  const steps = () => {
    let n = 0;
    const undone = [];
    while (history.canUndo) undone.push(history.undo()), n++;
    for (let i = 0; i < n; i++) history.redo();
    return n;
  };
  return { scene, A, A1, A2, B, C, history, selection, actions, steps, changed: () => changed };
}

// ---- delete: top-most only, one undo step, selection restored
{
  const t = setup();
  t.selection.setMany([t.A1, t.A, t.C], t.C);
  t.actions.delete();
  eq('delete removes top-most selected (A takes A1 along)', sceneTree(t.scene), 'B');
  check('…and clears the selection', t.selection.size === 0 && t.changed() > 0);
  t.history.undo();
  eq('undo restores the objects in place', sceneTree(t.scene), 'A(A1,A2),B,C');
  check('…and their selection, active included', t.selection.size === 3 && t.selection.has(t.A1) && t.selection.active === t.C);
  t.history.redo();
  eq('redo deletes again', sceneTree(t.scene), 'B');
  eq('one undo step', t.steps(), 1);
}

// ---- duplicate: after each original, unique names, copies selected
{
  const t = setup();
  t.selection.setMany([t.A, t.A1, t.B]);
  const copies = t.actions.duplicate();
  eq('duplicates go right after their originals', sceneTree(t.scene), 'A(A1,A2),A (1)(A1,A2),B,B (1),C');
  check('copies are deep and independent', copies[0].children.length === 2 && copies[0].children[0] !== t.A1);
  check('copies become the selection', t.selection.size === 2 && t.selection.has(copies[0]) && t.selection.has(copies[1]));
  t.history.undo();
  eq('undo removes the copies', sceneTree(t.scene), 'A(A1,A2),B,C');
  check('…and restores the selection', t.selection.size === 3 && t.selection.has(t.A1));
  t.history.redo();
  eq('redo puts them back', sceneTree(t.scene), 'A(A1,A2),A (1)(A1,A2),B,B (1),C');
  t.selection.set(copies[1]);
  t.actions.duplicate();
  eq('duplicating a copy picks the next free number', names(t.scene.rootObjects), ['A', 'A (1)', 'B', 'B (1)', 'B (2)', 'C']);
  eq('one undo step each', t.steps(), 2);
}

// ---- copy / paste: snapshot isolation, repeatable, sibling or child placement
{
  const t = setup();
  t.selection.setMany([t.A, t.A2]);
  t.actions.copy();
  check('copy is not an undo step', !t.history.canUndo && t.actions.clipboardSize === 1);
  // Edit the original after copying: the clipboard keeps the state at copy time.
  t.A.name = 'Renamed';
  t.A.transform.position[0] = 9;
  t.A.add(new GameObject('Late'));
  t.selection.set(t.B);
  const first = t.actions.paste();
  eq('paste goes after the active object, with the copied state', sceneTree(t.scene), 'Renamed(A1,A2,Late),B,A(A1,A2),C');
  check('…including values', first[0].transform.position[0] === 0 && t.selection.items[0] === first[0]);
  const second = t.actions.paste();
  eq('paste again: a fresh copy with a unique name', names(t.scene.rootObjects), ['Renamed', 'B', 'A', 'A (1)', 'C']);
  check('the two pastes are separate objects', second[0] !== first[0] && second[0].children[0] !== first[0].children[0]);
  t.selection.set(t.C);
  t.actions.paste(true);
  eq('paste as child goes under the active object', tree(t.C), 'C(A(A1,A2))');
  t.selection.clear();
  t.actions.paste();
  eq('paste with nothing selected goes to the end of the root', names(t.scene.rootObjects).at(-1), 'A (2)');
  t.selection.clear();
  check('paste as child needs an active object', t.actions.paste(true).length === 0);
  eq('one undo step per paste', t.steps(), 4);
  while (t.history.canUndo) t.history.undo();
  eq('undoing every paste restores the scene', sceneTree(t.scene), 'Renamed(A1,A2,Late),B,C');
}

// ---- cut: copy + delete as one step
{
  const t = setup();
  t.selection.setMany([t.A2, t.B]);
  t.actions.cut();
  eq('cut removes the selection', sceneTree(t.scene), 'A(A1),C');
  t.selection.set(t.C);
  t.actions.paste();
  eq('pasting a cut keeps the original names (nothing to clash with)', sceneTree(t.scene), 'A(A1),C,A2,B');
  t.history.undo();
  t.history.undo();
  eq('undo paste, then undo cut: back to the start in one step', sceneTree(t.scene), 'A(A1,A2),B,C');
  check('…with the cut selection restored', t.selection.size === 2 && t.selection.has(t.A2) && t.selection.has(t.B));
  t.history.redo();
  eq('redo cut', sceneTree(t.scene), 'A(A1),C');
  check('the clipboard survives undo', t.actions.canPaste);
}

// ---- visibility: checkmark state, mixed → visible, one step
{
  const t = setup();
  check('no selection: no state', t.actions.visibleState() === null);
  t.B.visible = false;
  t.selection.setMany([t.A, t.B, t.C]);
  eq('mixed state', t.actions.visibleState(), 'mixed');
  t.actions.toggleVisible();
  check('clicking a mixed toggle shows all', t.A.visible && t.B.visible && t.C.visible && t.actions.visibleState() === true);
  t.actions.toggleVisible();
  check('all visible: hides all', !t.A.visible && !t.B.visible && !t.C.visible);
  eq('one undo step each', t.steps(), 2);
  t.history.undo();
  t.history.undo();
  check('undo restores each object\'s own value', t.A.visible && !t.B.visible && t.C.visible);
}

// ---- add (Create), one step, selection restored on undo
{
  const t = setup();
  t.selection.set(t.B);
  const made = t.actions.add(new GameObject('Cube'), t.A);
  check('created object goes under the given parent and is selected', made.parent === t.A && t.selection.active === made);
  t.history.undo();
  check('undo removes it and reselects what was selected', made.parent === null && t.selection.active === t.B);
  t.history.redo();
  check('redo adds it back, selected', made.parent === t.A && t.selection.active === made);
}
