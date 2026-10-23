# AGENTS.md

Guidance for AI coding agents (and humans) working on Messier Engine. Read
`README.md` for the user-facing overview. This file covers the invariants
and workflows you need before changing code.

## Environment

- The primary dev environment is NixOS. Node isn't installed globally, so
  use the flake:
  - `nix develop` gives a shell with node 22 / npm.
  - `nix shell nixpkgs#nodejs_22 -c <cmd>` runs a one-off command.
- Run all commands from the repo root.
- If the directory isn't a git repo, every `nix` command copies the whole tree
  (including `node_modules`) into the store. Prefer `git init` + tracked files.
  When using `path:.` flake refs, expect that copy.

## Verify every change

Run these, in order of cost. Don't claim something works without running the
relevant ones.

1. `npm run typecheck`: strict TS, `noUnusedLocals`/`noUnusedParameters` are on.
2. `npm run build`: typecheck plus Vite production build.
3. GPU smoke tests (needs a Vulkan-capable GPU):
   ```sh
   nix develop .#tests -c sh -c 'cd tests && npm install && npm test'
   ```
   - `test:render` (Dawn under Node) catches WGSL compile errors, pipeline or
     bind-group validation errors, and math/loader/picking regressions. It
     writes `tests/.out/frame.png`. **Look at it** after renderer or shader
     changes.
   - `test:ui` (puppeteer + headless Chromium) checks editor interactions and
     fails on any console error or warning. Screenshots go to `tests/.out/ui-*.png`.
4. If you changed npm dependencies in the root `package.json`, also run
   `nix run nixpkgs#prefetch-npm-deps -- package-lock.json`, put the result in
   `npmDepsHash` in `flake.nix`, then run `nix build path:.`. The `tests/`
   package has its own lockfile and isn't part of the Nix build.

## Architecture in one screen

```
Engine.step(dt)                         src/engine/engine.ts
  scene.update(dt, playTime, playing)   behaviours (only when playing) + world matrices
  overlay.begin(); beforeRender hooks   editor builds gizmo/icons into OverlayBuilder
  renderer.render(scene, camera, …)     shadow pass → main MSAA pass (meshes, grid, overlay)
  afterRender hooks                     editor reads RenderStats
```

- **Scene graph** (`scene.ts`): `GameObject` holds optional components as plain
  fields (`mesh`, `material`, `light`, `behaviours`). No ECS. The scene's
  top-level objects are children of the invisible `scene.root`.
  `worldMatrix`/`normalMatrix` are cached and refreshed by
  `Scene.updateMatrices()`. Use `computeWorldMatrix()`/`worldPosition()` when
  you need fresh values mid-frame (for example right after a gizmo edit).
- **Cameras** (`camera.ts`): `Camera` is the view the renderer draws from
  (look-at, perspective or orthographic, always reversed-Z). `engine.camera` is
  the free view the editor drives. A `CameraComponent` (`GameObject.camera`)
  holds lens settings and fills a `Camera` from its owner's world matrix with
  `applyTo()`, looking along local −Z. When `engine.useSceneCamera` is set
  (the default; the editor turns it on in Play or with `C`), `Engine.step`
  renders through `scene.activeCamera()`, which is the visible camera with the
  highest priority. It also exposes that camera as `engine.viewObject` and
  skips the grid. The editor then skips its overlay and ignores viewport
  pointer input, because picking and gizmos use `engine.camera`.
- **Physics** (`physics.ts`): `GameObject.rigidBody` plus `scene.physics`
  (`PhysicsWorld`), stepped at a fixed 60 Hz from `Scene.update` after
  behaviours, only while playing. Each step reads world poses from transforms
  and writes them back, and `Engine.setPlaying(true)` calls `physics.reset()`.
  A dynamic body whose pose changed outside the solver counts as teleported:
  it wakes and its velocity is zeroed. Kinematic velocity is derived from
  transform deltas.
- **Scripting** (`scripting.ts`, `typescript.ts`): a `ScriptAsset` (in
  `scene.scripts`) holds TypeScript source. `compile()` runs `stripTypes()`,
  which blanks types with spaces so every token keeps its line and column.
  It then rewrites `import … from 'messier'` into destructuring of the engine
  barrel, evaluates the result with `new Function` (with a `sourceURL`), and
  probes the class's public number fields for `defaults`. A `ScriptBehaviour`
  wraps one asset per object. Its `params` is a Proxy (override ?? default),
  and it hot-swaps a running instance's prototype when `asset.version`
  changes. Errors become `ScriptDiagnostic`s. Stack lines are mapped back
  with a calibrated `Function` header offset, and JS syntax errors (which
  `Function` reports without a position) are located through the
  `ScriptLibrary.locateSyntaxError` hook, which the editor implements.
  `scripting.ts` imports `./index` for the script API. That import is
  circular and only read lazily, so keep it that way.
- **Input** (`input.ts`): the `input` singleton holds keyboard state by
  `KeyboardEvent.code`. The engine never listens to the DOM. The editor
  forwards keydown/keyup in `bindKeyboard()`. `Engine.step` calls
  `input.endFrame()` after `scene.update` (so `pressed`/`released` last one
  update), and `setPlaying` resets it.
- **Engine vs editor:** `src/engine/**` must not import from `src/editor/**`
  and must not touch the DOM beyond the canvas passed to `Renderer`. That
  boundary is what lets `tests/render` run the engine under Node. The editor
  imports only through the barrel `src/engine/index.ts`.
  `Engine.step` skips rendering while the canvas has zero size (Scripts tab),
  but keeps updating the scene.
- **Persistence** (`serialize.ts`, `project.ts`, `src/editor/project.ts`):
  `serializeScene()` turns a scene into JSON-safe `SceneData`, and
  `applySceneData()` loads one into an existing `Scene` (scripts are looked up
  by name, so load them first). Meshes and textures are saved as a `ref`
  (`ResourceRef`): `{ primitive, args }` stamped by the `create*` generators, or
  `{ asset, index }` for the n-th mesh/texture of an imported model, stamped by
  `tagAssetResources()` in hierarchy order. A `Project` keeps every imported
  model's original files as an `Asset` and reloads them through the normal
  loaders (`ProjectResources`), so loaders must stay deterministic. A
  `.messier` file is a GLB-style container (JSON manifest chunk + BIN chunk of
  asset files). The editor's `ProjectManager` serializes the current scene
  once a second, compares the manifest JSON with the last saved and autosaved
  versions (dirty flag, IndexedDB autosave), and never syncs while playing.
  Loading ignores unknown keys and keeps defaults for missing or mistyped
  values. Problems become warnings, not exceptions.
- **Editor** (`src/editor/editor.ts`) owns the Scene/Scripts view tabs
  (`setView`; scene shortcuts are off in the Scripts tab), selection, pointer modes
  (`click` → `orbit` after a 4 px slop, `gizmo`, `pan`, `fly`), keyboard
  shortcuts, play-mode snapshots and the undo `History`. Panels
  (`hierarchy.ts`, `inspector.ts`) call back into `Editor`.

## Invariants (breaking these causes silent rendering bugs)

- **Matrices are column-major** `Float32Array<ArrayBuffer>` (`Mat4`).
  `mat4.multiply(a, b)` = a·b (b applied first). Quaternions are `[x, y, z, w]`.
  Euler angles in the API are **degrees, XYZ order** (`quat.fromEulerDeg` and
  `quat.toEulerDeg` are inverses).
- **Reversed-Z** for the main camera: `mat4.perspectiveReversedZ`, a
  `depth32float` buffer cleared to **0**, and `depthCompare: 'greater'`
  (overlay uses `greater-equal`). `Camera.screenRay` unprojects NDC z = 1 as
  near and z = 0 as far. The **shadow map uses normal Z** (`ortho`, clear 1,
  `less`). Don't mix them up.
- **Lights shine along local −Z.** Use `quat.lookRotation(dir)` to aim one.
- **Uniform layouts are mirrored by hand** between TS and WGSL. When you
  change one side, change the other:
  - `Frame` (176 B): `shaders/common.wgsl` ↔ `Renderer.render()` (the `fv`/`fu`/`fi` offsets).
  - `Light` (64 B, 16 floats): `common.wgsl` ↔ the light packing loop in
    `Renderer.render()`. Type codes come from `LIGHT_TYPE_INDEX`.
  - `Material` (48 B): `mesh.wgsl` ↔ `Renderer.prepareMaterial()`.
  - `Object` (model + normal matrix, 128 B) lives in 256 B dynamic-offset
    slots (`OBJECT_STRIDE`) and is shared by the mesh and shadow pipelines.
- **Shaders:** `common.wgsl` is *prepended* to `mesh`, `grid` and `overlay`.
  It declares `@group(0) @binding(0) frame`, so don't redeclare it.
  `shadow.wgsl` and `mipmap.wgsl` are standalone. Shaders load with Vite
  `?raw` imports, and `tests/render/run.mjs` emulates that with an esbuild plugin.
- **Bind groups:** group 0 = frame (uniform, lights storage, shadow map,
  comparison sampler), group 1 = material, group 2 = object (dynamic offset).
  The shadow pass uses its own group-0 layout, because binding the frame
  group would put the shadow map in a usage conflict.
- **Color spaces:** material and light colors are **linear**. Textures are
  `rgba8unorm-srgb`. The canvas is non-sRGB and the shader applies ACES +
  gamma 2.2 itself. `scene.background` is display-space (written straight to
  the clear color). UI pickers convert with `hexToLinear`/`linearToHex` or,
  for display-space values, `hexToRgb`/`rgbToHex`.
- **Mesh vertex format:** interleaved `position(3) normal(3) uv(2)` floats,
  32 B stride, `uint32` indices, CCW front faces. Procedural meshes call
  `fixWinding()`. CPU copies are kept for raycasting. GPU buffers are created
  lazily, so after mutating `vertices`/`indices`, call `mesh.destroy()` to
  force a re-upload, and `computeBounds()`.
- **TypeScript typed arrays:** WebGPU's `writeBuffer` needs
  `ArrayBuffer`-backed views. Declare long-lived arrays as
  `Float32Array<ArrayBuffer>`, not bare `Float32Array`.

## Common tasks

**Add a behaviour (script component).** Subclass `Behaviour` in
`src/engine/behaviours.ts`, give it a unique `readonly type` string and numeric
defaults in `super({...})`, and add it to `BEHAVIOURS`. The inspector picks it
up automatically. Capture start state in `start()`, because Play/Stop only
restores transforms, light color/intensity, camera settings and rigid body velocities.
User-written behaviours don't need this: they're TypeScript `Script` classes
edited in the Scripts tab (see README).

**Change the type stripper.** Add a snippet to `tests/render/ts-corpus.ts`.
`test:render` checks that the stripper's output, after minification, is
identical to esbuild's on that corpus and on every `src/**/*.ts` file without
parameter properties. Erase code with `blank()`/`replaceRange()`, which keep
widths. Never insert characters, because diagnostics rely on unchanged
positions.

**Add a component field (material, light, camera, rigid body).** Copy it in
`clone()`/`copyFrom()` and add it to the `*_FIELDS` list next to the class
(`MATERIAL_FIELDS`, `LIGHT_FIELDS`, `CAMERA_FIELDS`, `RIGID_BODY_FIELDS`) so
scenes save it. Old files without the key keep the default. For a new
component, extend `objectToData`/`dataToObject` in `serialize.ts` and the
round-trip test in `tests/render`. Bump `SCENE_VERSION` only for changes old
readers would misread.

**Add a material or light property.** Add the field (and copy it in `clone()`
and the `*_FIELDS` list),
extend the WGSL struct and the TS packing (keep 16-byte alignment, and grow
`*_UNIFORM_SIZE` if needed), add an inspector row in `inspector.ts`, and map it
in the glTF/OBJ loaders if a standard field exists.

**Add a primitive.** Write the generator in `primitives.ts` (finish with
`.fixWinding()`, and `tag()` it with its arguments so scenes can rebuild it), add it to
`PrimitiveKind`, `GENERATORS` and `getPrimitive`, add a
`data-action="add-…"` button in `index.html` and the matching entry in
`Editor.bindToolbar()`.

**Add a toolbar action or shortcut.** Toolbar buttons use `data-action` and
are dispatched in `Editor.bindToolbar()`. Shortcuts live in
`Editor.bindKeyboard()` (ignored while an input or select is focused, and
while flying with right mouse). During Play, plain keys go to `input` instead
and only Esc (stop) and Ctrl shortcuts reach the editor, so new single-key
shortcuts are automatically unavailable while playing.
Update the help table in `index.html` and the README controls table.

**Make an edit undoable.** Push a `Command` with `undo`/`redo` closures to
`editor.history` *after* applying the change. For transform edits, use
`beginTransformEdit(obj)` / `commitTransformEdit(obj)`, which skip no-op
commands. Call `hierarchy.markDirty()` after structural changes.

**Change the sample glTF.** Edit `scripts/generate-sample-glb.mjs` and run
`npm run generate:sample`. `tests/render` asserts the lantern's mesh and light
counts, so update it too.

## Gotchas learned the hard way

- Coplanar editor geometry (the grid at y = 0.002 over a floor at y = 0)
  z-fights with standard depth. That's why the main pass uses reversed-Z.
  Don't "simplify" it back to `depth24plus`/`less`.
- Picking priority in the viewport is: **gizmo handles → light icons →
  meshes**. When the UI test or a user clicks a point that projects onto the
  selected object's gizmo axis or center, a drag starts instead of a
  selection. That's intended, so pick click targets in tests away from
  gizmo axes and light icons.
- Clicking empty viewport space **deselects**. In UI tests, focus the canvas
  with `canvas.focus()` instead of clicking it before sending shortcuts.
- `createImageBitmap` doesn't exist under Node. The render test stubs it, so
  glTF textures fail to load there by design (a warning is logged). Textures
  are covered by the browser test.
- WGSL: `textureSample` must stay in uniform control flow (it sits at the top
  of `fs_main`, before `discard`). Inside loops and branches use
  `textureSampleCompareLevel`/`textureSampleLevel`.
- The code editor inserts text with `document.execCommand('insertText')`.
  It's deprecated, but it's the only way to keep the textarea's native undo
  stack. Don't replace it with `value =` or `setRangeText` (those are
  fallbacks only).
- `locateSyntaxError` cancels the window `error` event so a script's syntax
  error never reaches the console, which would fail `test:ui`. Script
  runtime errors aren't logged to the console either. The editor shows them
  instead.
- The editor boots from the IndexedDB autosave when there is one. `test:ui`
  relies on puppeteer's fresh temporary profile to start from the demo, and its
  project checks (reload, scenes, Save/Open) run last because they replace the
  scene. When debugging in a normal browser, use **☰ → New Project** or clear site data
  to get back to a known state.
- Dawn under Node prints `maxDynamic…BuffersPerPipelineLayout artificially
  reduced` warnings. They're harmless.

## Style

- TypeScript strict, ES modules, no runtime dependencies. Keep it that way
  unless there's a strong reason.
- Match the surrounding code: small focused modules, comments that explain
  *why* (or a non-obvious layout), not what.
- 2-space indent, single quotes, trailing commas, about 140-column lines.
