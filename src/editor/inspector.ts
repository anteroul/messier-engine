import {
  BEHAVIOURS,
  Texture,
  createBehaviour,
  hexToLinear,
  hexToRgb,
  linearToHex,
  quat,
  rgbToHex,
  type GameObject,
  type LightType,
  type Vec3,
} from '../engine';
import { button, checkboxRow, colorRow, el, numberRow, section, selectRow, sliderRow, textRow, vec3Row, type Binding } from './ui';
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
    const env = section('Environment');
    const ambientColor = colorRow('Ambient', () => linearToHex(scene.ambientColor), (hex) => (scene.ambientColor = hexToLinear(hex)));
    const ambientI = sliderRow('Ambient ×', () => scene.ambientIntensity, (v) => (scene.ambientIntensity = v), 0, 2, 0.01);
    const bg = colorRow('Background', () => rgbToHex(scene.background), (hex) => (scene.background = hexToRgb(hex)));
    const exposure = sliderRow('Exposure', () => scene.exposure, (v) => (scene.exposure = v), 0.1, 4, 0.05);
    const shadow = numberRow('Shadow extent', () => scene.shadowExtent, (v) => (scene.shadowExtent = v), { step: 1, min: 2, max: 200 });
    const grid = checkboxRow('Show grid', () => engine.showGrid, (v) => (engine.showGrid = v));
    env.body.append(ambientColor.row, ambientI.row, bg.row, exposure.row, shadow.row, grid.row);
    this.add(ambientColor.binding, ambientI.binding, bg.binding, exposure.binding, shadow.binding, grid.binding);

    const info = section('Scene');
    let objects = 0, lights = 0;
    scene.traverse((o) => {
      objects++;
      if (o.light) lights++;
    });
    info.body.append(
      el('p', { class: 'hint', text: `${objects} objects, ${lights} lights.` }),
      el('p', { class: 'hint', text: 'Select an object in the viewport or hierarchy to edit it. Drop .glb / .gltf / .obj files onto the viewport to import.' }),
    );
    return [env.root, info.root];
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

    // --- Behaviours
    const addSelect = el('select', { class: 'add-behaviour' }, [
      el('option', { value: '', text: '+ Add…' }),
      ...Object.keys(BEHAVIOURS).map((k) => el('option', { value: k, text: k })),
    ]);
    addSelect.addEventListener('change', () => {
      if (!addSelect.value) return;
      obj.behaviours.push(createBehaviour(addSelect.value));
      this.refresh();
    });
    const beh = section('Behaviours', addSelect);
    if (obj.behaviours.length === 0) beh.body.append(el('p', { class: 'hint', text: 'No behaviours. Behaviours run in Play mode.' }));
    obj.behaviours.forEach((b, i) => {
      const enabled = el('input', { type: 'checkbox', title: 'Enabled' });
      enabled.checked = b.enabled;
      enabled.addEventListener('change', () => (b.enabled = enabled.checked));
      const header = el('div', { class: 'behaviour-header' }, [
        enabled,
        el('span', { text: b.type }),
        button('✕', () => {
          obj.behaviours.splice(i, 1);
          this.refresh();
        }, 'btn btn-small'),
      ]);
      const box = el('div', { class: 'behaviour' }, [header]);
      for (const key of Object.keys(b.params)) {
        const r = numberRow(key, () => b.params[key], (v) => (b.params[key] = v), { step: 0.1 });
        box.append(r.row);
        this.add(r.binding);
      }
      beh.body.append(box);
    });
    out.push(beh.root);
    return out;
  }
}

function quatEquals(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}
