import { check, eq, near, throws } from './harness';
import { GameObject, Scene } from '@root/src/engine/scene.ts';
import { Component } from '@root/src/engine/component.ts';
import { Signal } from '@root/src/engine/signal.ts';
import { MeshRenderer } from '@root/src/engine/meshRenderer.ts';
import { Light } from '@root/src/engine/light.ts';
import { CameraComponent } from '@root/src/engine/camera.ts';
import { RigidBody } from '@root/src/engine/physics.ts';
import { Material } from '@root/src/engine/material.ts';
import { createCube } from '@root/src/engine/primitives.ts';

class Health extends Component {
  hp = 10;
  resist: number[] = [1, 2];
  hurt = new Signal<[amount: number]>();
}
class Shield extends Health {
  strength = 3;
}

const names = (list: readonly Component[]) => list.map((c) => c.gameObject.name);

// ---- typed component API
{
  const o = new GameObject('hero');
  const h = o.addComponent(Health, { hp: 25 });
  const s = o.addComponent(Shield);
  check('addComponent applies init', h.hp === 25 && h.gameObject === o && h.transform === o.transform);
  check('getComponent finds the first instance (subclasses count)', o.getComponent(Health) === h && o.getComponent(Shield) === s);
  eq('getComponents returns every instance', o.getComponents(Health).length, 2);
  check('getComponent of a missing type is null', o.getComponent(Light) === null);
  throws('gameObject throws before attach', () => new Health().gameObject, /not attached/);
  throws('attaching twice throws', () => new GameObject().attachComponent(h), /already attached/);

  const child = o.add(new GameObject('child'));
  const grand = child.add(new GameObject('grand'));
  const l = grand.addComponent(Light);
  check('getComponentInChildren searches depth first', o.getComponentInChildren(Light) === l);
  grand.setActive(false);
  check('…skips inactive objects by default', o.getComponentInChildren(Light) === null && o.getComponentInChildren(Light, true) === l);
  check('getComponentInParent walks up', grand.getComponentInParent(Shield) === s && o.getComponentInParent(Light) === null);

  check('find(path) follows child names', o.find('child/grand') === grand && o.find('child/nope') === null && o.find('') === null);
}

// ---- shortcuts stay compatible with the old fields
{
  const o = new GameObject('m');
  const mesh = createCube(1);
  const mat = new Material('m');
  o.castShadows = false;
  o.mesh = mesh;
  o.material = mat;
  const r = o.getComponent(MeshRenderer);
  check('mesh/material shortcuts create one MeshRenderer', r !== null && r.mesh === mesh && r.material === mat && o.components.length === 1);
  check('castShadows set before the renderer existed carries over', r!.castShadows === false && o.castShadows === false);
  o.mesh = null;
  o.material = null;
  check('clearing both removes the renderer', o.getComponent(MeshRenderer) === null && o.castShadows === false);

  const l1 = new Light('spot');
  o.light = l1;
  const l2 = new Light('point');
  o.light = l2;
  check('light shortcut replaces the first light', o.light === l2 && o.getComponents(Light).length === 1 && !l1.attached);
  o.light = null;
  o.camera = new CameraComponent({ priority: 2 });
  o.rigidBody = new RigidBody('static');
  check('camera and rigidBody shortcuts', o.camera?.priority === 2 && o.rigidBody?.type === 'static' && o.light === null);
}

// ---- registry: query() follows enable, active, reparent, scene and destroy
{
  const scene = new Scene();
  const a = scene.add(new GameObject('a'));
  const b = scene.add(new GameObject('b'));
  const loose = new GameObject('loose');
  const ha = a.addComponent(Health);
  const sb = b.addComponent(Shield);
  loose.addComponent(Health);
  eq('query lists live components of a type and its subclasses', names(scene.query(Health)), ['a', 'b']);
  eq('query of a subclass only lists the subclass', names(scene.query(Shield)), ['b']);
  check('detached objects are not listed', !scene.query(Health).some((c) => c.gameObject === loose));

  ha.enabled = false;
  eq('disabled components leave the registry', names(scene.query(Health)), ['b']);
  check('isActiveAndEnabled follows', !ha.isActiveAndEnabled && sb.isActiveAndEnabled);
  ha.enabled = true;

  b.setActive(false);
  eq('inactive objects leave the registry', names(scene.query(Health)), ['a']);
  const kid = b.add(new GameObject('kid'));
  kid.addComponent(Health);
  eq('components added under an inactive parent stay out', names(scene.query(Health)), ['a']);
  check('activeInHierarchy follows the parent', kid.activeSelf && !kid.activeInHierarchy);
  b.setActive(true);
  eq('reactivating lists the subtree again', names(scene.query(Health)).sort(), ['a', 'b', 'kid']);

  scene.add(loose);
  check('adding to the scene registers', scene.query(Health).some((c) => c.gameObject === loose));
  scene.remove(loose);
  check('removing from the scene unregisters', !scene.query(Health).some((c) => c.gameObject === loose));

  const other = new Scene();
  other.add(kid);
  check('moving to another scene moves the registration', other.query(Health).length === 1 && !scene.query(Health).some((c) => c.gameObject === kid));

  GameObject.destroy(sb);
  check('destroying a component unregisters and detaches it', sb.isDestroyed && !sb.attached && !scene.query(Shield).length);
  throws('a destroyed component cannot be attached again', () => b.attachComponent(sb), /destroyed/);
  GameObject.destroy(a);
  check('destroying an object unregisters and detaches it', a.isDestroyed && ha.isDestroyed && a.parent === null && !scene.query(Health).length);

  const det = new Health();
  b.attachComponent(det);
  b.detachComponent(det);
  check('detachComponent keeps the component reusable', !det.isDestroyed && !det.attached && !scene.query(Health).length);
}

// ---- renderer- and physics-facing queries
{
  const scene = new Scene();
  const lit = scene.add(new GameObject('lit'));
  lit.light = new Light('point');
  const cam1 = scene.add(new GameObject('cam1'));
  cam1.camera = new CameraComponent({ priority: 1 });
  const cam2 = scene.add(new GameObject('cam2'));
  cam2.camera = new CameraComponent({ priority: 5 });
  check('activeCamera picks the highest priority', scene.activeCamera() === cam2);
  cam2.visible = false;
  check('…among live cameras only', scene.activeCamera() === cam1);
  cam1.camera!.enabled = false;
  check('…and enabled ones', scene.activeCamera() === null);
  check('visible is an alias of activeSelf', !cam2.activeSelf && cam2.visible === false);
}

// ---- groups
{
  const scene = new Scene();
  const e1 = scene.add(new GameObject('e1'));
  const e2 = new GameObject('e2');
  e1.addToGroup('enemies');
  e2.addToGroup('enemies');
  eq('detached members are not in the scene group', scene.getGroup('enemies').map((o) => o.name), ['e1']);
  scene.add(e2);
  e2.setActive(false);
  eq('joining the scene adds to the group (inactive included)', scene.getGroup('enemies').map((o) => o.name), ['e1', 'e2']);
  e1.removeFromGroup('enemies');
  GameObject.destroy(e2);
  eq('leaving the group or the scene removes it', scene.getGroup('enemies').length, 0);
  check('unknown groups are empty', scene.getGroup('nope').length === 0 && e2.isInGroup('enemies'));
}

// ---- signals
{
  const scene = new Scene();
  const parent = scene.add(new GameObject('p'));
  const added: string[] = [];
  const removed: string[] = [];
  parent.childAdded.connect((c) => added.push(c.name));
  parent.childRemoved.connect((c) => removed.push(c.name));
  const c1 = parent.add(new GameObject('c1'));
  scene.add(c1);
  eq('childAdded / childRemoved', [added, removed], [['c1'], ['c1']]);

  const doomed = parent.add(new GameObject('doomed'));
  const kid = doomed.add(new GameObject('kid'));
  const h = kid.addComponent(Health);
  const gone: string[] = [];
  doomed.destroyed.connect((o) => gone.push(o.name));
  kid.destroyed.connect((o) => gone.push(o.name));
  let ownedCalls = 0;
  parent.childAdded.connect(() => ownedCalls++, h);
  GameObject.destroy(doomed);
  parent.add(new GameObject('after'));
  eq('destroyed fires for the object and its descendants', gone.sort(), ['doomed', 'kid']);
  check('connections owned by destroyed components are dropped', ownedCalls === 0 && h.isDestroyed);
}

// ---- clone and instantiate
{
  const scene = new Scene();
  const holder = scene.add(new GameObject('holder'));
  holder.transform.position = [10, 0, 0];
  const orig = holder.add(new GameObject('orig'));
  orig.transform.position = [1, 2, 3];
  const hp = orig.addComponent(Health, { hp: 7 });
  orig.mesh = createCube(1);
  orig.material = new Material('mat');
  orig.addToGroup('pickups');
  const child = orig.add(new GameObject('child'));
  child.light = new Light('point');

  const copy = GameObject.instantiate(orig);
  const ch = copy.getComponent(Health)!;
  check('instantiate clones components', ch !== hp && ch.hp === 7 && ch.resist !== hp.resist && ch.resist.join() === '1,2');
  hp.hurt.connect(() => {});
  check('signal fields get a fresh signal in the copy', ch.hurt !== hp.hurt && ch.hurt.connectionCount === 0);
  check('meshes are shared, materials copied', copy.mesh === orig.mesh && copy.material !== orig.material && copy.material?.name === 'mat');
  check('children and their components are cloned', copy.children[0]?.light !== null && copy.children[0].light !== child.light);
  check('instantiate puts the copy at the top level of the scene', copy.parent === scene.root);
  near('…where the original is in the world', copy.worldPosition(), [11, 2, 3]);
  eq('groups are copied', scene.getGroup('pickups').length, 2);
  eq('query sees both', scene.query(Light).length, 2);

  const under = GameObject.instantiate(orig, holder);
  check('instantiate under a parent keeps the local transform', under.parent === holder && under.transform.position[0] === 1);
}
