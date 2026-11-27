import {
  AudioClip,
  AudioSource,
  SFX_PRESETS,
  audio,
  mutateSfx,
  packSfx,
  type SfxPresetName,
  BEHAVIOURS,
  BODY_TYPES,
  ANCHORS_2D,
  COLLIDER_SHAPES,
  SHAPE_KINDS_2D,
  SPACES_2D,
  Shape2D,
  TEXT_ALIGNS,
  TEXT_BASELINES,
  Text2D,
  type Anchor2D,
  type ShapeKind2D,
  type Space2D,
  type TextAlign,
  type TextBaseline,
  type TextureSlot,
  BLEND_MODES,
  type BlendMode,
  DEG2RAD,
  PROJECTIONS,
  RAD2DEG,
  Script,
  SKY_MODES,
  type SkyMode,
  createBehaviour,
  fitCollider,
  hexToLinear,
  hexToRgb,
  linearToHex,
  quat,
  rgbToHex,
  vec3,
  type AudioVoice,
  type BodyType,
  type ColliderShape,
  type GameObject,
  type LightType,
  type Projection,
  type Vec3,
} from '../engine';
import {
  button, checkboxRow, colorRow, el, numberRow, rgbaRow, row, section, selectRow, sliderRow, textAreaRow, textRow, vec3Row, type Binding,
} from './ui';
import type { Editor } from './editor';
import { canPickFolders } from './folderIO';

/** Property editor for the selected object (or scene settings when nothing is selected). */
export class InspectorPanel {
  private bindings: Binding[] = [];
  private target: GameObject | null | undefined = undefined;
  /** Cached euler angles so editing one axis doesn't re-normalise the others. */
  private euler: Vec3 = [0, 0, 0];
  private eulerSourceRot = quat.identity();
  private previewVoice: AudioVoice | null = null;

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
          (pm.folderName
            ? `Saved in the folder ${pm.folderName} as you work. Files added to its assets/ folder show up in Assets.`
            : 'Kept in this browser as you work. Save (Ctrl+S) to put it in a project folder' +
              (canPickFolders() ? '.' : ': this browser can\'t write folders, so it downloads a .zip of one.')),
      }),
    );
    this.add(projectName.binding, sceneName.binding);
    const env = section('Environment');
    const exposure = sliderRow('Exposure', () => scene.exposure, (v) => (scene.exposure = v), 0.1, 4, 0.05);
    const shadow = numberRow('Shadows to', () => scene.shadowDistance, (v) => (scene.shadowDistance = v), { step: 5, min: 1, max: 2000 });
    const cascades = sliderRow('Cascades', () => scene.shadowCascades, (v) => (scene.shadowCascades = v), 1, 4, 1);
    const grid = checkboxRow('Show grid', () => engine.showGrid, (v) => (engine.showGrid = v));
    env.body.append(exposure.row, shadow.row, cascades.row, grid.row);
    this.add(exposure.binding, shadow.binding, cascades.binding, grid.binding);
    const skySection = this.buildSky();

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
    return [project.root, skySection, env.root, physics.root, info.root];
  }

  /** Sky and ambient light: the rows depend on the sky mode. */
  private buildSky(): HTMLElement {
    const ed = this.editor;
    const sky = ed.scene.sky;
    const scene = ed.scene;
    const s = section('Sky');
    const mode = selectRow('Sky', [...SKY_MODES], () => sky.mode, (v) => {
      sky.mode = v as SkyMode;
      this.refresh();
    });
    mode.row.querySelector('select')?.classList.add('sky-mode');
    s.body.append(mode.row);
    this.add(mode.binding);
    const rows = (...items: { row: HTMLElement; binding?: Binding; bindings?: Binding[] }[]) => {
      for (const r of items) {
        s.body.append(r.row);
        this.add(r.binding ?? [], r.bindings ?? []);
      }
    };
    const lighting = sliderRow('Sky light ×', () => sky.lighting, (v) => (sky.lighting = v), 0, 3, 0.01);
    if (sky.mode === 'color') {
      rows(
        colorRow('Background', () => rgbToHex(scene.background), (hex) => (scene.background = hexToRgb(hex))),
        colorRow('Ambient', () => linearToHex(scene.ambientColor), (hex) => (scene.ambientColor = hexToLinear(hex))),
        sliderRow('Ambient ×', () => scene.ambientIntensity, (v) => (scene.ambientIntensity = v), 0, 2, 0.01),
      );
      s.body.append(el('p', { class: 'hint', text: 'A flat background. A gradient or image sky also lights the scene: metals reflect it.' }));
    } else if (sky.mode === 'gradient') {
      rows(
        colorRow('Top', () => linearToHex(sky.top), (hex) => (sky.top = hexToLinear(hex))),
        colorRow('Horizon', () => linearToHex(sky.horizon), (hex) => (sky.horizon = hexToLinear(hex))),
        colorRow('Ground', () => linearToHex(sky.ground), (hex) => (sky.ground = hexToLinear(hex))),
        sliderRow('Sun size', () => sky.sunSize, (v) => (sky.sunSize = v), 0, 10, 0.1),
        sliderRow('Sun glow', () => sky.sunGlow, (v) => (sky.sunGlow = v), 0, 2, 0.01),
        lighting,
      );
      s.body.append(el('p', { class: 'hint', text: 'The sun sits opposite the shadow-casting (or first) directional light, in its color. Rotate the light to move it.' }));
    } else {
      const name = el('span', { class: 'tex-name sky-image-name', text: sky.texture?.name ?? 'none' });
      const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.value = '';
        const texture = file ? await ed.importImage(file) : null;
        if (texture) ed.setSkyImage(texture);
      });
      s.body.append(el('div', { class: 'row' }, [
        el('label', { class: 'row-label', text: 'Image' }),
        el('div', { class: 'row-controls' }, [name, button('Load…', () => input.click(), 'btn btn-small sky-load'), input]),
      ]));
      rows(
        sliderRow('Rotation', () => sky.rotation, (v) => (sky.rotation = v), 0, 360, 1),
        numberRow('Brightness', () => sky.intensity, (v) => (sky.intensity = v), { step: 0.05, min: 0, max: 100 }),
        lighting,
      );
      s.body.append(el('p', {
        class: 'hint',
        text: sky.texture
          ? 'An equirectangular (2:1) panorama. Drop one on the viewport to replace it.'
          : 'No image yet: Load… an equirectangular (2:1) panorama or drop one on the viewport. Until then the gradient shows.',
      }));
    }
    return s.root;
  }

  private buildObject(obj: GameObject): HTMLElement[] {
    const out: HTMLElement[] = [];
    const ed = this.editor;
    const prefab = this.buildPrefab(obj);
    if (prefab) out.push(prefab);

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
      const blend = selectRow('Blend', [...BLEND_MODES], () => mat.blend, (v) => {
        mat.blend = v as BlendMode;
        this.refresh();
      });

      // Each texture slot: Load… imports an image as a project asset (so the scene saves with it); setTexture rebuilds the panel.
      const texRow = (label: string, slot: TextureSlot) => {
        const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          if (!file) return;
          input.value = '';
          const texture = await ed.importImage(file);
          if (texture) ed.setTexture(obj, texture, slot);
        });
        return el('div', { class: 'row' }, [
          el('label', { class: 'row-label', text: label }),
          el('div', { class: 'row-controls' }, [
            el('span', { class: 'tex-name', text: mat[slot]?.name ?? 'none' }),
            button('Load…', () => input.click(), 'btn btn-small'),
            button('✕', () => mat[slot] && ed.setTexture(obj, null, slot), 'btn btn-small'),
            input,
          ]),
        ]);
      };
      s.body.append(el('p', { class: 'hint', text: mat.name }), color.row, texRow('Texture', 'baseColorTexture'), metallic.row, roughness.row);
      s.body.append(texRow('Metal/rough', 'metallicRoughnessTexture'), texRow('Normal map', 'normalTexture'));
      if (mat.normalTexture) {
        const normalScale = sliderRow('Normal ×', () => mat.normalScale, (v) => (mat.normalScale = v), 0, 2, 0.01);
        s.body.append(normalScale.row);
        this.add(normalScale.binding);
      }
      s.body.append(texRow('Occlusion', 'occlusionTexture'));
      if (mat.occlusionTexture) {
        const occlusionStrength = sliderRow('Occlusion ×', () => mat.occlusionStrength, (v) => (mat.occlusionStrength = v), 0, 1, 0.01);
        s.body.append(occlusionStrength.row);
        this.add(occlusionStrength.binding);
      }
      s.body.append(emissive.row, emissiveStrength.row, texRow('Emissive map', 'emissiveTexture'), unlit.row, doubleSided.row, blend.row);
      this.add(color.binding, metallic.binding, roughness.binding, emissive.binding, emissiveStrength.binding, unlit.binding, doubleSided.binding, blend.binding);
      // The base color's alpha only matters to blended materials (and alpha-tested ones, which keep their texture's).
      if (mat.blend !== 'opaque') {
        const opacity = sliderRow('Opacity', () => mat.baseColor[3], (v) => (mat.baseColor = [mat.baseColor[0], mat.baseColor[1], mat.baseColor[2], v]), 0, 1, 0.01);
        s.body.append(opacity.row);
        this.add(opacity.binding);
      }
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
      const shadows = checkboxRow('Cast shadows', () => light.castShadows, (v) => (light.castShadows = v));
      s.body.append(shadows.row);
      this.add(shadows.binding);
      const hint = {
        directional: 'Only the first shadow-casting directional light renders shadows. Rotate the object to aim it.',
        spot: 'Spot lights shine along the object’s local −Z axis. Up to twelve spot lights (or two point lights) cast ' +
          'shadows at once, the nearest first; a mesh around the light, like a lamp shade, blocks it unless it casts no shadows.',
        point: 'Up to two point lights (or twelve spot lights) cast shadows at once, the nearest first; a mesh around ' +
          'the light, like a lantern, blocks it unless it casts no shadows.',
      }[light.type];
      s.body.append(el('p', { class: 'hint', text: hint }));
      out.push(s.root);
    }

    if (obj.camera) out.push(this.buildCamera(obj));
    const shape = obj.getComponent(Shape2D);
    if (shape) out.push(this.buildShape2D(shape));
    const text = obj.getComponent(Text2D);
    if (text) out.push(this.buildText2D(text));
    const source = obj.getComponent(AudioSource);
    if (source) out.push(this.buildAudioSource(obj, source));

    out.push(this.buildRigidBody(obj));

    // --- Behaviours
    const scripts = ed.scene.scripts.scripts;
    const addSelect = el('select', { class: 'add-behaviour', 'aria-label': 'Add behaviour' }, [
      el('option', { value: '', text: '+ Add…' }),
      source ? null : el('optgroup', { label: 'Components' }, [el('option', { value: 'audio-source', text: 'Audio Source' })]),
      el('optgroup', { label: 'Built-in' }, Object.keys(BEHAVIOURS).map((k) => el('option', { value: `builtin:${k}`, text: k }))),
      el('optgroup', { label: 'Scripts' }, [
        ...scripts.map((sc) => el('option', { value: `script:${sc.id}`, text: `${sc.name}.ts` })),
        el('option', { value: 'new-script', text: '＋ New script…' }),
      ]),
    ]);
    addSelect.addEventListener('change', () => {
      const v = addSelect.value;
      addSelect.value = '';
      if (v === 'audio-source') ed.setAudioSource(obj, true);
      else if (v.startsWith('builtin:')) ed.addBehaviour(obj, createBehaviour(v.slice(8)));
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

  /** For objects of a prefab instance: which prefab, how much the instance changes, and Apply / Revert / Unpack. */
  private buildPrefab(obj: GameObject): HTMLElement | null {
    const ed = this.editor;
    const root = ed.prefabRootOf(obj);
    if (!root) return null;
    const sec = section('Prefab');
    sec.root.classList.add('prefab-section');
    const outermost = ed.isOutermostInstance(root);
    if (root !== obj) sec.body.append(row('Part of', button(root.name, () => ed.select(root), 'btn btn-small prefab-root-link')));
    const asset = ed.prefabAsset(root);
    if (!asset) {
      sec.body.append(el('p', { class: 'hint', text: `${root.name}'s prefab is missing, so it's an empty stand-in. Saving keeps the instance as it was.` }));
      if (outermost) sec.body.append(row('', button('Unpack', () => ed.unpackPrefab(root), 'btn btn-small')));
      return sec.root;
    }
    const info = el('p', { class: 'hint prefab-info' });
    // Counting changes serializes the instance, so only every half second.
    let next = 0;
    const update = () => {
      if (performance.now() < next) return;
      next = performance.now() + 500;
      const n = outermost ? ed.instanceChanges(root) : -1;
      info.textContent = `Instance of ${asset.path ?? asset.name}${n < 0 ? '' : n ? ` with ${n} change${n === 1 ? '' : 's'}` : ', unchanged'}.`;
    };
    update();
    this.add({ sync: update });
    const apply = button('Apply', () => void ed.applyPrefab(root), 'btn btn-small apply-prefab');
    apply.title = `Write this instance's changes into ${asset.name}; every instance gets them`;
    const buttons = [apply];
    if (outermost) {
      const revert = button('Revert', () => ed.revertPrefab(root), 'btn btn-small revert-prefab');
      revert.title = `Throw away this instance's changes`;
      const unpack = button('Unpack', () => ed.unpackPrefab(root), 'btn btn-small unpack-prefab');
      unpack.title = 'Turn the instance into plain objects';
      buttons.push(revert, unpack);
    }
    sec.body.append(info, row('', ...buttons));
    return sec.root;
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

  /** Space, anchor and order rows shared by Shape2D and Text2D. */
  private placement2D(r: Shape2D | Text2D, body: HTMLElement): void {
    const space = selectRow('Space', [...SPACES_2D], () => r.space, (v) => {
      r.space = v as Space2D;
      this.refresh();
    });
    const order = numberRow('Order', () => r.order, (v) => (r.order = Math.round(v)), { step: 1, min: -1000, max: 1000, precision: 0 });
    body.append(space.row);
    this.add(space.binding);
    if (r.space === 'screen') {
      const anchor = selectRow('Anchor', [...ANCHORS_2D], () => r.anchor, (v) => (r.anchor = v as Anchor2D));
      body.append(anchor.row);
      this.add(anchor.binding);
    }
    body.append(order.row);
    this.add(order.binding);
  }

  private hint2D(r: Shape2D | Text2D): HTMLElement {
    return el('p', {
      class: 'hint',
      text: r.space === 'screen'
        ? 'Screen space: sizes and position are pixels from the anchor (+Y up). Drag it in the viewport to move it.'
        : 'World space: drawn on the object’s local XY plane, facing +Z. Colors are display colors, unaffected by lighting.',
    });
  }

  private buildShape2D(sh: Shape2D): HTMLElement {
    const s = section('Shape 2D');
    const kind = selectRow('Shape', [...SHAPE_KINDS_2D], () => sh.shape, (v) => {
      sh.shape = v as ShapeKind2D;
      this.refresh();
    });
    s.body.append(kind.row);
    this.add(kind.binding);
    this.placement2D(sh, s.body);
    const unit = sh.space === 'screen' ? 1 : 0.05;
    if (sh.shape !== 'path') {
      const width = numberRow('Width', () => sh.width, (v) => (sh.width = v), { step: unit, min: 0 });
      const height = numberRow('Height', () => sh.height, (v) => (sh.height = v), { step: unit, min: 0 });
      s.body.append(width.row, height.row);
      this.add(width.binding, height.binding);
    }
    if (sh.shape === 'rectangle') {
      const radius = numberRow('Corner radius', () => sh.cornerRadius, (v) => (sh.cornerRadius = v), { step: unit, min: 0 });
      s.body.append(radius.row);
      this.add(radius.binding);
    } else if (sh.shape === 'polygon') {
      const sides = numberRow('Sides', () => sh.sides, (v) => (sh.sides = Math.max(3, Math.round(v))), { step: 1, min: 3, max: 64, precision: 0 });
      s.body.append(sides.row);
      this.add(sides.binding);
    } else if (sh.shape === 'path') {
      const closed = checkboxRow('Closed', () => sh.closed, (v) => (sh.closed = v));
      s.body.append(closed.row, el('p', { class: 'hint', text: `${sh.points.length >> 1} points. Set \`points\` (flat x, y list) from a script.` }));
      this.add(closed.binding);
    }
    const filled = checkboxRow('Filled', () => sh.filled, (v) => (sh.filled = v));
    const fill = rgbaRow('Fill color', () => sh.fillColor, (c) => (sh.fillColor = c));
    const strokeWidth = numberRow('Outline width', () => sh.strokeWidth, (v) => (sh.strokeWidth = v), { step: unit / 5, min: 0 });
    const stroke = rgbaRow('Outline color', () => sh.strokeColor, (c) => (sh.strokeColor = c));
    s.body.append(filled.row, fill.row, strokeWidth.row, stroke.row, this.hint2D(sh));
    this.add(filled.binding, fill.bindings, strokeWidth.binding, stroke.bindings);
    return s.root;
  }

  private buildText2D(t: Text2D): HTMLElement {
    const s = section('Text 2D');
    const text = textAreaRow('Text', () => t.text, (v) => (t.text = v));
    s.body.append(text.row);
    this.add(text.binding);
    this.placement2D(t, s.body);
    const unit = t.space === 'screen' ? 1 : 0.05;
    const size = numberRow('Font size', () => t.fontSize, (v) => (t.fontSize = v), { step: unit, min: 0 });
    const font = textRow('Font', () => t.fontFamily, (v) => (t.fontFamily = v.trim() || 'sans-serif'));
    const bold = checkboxRow('Bold', () => t.bold, (v) => (t.bold = v));
    const color = rgbaRow('Color', () => t.color, (c) => (t.color = c));
    const align = selectRow('Align', [...TEXT_ALIGNS], () => t.align, (v) => (t.align = v as TextAlign));
    const vAlign = selectRow('Vertical align', [...TEXT_BASELINES], () => t.verticalAlign, (v) => (t.verticalAlign = v as TextBaseline));
    const lineHeight = numberRow('Line height', () => t.lineHeight, (v) => (t.lineHeight = v), { step: 0.05, min: 0.1, max: 10 });
    const maxWidth = numberRow('Wrap width', () => t.maxWidth, (v) => (t.maxWidth = v), { step: unit * 10, min: 0 });
    const outline = numberRow('Outline width', () => t.outlineWidth, (v) => (t.outlineWidth = v), { step: unit / 5, min: 0 });
    const outlineColor = rgbaRow('Outline color', () => t.outlineColor, (c) => (t.outlineColor = c));
    s.body.append(size.row, font.row, bold.row, color.row, align.row, vAlign.row, lineHeight.row, maxWidth.row, outline.row, outlineColor.row, this.hint2D(t));
    this.add(size.binding, font.binding, bold.binding, color.bindings, align.binding, vAlign.binding, lineHeight.binding, maxWidth.binding, outline.binding, outlineColor.bindings);
    return s.root;
  }

  private buildAudioSource(obj: GameObject, src: AudioSource): HTMLElement {
    const ed = this.editor;
    const s = section('Audio Source', button('✕', () => ed.setAudioSource(obj, false), 'btn btn-small'));
    const presets = Object.keys(SFX_PRESETS) as SfxPresetName[];
    const clipValue = (): string => {
      const ref = src.clip?.ref;
      if (!ref) return src.clip ? 'runtime' : '';
      if ('asset' in ref) return `asset:${ref.asset}`;
      const key = ref.sfx.join(',');
      return `synth:${presets.find((p) => packSfx(SFX_PRESETS[p]).join(',') === key) ?? 'custom'}`;
    };
    const current = clipValue();
    const options: { value: string; label: string }[] = [
      { value: '', label: 'None' },
      ...presets.map((p) => ({ value: `synth:${p}`, label: `Synth: ${p}` })),
      ...ed.project.audioAssets().map((a) => ({ value: `asset:${a.id}`, label: a.name })),
    ];
    if (current === 'synth:custom') options.push({ value: current, label: 'Synth: varied' });
    if (current === 'runtime') options.push({ value: current, label: `${src.clip!.name} (not saved)` });
    const clipSelect = el('select', { class: 'audio-clip', 'aria-label': 'Clip' }, options.map((o) => el('option', { value: o.value, text: o.label })));
    clipSelect.value = current;
    clipSelect.addEventListener('change', () => {
      const v = clipSelect.value;
      if (v === '') src.clip = null;
      else if (v.startsWith('synth:') && v.slice(6) in SFX_PRESETS) src.clip = AudioClip.synth(SFX_PRESETS[v.slice(6) as SfxPresetName], v.slice(6));
      else if (v.startsWith('asset:')) src.clip = ed.project.audioClip(v.slice(6));
      this.refresh();
      this.preview(src);
    });
    const preview = button('▶', () => this.preview(src), 'btn btn-small audio-preview');
    preview.title = 'Preview';
    const controls = [clipSelect, preview];
    const sfx = src.clip?.sfx;
    if (sfx) {
      const vary = button('Vary', () => {
        src.clip = AudioClip.synth(mutateSfx(sfx, Math.floor(Math.random() * 1e6) + 1), src.clip!.name);
        this.refresh();
        this.preview(src);
      }, 'btn btn-small audio-vary');
      vary.title = 'A random variation of this sound';
      controls.push(vary);
    }
    const clipRow = el('div', { class: 'row' }, [el('label', { class: 'row-label', text: 'Clip' }), el('div', { class: 'row-controls' }, controls)]);
    const volume = sliderRow('Volume', () => src.volume, (v) => (src.volume = v), 0, 2, 0.01);
    const pitch = sliderRow('Pitch', () => src.pitch, (v) => (src.pitch = v), 0.25, 4, 0.01);
    const loop = checkboxRow('Loop', () => src.loop, (v) => (src.loop = v));
    const onStart = checkboxRow('Play on start', () => src.playOnStart, (v) => (src.playOnStart = v));
    const spatial = checkboxRow('Spatial', () => src.spatial, (v) => {
      src.spatial = v;
      this.refresh();
    });
    s.body.append(clipRow, volume.row, pitch.row, loop.row, onStart.row, spatial.row);
    this.add(volume.binding, pitch.binding, loop.binding, onStart.binding, spatial.binding);
    if (src.spatial) {
      const min = numberRow('Min distance', () => src.minDistance, (v) => (src.minDistance = Math.min(v, src.maxDistance)), { step: 0.5, min: 0.01, max: 10000 });
      const max = numberRow('Max distance', () => src.maxDistance, (v) => (src.maxDistance = Math.max(v, src.minDistance)), { step: 1, min: 0.02, max: 10000 });
      s.body.append(min.row, max.row);
      this.add(min.binding, max.binding);
    }
    const length = src.clip ? `${src.clip.duration.toFixed(2)} s. ` : '';
    s.body.append(el('p', {
      class: 'hint',
      text: `${length}Sounds play in Play mode; scripts call play() or playOneShot(). ` +
        (src.spatial ? 'Spatial: heard from the object, fading out at the max distance.' : 'Not spatial: the same volume everywhere.'),
    }));
    return s.root;
  }

  /** Plays the source's clip with its volume and pitch, as a 2D sound (the editor isn't playing the scene). */
  private preview(src: AudioSource): void {
    if (!src.clip) return;
    audio.resume();
    this.previewVoice?.stop();
    this.previewVoice = audio.play(src.clip, { volume: src.volume, pitch: src.pitch });
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
