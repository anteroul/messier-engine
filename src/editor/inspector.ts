import {
  BEHAVIOURS,
  BODY_TYPES,
  COLLIDER_SHAPES,
  DEG2RAD,
  PROJECTIONS,
  RAD2DEG,
  Script,
  Texture,
  createBehaviour,
  fitCollider,
  hexToLinear,
  hexToRgb,
  linearToHex,
  quat,
  rgbToHex,
  vec3,
  type BodyType,
  type ColliderShape,
  type GameObject,
  type LightType,
  type Projection,
  type Vec3,
} from '../engine';
import { button, checkboxRow, colorRow, el, numberRow, row, section, selectRow, sliderRow, textRow, vec3Row, type Binding } from './ui';
import type { Editor } from './editor';

/** Property editor for the selected object (or scene settings when nothing is selected). */
export class InspectorPanel {
  private bindings: Binding[] = [];
  private target: GameObject | null | undefined = undefined;
  /** Cached euler angles so editing one axis doesn't re-normalise the others. */
  private euler: Vec3 = [0, 0, 0];
  private eulerSourceRot = quat.identity();

  constructor(
    private readonly editor: Editor,
    private readonly container: HTMLElement,
  ) {}

  /** Rebuilds the panel for `obj` (null = scene settings). */
  show(obj: GameObject | null, force = false): void {
    if (obj === this.target && !force) return;
    this.target = obj;
    this.bindings = [];
    const sections = obj ? this.buildObject(obj) : this.buildScene();
    this.container.replaceChildren(...sections);
  }

  refresh(): void {
    this.show(this.target ?? null, true);
  }

  /** Pulls live values into the controls. Called every frame. */
  sync(): void {
    for (const b of this.bindings) b.sync();
  }

  private add(...bs: (Binding | Binding[])[]): void {
    for (const b of bs) this.bindings.push(...(Array.isArray(b) ? b : [b]));
  }

  // -------------------------------------------------------------------------

  private buildScene(): HTMLElement[] {
    const scene = this.editor.scene;
    const engine = this.editor.engine;
    const pm = this.editor.project;
    const project = section('Project');
    const projectName = textRow('Name', () => pm.project.name, (v) => pm.renameProject(v));
    const sceneName = textRow('Scene', () => pm.currentScene?.name ?? '', (v) => pm.renameScene(pm.sceneId, v));
    const assets = pm.project.referencedAssets();
    const bytes = assets.reduce((n, a) => n + a.files.reduce((m, f) => m + f.bytes.byteLength, 0), 0);
    project.body.append(
      projectName.row,
      sceneName.row,
      row('', button('New scene', () => void pm.newScene(), 'btn btn-small'), button('Delete scene', () => void pm.deleteScene(pm.sceneId), 'btn btn-small delete-scene')),
      el('p', {
        class: 'hint',
        text: `${pm.project.scenes.length} scene${pm.project.scenes.length === 1 ? '' : 's'}, ${assets.length} imported asset${assets.length === 1 ? '' : 's'} (${formatBytes(bytes)}). ` +
          `Changes autosave in this browser; Save (Ctrl+S) writes a ${pm.fileName} file.`,
      }),
    );
    this.add(projectName.binding, sceneName.binding);
    const env = section('Environment');
    const ambientColor = colorRow('Ambient', () => linearToHex(scene.ambientColor), (hex) => (scene.ambientColor = hexToLinear(hex)));
    const ambientI = sliderRow('Ambient ×', () => scene.ambientIntensity, (v) => (scene.ambientIntensity = v), 0, 2, 0.01);
    const bg = colorRow('Background', () => rgbToHex(scene.background), (hex) => (scene.background = hexToRgb(hex)));
    const exposure = sliderRow('Exposure', () => scene.exposure, (v) => (scene.exposure = v), 0.1, 4, 0.05);
    const shadow = numberRow('Shadow extent', () => scene.shadowExtent, (v) => (scene.shadowExtent = v), { step: 1, min: 2, max: 200 });
    const grid = checkboxRow('Show grid', () => engine.showGrid, (v) => (engine.showGrid = v));
    env.body.append(ambientColor.row, ambientI.row, bg.row, exposure.row, shadow.row, grid.row);
    this.add(ambientColor.binding, ambientI.binding, bg.binding, exposure.binding, shadow.binding, grid.binding);

    const physics = section('Physics');
    const gravity = vec3Row('Gravity', () => scene.physics.gravity, (v) => (scene.physics.gravity = v), { step: 0.1 });
    const iterations = numberRow('Iterations', () => scene.physics.iterations, (v) => (scene.physics.iterations = Math.round(v)), { step: 1, min: 1, max: 50, precision: 0 });
    physics.body.append(gravity.row, iterations.row);
    this.add(gravity.bindings, iterations.binding);

    const info = section('Scene');
    let objects = 0, lights = 0, cameras = 0;
    scene.traverse((o) => {
      objects++;
      if (o.light) lights++;
      if (o.camera) cameras++;
    });
    info.body.append(
      el('p', { class: 'hint', text: `${objects} objects, ${lights} lights, ${cameras} camera${cameras === 1 ? '' : 's'}.` }),
      el('p', { class: 'hint', text: 'Select an object in the viewport or hierarchy to edit it. Drop .glb / .gltf / .obj files onto the viewport to import.' }),
    );
    return [project.root, env.root, physics.root, info.root];
  }

  private buildObject(obj: GameObject): HTMLElement[] {
    const out: HTMLElement[] = [];
    const ed = this.editor;

    // --- Object
    const general = section('Object');
    const name = textRow('Name', () => obj.name, (v) => {
      obj.name = v || 'GameObject';
      ed.hierarchy.markDirty();
    });
    const visible = checkboxRow('Visible', () => obj.visible, (v) => {
      obj.visible = v;
      ed.hierarchy.markDirty();
    });
    general.body.append(name.row, visible.row);
    this.add(name.binding, visible.binding);
    if (obj.mesh) {
      const shadows = checkboxRow('Cast shadows', () => obj.castShadows, (v) => (obj.castShadows = v));
      general.body.append(shadows.row, el('p', { class: 'hint', text: `Mesh: ${obj.mesh.name} — ${obj.mesh.vertexCount} verts, ${obj.mesh.triangleCount} tris` }));
      this.add(shadows.binding);
    }
    out.push(general.root);

    // --- Transform
    const transform = section('Transform', button('Reset', () => ed.resetTransform(obj), 'btn btn-small'));
    const editOpts = { onBegin: () => ed.beginTransformEdit(obj), onCommit: () => ed.commitTransformEdit(obj) };
    const pos = vec3Row('Position', () => obj.transform.position, (v) => (obj.transform.position = v), { step: 0.1, ...editOpts });
    const rot = vec3Row(
      'Rotation',
      () => {
        if (!quatEquals(obj.transform.rotation, this.eulerSourceRot)) {
          this.euler = obj.transform.getEulerDeg();
          this.eulerSourceRot = quat.clone(obj.transform.rotation);
        }
        return this.euler;
      },
      (v) => {
        this.euler = v;
        obj.transform.setEulerDeg(v[0], v[1], v[2]);
        this.eulerSourceRot = quat.clone(obj.transform.rotation);
      },
      { step: 1, precision: 2, ...editOpts },
    );
    const scl = vec3Row('Scale', () => obj.transform.scale, (v) => (obj.transform.scale = v), { step: 0.05, ...editOpts });
    transform.body.append(pos.row, rot.row, scl.row);
    this.add(pos.bindings, rot.bindings, scl.bindings);
    out.push(transform.root);

    // --- Material
    const mat = obj.material;
    if (mat) {
      const s = section('Material');
      const color = colorRow('Base color', () => linearToHex([mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]]), (hex) => {
        const c = hexToLinear(hex);
        mat.baseColor = [c[0], c[1], c[2], mat.baseColor[3]];
      });
      const metallic = sliderRow('Metallic', () => mat.metallic, (v) => (mat.metallic = v), 0, 1);
      const roughness = sliderRow('Roughness', () => mat.roughness, (v) => (mat.roughness = v), 0, 1);
      const emissive = colorRow('Emissive', () => linearToHex(mat.emissive), (hex) => (mat.emissive = hexToLinear(hex)));
      const emissiveStrength = numberRow('Emissive ×', () => mat.emissiveStrength, (v) => (mat.emissiveStrength = v), { step: 0.1, min: 0, max: 100 });
      const unlit = checkboxRow('Unlit', () => mat.unlit, (v) => (mat.unlit = v));
      const doubleSided = checkboxRow('Double sided', () => mat.doubleSided, (v) => (mat.doubleSided = v));

      const texLabel = el('span', { class: 'tex-name', text: mat.baseColorTexture?.name ?? 'none' });
      const texInput = el('input', { type: 'file', accept: 'image/*', hidden: true });
      texInput.addEventListener('change', async () => {
        const file = texInput.files?.[0];
        if (!file) return;
        try {
          mat.baseColorTexture = await Texture.fromBlob(file, file.name);
          texLabel.textContent = file.name;
        } catch (err) {
          ed.notify(`Could not load texture: ${(err as Error).message}`, 'error');
        }
      });
      const texRow = el('div', { class: 'row' }, [
        el('label', { class: 'row-label', text: 'Texture' }),
        el('div', { class: 'row-controls' }, [
          texLabel,
          button('Load…', () => texInput.click(), 'btn btn-small'),
          button('✕', () => {
            mat.baseColorTexture = null;
            texLabel.textContent = 'none';
          }, 'btn btn-small'),
          texInput,
        ]),
      ]);
      s.body.append(
        el('p', { class: 'hint', text: mat.name }),
        color.row, metallic.row, roughness.row, emissive.row, emissiveStrength.row, texRow, unlit.row, doubleSided.row,
      );
      this.add(color.binding, metallic.binding, roughness.binding, emissive.binding, emissiveStrength.binding, unlit.binding, doubleSided.binding);
      out.push(s.root);
    }

    // --- Light
    const light = obj.light;
    if (light) {
      const s = section('Light');
      const type = selectRow('Type', ['directional', 'point', 'spot'], () => light.type, (v) => {
        light.type = v as LightType;
        this.refresh();
      });
      const color = colorRow('Color', () => linearToHex(light.color), (hex) => (light.color = hexToLinear(hex)));
      const intensity = numberRow('Intensity', () => light.intensity, (v) => (light.intensity = v), { step: light.type === 'directional' ? 0.1 : 1, min: 0, max: 10000 });
      s.body.append(type.row, color.row, intensity.row);
      this.add(type.binding, color.binding, intensity.binding);
      if (light.type !== 'directional') {
        const range = numberRow('Range', () => light.range, (v) => (light.range = v), { step: 0.5, min: 0.1, max: 1000 });
        s.body.append(range.row);
        this.add(range.binding);
      }
      if (light.type === 'spot') {
        const inner = sliderRow('Inner angle', () => light.innerAngle, (v) => (light.innerAngle = Math.min(v, light.outerAngle)), 0, 89, 0.5);
        const outer = sliderRow('Outer angle', () => light.outerAngle, (v) => (light.outerAngle = Math.max(v, light.innerAngle)), 1, 89, 0.5);
        s.body.append(inner.row, outer.row);
        this.add(inner.binding, outer.binding);
      }
      if (light.type === 'directional') {
        const shadows = checkboxRow('Cast shadows', () => light.castShadows, (v) => (light.castShadows = v));
        s.body.append(shadows.row, el('p', { class: 'hint', text: 'Only the first shadow-casting directional light renders shadows. Rotate the object to aim it.' }));
        this.add(shadows.binding);
      } else if (light.type === 'spot') {
        s.body.append(el('p', { class: 'hint', text: 'Spot lights shine along the object’s local −Z axis.' }));
      }
      out.push(s.root);
    }

    if (obj.camera) out.push(this.buildCamera(obj));

    out.push(this.buildRigidBody(obj));

    // --- Behaviours
    const scripts = ed.scene.scripts.scripts;
    const addSelect = el('select', { class: 'add-behaviour', 'aria-label': 'Add behaviour' }, [
      el('option', { value: '', text: '+ Add…' }),
      el('optgroup', { label: 'Built-in' }, Object.keys(BEHAVIOURS).map((k) => el('option', { value: `builtin:${k}`, text: k }))),
      el('optgroup', { label: 'Scripts' }, [
        ...scripts.map((sc) => el('option', { value: `script:${sc.id}`, text: `${sc.name}.ts` })),
        el('option', { value: 'new-script', text: '＋ New script…' }),
      ]),
    ]);
    addSelect.addEventListener('change', () => {
      const v = addSelect.value;
      addSelect.value = '';
      if (v.startsWith('builtin:')) ed.addBehaviour(obj, createBehaviour(v.slice(8)));
      else if (v.startsWith('script:')) {
        const asset = scripts.find((sc) => `script:${sc.id}` === v);
        if (asset) ed.addBehaviour(obj, asset.create());
      } else if (v === 'new-script') {
        const asset = ed.createScript(`${obj.name} Script`);
        ed.addBehaviour(obj, asset.create());
        ed.setView('scripts', asset);
      }
    });
    const beh = section('Behaviours', addSelect);
    if (obj.behaviours.length === 0) beh.body.append(el('p', { class: 'hint', text: 'No behaviours. Behaviours run in Play mode; scripts are written in the Scripts tab.' }));
    for (const b of obj.behaviours) {
      const enabled = el('input', { type: 'checkbox', title: 'Enabled' });
      enabled.checked = b.enabled;
      enabled.addEventListener('change', () => (b.enabled = enabled.checked));
      const asset = b instanceof Script ? b.asset : null;
      const header = el('div', { class: 'behaviour-header' }, [
        enabled,
        el('span', { class: asset ? 'behaviour-script' : undefined, text: asset ? `${b.typeName}.ts` : b.typeName }),
        asset ? button('Edit', () => ed.setView('scripts', asset), 'btn btn-small edit-script') : null,
        button('✕', () => ed.removeBehaviour(obj, b), 'btn btn-small'),
      ]);
      const box = el('div', { class: 'behaviour' }, [header]);
      for (const key of Object.keys(b.params)) {
        const r = numberRow(key, () => b.params[key], (v) => (b.params[key] = v), { step: 0.1 });
        box.append(r.row);
        this.add(r.binding);
      }
      if (b instanceof Script && asset) {
        const status = el('p', { class: 'hint behaviour-status' });
        this.add({
          sync: () => {
            const a = asset;
            const compile = a.compileError;
            let text = '', cls = 'hint behaviour-status';
            if (b.error) {
              text = `Paused: ${b.error.message}${b.error.line ? ` (line ${b.error.line})` : ''}`;
              cls += ' status-error';
            } else if (compile && !a.ctor) {
              text = `Doesn’t compile: ${compile.message}`;
              cls += ' status-error';
            } else if (compile) {
              text = 'Has compile errors; running the last version that compiled.';
              cls += ' status-warning';
            } else if (Object.keys(b.params).length === 0) text = 'No public number fields.';
            if (status.textContent !== text) status.textContent = text;
            if (status.className !== cls) status.className = cls;
            status.hidden = !text;
          },
        });
        box.append(status);
      }
      beh.body.append(box);
    }
    out.push(beh.root);
    return out;
  }

  private buildCamera(obj: GameObject): HTMLElement {
    const ed = this.editor;
    const cam = obj.camera!;
    const s = section('Camera', button('Align to view', () => ed.alignToView(obj), 'btn btn-small align-camera'));
    const projection = selectRow('Projection', [...PROJECTIONS], () => cam.projection, (v) => {
      cam.projection = v as Projection;
      this.refresh();
    });
    s.body.append(projection.row);
    this.add(projection.binding);
    if (cam.projection === 'perspective') {
      const fov = sliderRow('Field of view', () => cam.fovDeg, (v) => (cam.fovDeg = v), 5, 150, 0.5);
      s.body.append(fov.row);
      this.add(fov.binding);
    } else {
      const size = numberRow('Size', () => cam.orthoSize, (v) => (cam.orthoSize = v), { step: 0.1, min: 0.01, max: 10000 });
      s.body.append(size.row);
      this.add(size.binding);
    }
    const near = numberRow('Near', () => cam.near, (v) => (cam.near = Math.min(v, cam.far * 0.999)), { step: 0.01, min: 0.001, max: 10000, precision: 3 });
    const far = numberRow('Far', () => cam.far, (v) => (cam.far = Math.max(v, cam.near * 1.001)), { step: 1, min: 0.01, max: 100000 });
    const priority = numberRow('Priority', () => cam.priority, (v) => (cam.priority = Math.round(v)), { step: 1, min: -1000, max: 1000, precision: 0 });
    s.body.append(near.row, far.row, priority.row);
    this.add(near.binding, far.binding, priority.binding);
    const state = el('p', { class: 'hint camera-status' });
    this.add({
      sync: () => {
        const active = ed.scene.activeCamera();
        const text =
          active === obj
            ? 'Active camera: Play renders through it. Press C (or 🎥 Camera) to look through it now.'
            : active
              ? `Inactive: ${active.name} is the active camera. The visible camera with the highest priority is used.`
              : 'Inactive: the object is hidden.';
        if (state.textContent !== text) state.textContent = text;
      },
    });
    s.body.append(state, el('p', { class: 'hint', text: 'Cameras look along the object’s local −Z axis, with local +Y up.' }));
    return s.root;
  }

  private buildRigidBody(obj: GameObject): HTMLElement {
    const ed = this.editor;
    const rb = obj.rigidBody;
    const s = section(
      'Rigid Body',
      rb ? button('✕', () => ed.removeRigidBody(obj), 'btn btn-small') : button('Add', () => ed.addRigidBody(obj), 'btn btn-small add-rigidbody'),
    );
    if (!rb) {
      s.body.append(el('p', { class: 'hint', text: 'No rigid body. Add one to collide and (if dynamic) fall in Play mode.' }));
      return s.root;
    }
    const type = selectRow('Type', [...BODY_TYPES], () => rb.type, (v) => {
      rb.type = v as BodyType;
      this.refresh();
    });
    const shape = selectRow('Collider', [...COLLIDER_SHAPES], () => rb.shape, (v) => {
      rb.shape = v as ColliderShape;
      this.refresh();
    });
    const fit = row('', button('Fit to mesh', () => fitCollider(rb, obj.mesh), 'btn btn-small'));
    const center = vec3Row('Center', () => rb.center, (v) => (rb.center = v), { step: 0.05 });
    s.body.append(type.row, shape.row, center.row);
    this.add(type.binding, shape.binding, center.bindings);
    if (rb.shape === 'box') {
      const size = vec3Row('Size', () => vec3.scale(rb.halfExtents, 2), (v) => (rb.halfExtents = vec3.max(vec3.scale(v, 0.5), [1e-3, 1e-3, 1e-3])), { step: 0.05 });
      s.body.append(size.row);
      this.add(size.bindings);
    } else {
      const radius = numberRow('Radius', () => rb.radius, (v) => (rb.radius = v), { step: 0.05, min: 1e-3 });
      s.body.append(radius.row);
      this.add(radius.binding);
    }
    s.body.append(fit);

    const friction = sliderRow('Friction', () => rb.friction, (v) => (rb.friction = v), 0, 1);
    const restitution = sliderRow('Bounciness', () => rb.restitution, (v) => (rb.restitution = v), 0, 1);
    s.body.append(friction.row, restitution.row);
    this.add(friction.binding, restitution.binding);

    if (rb.type === 'dynamic') {
      const mass = numberRow('Mass', () => rb.mass, (v) => (rb.mass = v), { step: 0.1, min: 0.01, max: 1e6 });
      const gravity = checkboxRow('Use gravity', () => rb.useGravity, (v) => (rb.useGravity = v));
      const linDamp = numberRow('Linear damping', () => rb.linearDamping, (v) => (rb.linearDamping = v), { step: 0.01, min: 0, max: 100 });
      const angDamp = numberRow('Angular damping', () => rb.angularDamping, (v) => (rb.angularDamping = v), { step: 0.01, min: 0, max: 100 });
      const vel = vec3Row('Velocity', () => rb.velocity, (v) => {
        rb.velocity = v;
        rb.wake();
      }, { step: 0.1 });
      const angVel = vec3Row('Spin °/s', () => vec3.scale(rb.angularVelocity, RAD2DEG), (v) => {
        rb.angularVelocity = vec3.scale(v, DEG2RAD);
        rb.wake();
      }, { step: 5, precision: 1 });
      s.body.append(mass.row, gravity.row, linDamp.row, angDamp.row, vel.row, angVel.row);
      this.add(mass.binding, gravity.binding, linDamp.binding, angDamp.binding, vel.bindings, angVel.bindings);
      const state = el('p', { class: 'hint' });
      this.add({
        sync: () => {
          const text = ed.engine.playing ? (rb.sleeping ? 'Sleeping (at rest).' : 'Simulating.') : 'Velocities set here are the initial velocities for Play.';
          if (state.textContent !== text) state.textContent = text;
        },
      });
      s.body.append(state);
    } else {
      s.body.append(el('p', {
        class: 'hint',
        text: rb.type === 'static' ? 'Static bodies never move but block dynamic ones.' : 'Kinematic bodies follow their transform (move them with behaviours) and push dynamic bodies.',
      }));
    }
    return s.root;
  }
}

function quatEquals(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function formatBytes(n: number): string {
  return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`;
}
