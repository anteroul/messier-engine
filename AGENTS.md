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
3. Tests (`npm test` runs all three; the GPU ones need a Vulkan-capable GPU):
   ```sh
   nix develop .#tests -c sh -c 'cd tests && npm install && npm test'
   ```
   - `test:unit` (Node only, fast) covers signals, Time, transforms, the component
     registry, the behaviour lifecycle and scripts. Add tests here for engine logic
     that doesn't need the GPU. `node unit/run.mjs <name>` runs one file.
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
  (playing) Time.beginFrame → N × scene.fixedUpdate (behaviours, then physics)
            scene.updateBehaviours → scene.lateUpdate
  input.endFrame(); scene.updateMatrices()
  overlay.begin(); beforeRender hooks   editor builds gizmo/icons into OverlayBuilder
  renderer.render(scene, camera, …)     uploads, then a frame graph: shadow → main (meshes, sky; HDR MSAA) → tonemap →
                                        overlay (grid, world 2D, overlay, HUD), compiled and executed in one encoder
  afterRender hooks                     editor reads RenderStats
  draw2d.clear(); scene.processDestroyed()  immediate 2D layer reset; deferred destroys (onDisable → onDestroy → detach)
```

- **Scene graph** (`scene.ts`, `transform.ts`, `component.ts`): Unity-style
  composition, not ECS. A `GameObject` has one `Transform` (which owns the
  hierarchy) and a list of `Component`s. `obj.mesh`/`material`/`castShadows`
  (→ `MeshRenderer`), `light`, `camera` and `rigidBody` are shortcuts over the
  first component of that kind, so most code still reads like plain fields.
  The scene's top-level objects are children of the invisible `scene.root`.
  `Scene.query(Type)` lists *live* components (enabled, object active in the
  hierarchy, in that scene; subclasses included). It's kept current by
  `Component._sync()`, which runs on every enable, activation, reparent or destroy
  change. The renderer, physics and `activeCamera()` iterate it. `visible` is an
  alias of `activeSelf`, so inactive objects aren't drawn and their components
  don't run.
- **Transforms** cache local/world/normal matrices and compute them lazily.
  Each transform remembers the local values it baked and its parent's world
  version, so in-place edits (`position[1] = y`) are noticed. `worldMatrix` is
  always current, even mid-frame, and `Scene.updateMatrices()` syncs everything
  top-down once a frame. The world-space helpers live on `Transform`
  (`worldPosition`, `setParent(p, keepWorld)`, `lookAt`…), and `GameObject`
  keeps delegating shortcuts.
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
- **Behaviours** (`behaviours.ts`): `Behaviour` is a component with Unity's
  lifecycle hooks. They only run while the scene runs (`Scene.setRunning`, set by
  `Engine.setPlaying`). Dispatch lists hold started, enabled behaviours whose
  class overrides the hook. Changes during a dispatch are safe: loops are bounded,
  removals become nulls, and the lists are compacted afterwards.
  `GameObject.destroy` in a running scene marks the target at once and tears it
  down in `processDestroyed`. Lifecycle state lives in `_`-prefixed fields that
  `Behaviour._sync()` manages; don't set them elsewhere.
- **Physics** (`physics.ts`): the `RigidBody` component plus `scene.physics`
  (`PhysicsWorld`). It's stepped once per fixed step by `Scene.fixedUpdate`
  (after `fixedUpdate` hooks) with `Time.fixedDeltaTime`, only while playing. Each step reads world poses from transforms
  and writes them back, and `Engine.setPlaying(true)` calls `physics.reset()`.
  A dynamic body whose pose changed outside the solver counts as teleported:
  it wakes and its velocity is zeroed. Kinematic velocity is derived from
  transform deltas.
- **Scripting** (`scripting.ts`, `typescript.ts`): a `ScriptAsset` (in
  `scene.scripts`, which scene clones share) holds TypeScript source. A user
  script *is* the component: `asset.create(overrides)` makes a `Script`
  instance, and every successful compile hot-swaps live instances in place
  (`Script._hotSwap`). The prototype changes, so registry and dispatch-list
  membership is redone. Before an asset first compiles, its instances are
  plain `Script` placeholders. `compile()` runs `stripTypes()`,
  which blanks types with spaces so every token keeps its line and column.
  It then rewrites `import … from 'messier'` into destructuring of the engine
  barrel, evaluates the result with `new Function` (with a `sourceURL`), and
  probes the class's public number fields for `defaults`. A `Script`'s
  `params` is a Proxy (override ?? default). Errors become `ScriptDiagnostic`s. Stack lines are mapped back
  with a calibrated `Function` header offset, and JS syntax errors (which
  `Function` reports without a position) are located through the
  `ScriptLibrary.locateSyntaxError` hook, which the editor implements.
  `scripting.ts` imports `./index` for the script API. That import is
  circular and only read lazily, so keep it that way.
- **Sky** (`sky.ts`, `shaders/sky.wgsl`, `skyRadiance()` in `common.wgsl`): `scene.sky` is a `Sky` (mode `color`,
  `gradient` or `image`). `color` is the old flat clear color, and the mesh shader's old hemispheric ambient and fake
  reflection gradient. Otherwise the sky pass draws a fullscreen triangle at depth 0 after the opaque meshes
  (`greater-equal`, so it only fills cleared pixels) and before the grid, reconstructing view rays from
  `frame.invViewProj`; and the mesh shader takes ambient diffuse from `skyRadiance(N, 0.85)` and reflections from
  `skyRadiance(R, roughness)`, times `sky.lighting`. Image skies are equirectangular `rgba8unorm-srgb` textures whose
  ordinary mip chain stands in for prefiltering (`textureSampleLevel`, so it's fine in non-uniform control flow). The
  gradient's sun follows the shadow-casting (or first) directional light; its disc is drawn only unblurred, since
  lit surfaces already get the light's specular highlight. Saved in `settings.sky`, with `texture` as an image
  asset ref; `sceneAssetIds()` (not `collectAssetIds()`) counts it.
- **2D** (`shapes2d.ts`, `draw2d.ts`, `font.ts`): `Shape2D` and `Text2D` extend the abstract `Renderer2D`
  component. Each frame the renderer queries them, tessellates them on the CPU into a `Batch2D` through
  `targetMatrix()` (world matrix, or for `space: 'screen'` a map to CSS pixels from the anchor with Y flipped),
  and draws world-space ones after the grid (depth-tested, no depth write, sorted by `order` then back to front)
  and screen-space ones plus the `draw2d` immediate layer between the depth-tested and on-top overlay. Shapes are
  plain triangles (MSAA smooths them); text is glyph quads sampling the shared `fontAtlas`, a single-channel
  signed distance field built from glyphs that an `OffscreenCanvas` rasterizes (none under Node:
  `fontAtlas.setRasterizer()` lets tests supply glyphs). Outlines are the same quads drawn first with a lower
  distance threshold. `raycastScene`/`worldBounds` include world-space 2D bounds; `pickScreen2D` picks the HUD.
- **Audio** (`audio.ts`, `audioSource.ts`, `audioClip.ts`, `sfx.ts`): the `audio` singleton wraps one Web Audio
  context (master gain → compressor). Browsers only start audio after a user gesture and the engine never listens
  to the page, so the editor and `src/player.ts` call `audio.resume()` from their pointer/key handlers; before that
  (and under Node, where there is no `AudioContext`) `audio.play()` returns null. An `AudioClip` holds sample
  channels, with a lazily created `AudioBuffer`, and a `ClipRef`: `{ sfx }` (packed synthesizer parameters, rebuilt
  deterministically by `renderSfx`, like primitive args) or `{ asset, index: 0 }` (an imported sound file, a project
  `Asset` whose first file has an audio extension; decoded with an `OfflineAudioContext`). `AudioSource` is a plain
  component; `Engine.step` runs `updateAudioSources()` (`playOnStart` each time a source becomes live, live
  volume/pitch) and `audio.update()` (listener at the rendered camera, voices follow their owner, and voices whose
  owner isn't live in the running active scene stop). `setPlaying(false)` calls `audio.stopAll()`.
- **Input** (`input.ts`): the `input` singleton holds keyboard state by
  `KeyboardEvent.code`. The engine never listens to the DOM. The editor
  forwards keydown/keyup in `bindKeyboard()`. `Engine.step` calls
  `input.endFrame()` after the update phases (so `pressed`/`released` last one
  frame, including its fixed steps), and `setPlaying` resets it.
- **Frame graph** (`frameGraph.ts`): `Renderer.render()` prepares uniforms and buffers, then declares the frame on a
  `FrameGraph`: the shadow map (persistent, owned by the renderer) and the canvas texture are *imported*; the
  multisampled `hdr color` (`rgba16float`), `main depth` and `display color` (canvas format) are *transient*
  (`createTexture`, sized from the output size that `resizeIfNeeded()` sets). The passes: `shadow`; `main` (meshes
  and sky as linear radiance into `hdr color`, cleared to alpha 0 so the tonemap knows where nothing was drawn);
  `tonemap` (per-sample exposure + ACES + gamma 2.2 into `display color`, the display-space background where alpha
  is 0, see `tonemap.wgsl`); `overlay` (loads `display color` and `main depth`; grid, world 2D, overlay, HUD;
  resolves into the canvas). Tone mapping per sample, before the resolve, keeps MSAA edges as they were when the
  scene shaders tone mapped; resolving HDR first would alias bright edges.
  `addRenderPass(name, setup)` / `addComputePass` declare what a pass reads (`read`, `readStorage`) and writes
  (attachments, `writeStorage`) and return its execute function; the draw code lives in private methods
  (`drawShadowCasters`, `drawScene`, `drawTonemap`, `drawDisplay`). `execute()` orders passes by those dependencies (declaration order otherwise),
  culls passes nothing reads (unless they write an imported texture or are `sideEffect`), allocates transients from a
  pool (aliasing non-overlapping lifetimes, reused across frames, freed after 3 idle frames or a resize), infers
  usage flags, stores attachments only when a later pass reads them (imported ones always), and records one
  encoder with a debug group per pass. It doesn't import the renderer or touch the DOM: `tests/unit/frameGraph.test.ts`
  runs it on a fake device. Mipmap generation happens at upload, outside the graph.
- **Shader variants** (`pipelines.ts`): mesh and shadow pipelines aren't built by hand. A `MeshVariantKey` holds
  everything that changes one (pass, cull, alpha test, color format, sample count, depth format and compare);
  `meshVariantKey(pass, material, mesh, target)` derives it, with the formats from the frame graph's attachments
  (`FrameResources.target`), and is the only place that decides mesh pipelines. `Renderer.meshPipelines`
  (`MeshPipelines`) caches pipelines by `variantKeyString(key)` (shader modules and pipeline layouts cached apart):
  `get()` builds a miss synchronously and counts it in `RenderStats.pipelineBuilds`, `prewarm()` builds ahead with
  `createRenderPipelineAsync` (`Renderer.prewarm(scene)`, which the editor calls after a scene loads or an asset is
  placed). `allMeshVariantKeys()` lists every valid key; `test:render` builds them all. Material features a uniform
  or a placeholder texture can express (unlit, the main pass's alpha cutoff, the material maps) stay runtime
  branches in `mesh.wgsl`, not variants. The grid, overlay, sky, tonemap, mipmap and 2D pipelines are hand-built.
- **Culling and instancing** (`culling.ts`, `batching.ts`): each frame `Renderer.render()` hands the live
  `MeshRenderer`s to its `DrawList`, which tests every mesh's bounds (as a box under the world matrix) against the
  camera's frustum and, for casters, the shadow map's (`frustumPlanes()` works on any view-projection here), then
  groups what's left into `MeshBatch`es: same mesh and a material that looks the same (`materialsEqual()`, found
  through `materialHash()`; `MeshRenderer.clone()` copies the material, so duplicates rarely share one object). Shadow
  batches ignore the material unless it's alpha tested. Every instance's `Object` goes into one storage buffer, a
  batch's instances side by side, and a batch is one `drawIndexed` whose first instance is its offset there: the
  shaders read `objects[instance_index]`. Batches keep the order of first appearance. `renderer.frustumCulling`
  turns the culling off; `RenderStats` counts `instances` and `culled`. Neither file touches the GPU
  (`tests/unit/batching.test.ts`). A new `Material` field that changes the look must go into both `materialHash()`
  and `materialsEqual()`, or look-alikes that aren't get merged.
- **Profiling** (`profiler.ts`, `gpuTimer.ts`, `src/editor/profilerPanel.ts`): the `profiler` singleton collects
  nested CPU sections (`begin(name)` / `end()`; a single branch while `profiler.enabled` is off) that `Engine.step`,
  `Scene.fixedUpdate` and `Renderer.render()` open around their phases, and `endFrame()` publishes them (tree order,
  smoothed averages, a frame-time ring). GPU time comes from `GpuTimer`, a `PassTimer` the renderer hands to
  `FrameGraph.timer` while profiling: each executed pass gets `timestampWrites`, the query set is resolved at the end
  of the encoder and read back asynchronously through a small pool of buffers, so `profiler.gpu` is a few frames
  behind. The device only has `timestamp-query` when the adapter offers it (`profiler.gpuSupported`). The editor's
  panel (toolbar button or `F2`) turns the profiler on while it's shown. Wrap a new engine phase or an expensive
  step in a section so it shows up there.
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
  `tagAssetResources()` in hierarchy order. Images (sky panoramas, textures loaded into a material) and sounds are
  single-file assets (index 0); the first file's extension tells `ProjectResources` the kind. A `Project` keeps every imported
  model's original files as an `Asset` and reloads them through the normal
  loaders (`ProjectResources`, which also keeps each model's loaded hierarchy to clone), so loaders must stay
  deterministic. On disk a project is a **folder** (`projectFolder.ts`): `project.json`, `scenes/<Name>.messier`
  (one `SceneData` each), `scripts/<Name>.ts` and `assets/**`, where every file has a `<file>.meta` holding its id.
  In memory it's the same `Project`: a scene's id is its path, an asset's id is its meta id (and `Asset.path` its
  place under `assets/`), so refs and builds don't know about folders. Engine code reaches the folder only through
  `FolderIO` (`MemoryFolder` for tests and zips, a Node one in scripts and `tests/unit/nodeFolder.ts`, a
  `FileSystemDirectoryHandle` one in `src/editor/folderIO.ts`). When two files share a meta id (a copy made with
  its `.meta`), the one with the older `.meta` keeps it. The packed form (a GLB-style container: JSON manifest chunk
  + BIN chunk of asset files) is what builds embed; it was also the single-file `.messier` project format before
  0.4, which still opens. The editor's `ProjectManager` has two modes. A folder project: once a second it serializes
  the current scene and scripts and writes the scene, script and `project.json` files whose text differs from what
  it last wrote or read (`written`); `FolderSync` polls the folder (and uses `FileSystemObserver` where it exists),
  and `applyChanges()` (re)loads assets, swaps new meshes/textures/clips into live objects, and takes scripts, scenes
  and `project.json` edited outside. Folder work is serialized through `enqueue()`, and the editor's own writes are
  reported with `noteWrite()` so they don't echo back. Every folder the editor writes or opens also gets the script
  types: `.messier/messier.d.ts` (rewritten when it differs) and a `tsconfig.json` (only if missing), via
  `writeTypeFiles()`. The declarations come from `scripts/messier-types.mjs`, which bundles the engine's types with
  the TypeScript API (System-module `outFile`, renamed to `messier/engine/*` plus a `declare module "messier"`);
  `scripts/types-plugin.mjs` serves them in dev and emits `messier.d.ts` in builds, and the editor fetches that. A browser project (first visit, other browsers, old files)
  autosaves its packed manifest to IndexedDB as before. Neither writes while playing. Loading ignores unknown keys and
  keeps defaults for missing or mistyped values. Problems become warnings, not exceptions.
- **Format versions** (`sceneFormat.ts`): scene and prefab files share `SCENE_VERSION`. Every reader goes through
  `upgradeSceneData()` / `readPrefab()` (both `upgradeDocument()`), which run `MIGRATIONS` on a copy of an older
  document, so the rest of the engine only sees the current version, and newer versions are refused. Version 2
  renamed `material.texture` to `baseColorTexture` and added prefabs.
- **Prefabs** (`prefab.ts`, plus the instance parts of `serialize.ts`): a prefab is an asset (`assets/**/*.prefab`,
  kind `'prefab'`, JSON) whose objects all have an `id`. Instances are saved as `{ prefab, name, position, rotation,
  scale, overrides?, removed?, added? }` keyed by those ids; loading *expands* one (a copy of the prefab, nested
  instances expanded with ids prefixed `<nested id>/`, changes applied) and tags the objects with
  `GameObject.prefab` (instance roots) and `prefabNode` (their id in the instance). Saving captures the live objects
  against a fresh expansion (children are matched by `prefabNode`, anything else is *added*) and keeps the diff, so
  the JSON level (expand/diff) and the object level must stay exact inverses: `tests/unit/prefab.test.ts` checks
  round trips. Component keys of `ObjectData` are compared field by field (`COMPONENT_KEYS` in `prefab.ts`), the rest
  whole. `scene.prefabs` (a `ProjectResources`) looks prefabs up for saving, and `Scene.instantiate(name)` for
  scripts; whoever loads a scene sets it. A missing prefab leaves a placeholder that saves the instance unchanged
  (`_prefabStash`). Projects ship every prefab and what it uses (`Project.usedAssetIds`). In the editor, Create /
  Apply / Revert replace instance objects (`swapObjects`, undoable); a prefab changed outside rebuilds the instances
  from their saved data and clears the undo history.
- **Builds** (`src/editor/build.ts`, `src/player.ts`, `scripts/player-plugin.mjs`, `sceneManager.ts`):
  `Project.build` holds the scene order/inclusion and title (saved in the manifest). Build fetches
  `messier-player.js` (the plugin bundles `src/player.ts` with a nested Vite build: served by the dev server,
  emitted by `vite build`, always minified and mangled) and writes a .zip with one `index.html`: that script
  inline plus `project.subset(buildScenes()).encode()` as base64. The player compiles the scripts and plays the
  scenes through `sceneManager`. The editor attaches `sceneManager` during Play with the same build order, and
  handles `engine.sceneChanged` while playing as a runtime scene load. `src/player.ts` may only import the
  engine barrel; it's the whole game runtime.
- **Editor** (`src/editor/editor.ts`) owns the Scene/Scripts view tabs
  (`setView`; scene shortcuts are off in the Scripts tab), selection, pointer modes
  (`click` → `orbit` after a 4 px slop, `gizmo`, `pan`, `fly`), keyboard
  shortcuts, Play and the undo `History`. `editor.scene` is `engine.scene`, the
  active scene. Play runs `scene.clone()` with a fresh `History`, and Stop
  switches back, so nothing has to be snapshotted or restored. Panels
  (`hierarchy.ts`, `inspector.ts`) call back into `Editor`.

## Invariants (breaking these causes silent rendering bugs)

- **`_`-prefixed names are internal**, and release builds mangle them
  (`scripts/mangle-props.mjs`: `_foo` → `_$1a`, still `_`-prefixed). Never access
  them by string, and never give public API a `_` name. Runtime code tells
  internal fields from public ones by the prefix (`Component.clone`/`toJSON`,
  `Behaviour.paramNames`, script hot swap). That's why a behaviour's private
  state must be `_`-prefixed (`private _baseY`), or it would show up as an
  inspector parameter.

- **Matrices are column-major** `Float32Array<ArrayBuffer>` (`Mat4`).
  `mat4.multiply(a, b)` = a·b (b applied first). Quaternions are `[x, y, z, w]`.
  Euler angles in the API are **degrees, XYZ order** (`quat.fromEulerDeg` and
  `quat.toEulerDeg` are inverses).
- **Reversed-Z** for the main camera: `mat4.perspectiveReversedZ`, a
  `depth32float` buffer (the frame graph's `main depth` transient) cleared to **0**, and `depthCompare: 'greater'`
  (overlay uses `greater-equal`). `Camera.screenRay` unprojects NDC z = 1 as
  near and z = 0 as far. The **shadow map uses normal Z** (`ortho`, clear 1,
  `less`). Don't mix them up.
- **Lights shine along local −Z.** Use `quat.lookRotation(dir)` to aim one.
- **Uniform layouts are mirrored by hand** between TS and WGSL. When you
  change one side, change the other:
  - `Frame` (336 B, with the inverse view-projection and the sky): `shaders/common.wgsl` ↔ `Renderer.render()` (the
    `fv`/`fu`/`fi` offsets). Sky mode codes come from `SKY_MODE_INDEX`.
  - `Light` (64 B, 16 floats): `common.wgsl` ↔ the light packing loop in
    `Renderer.render()`. Type codes come from `LIGHT_TYPE_INDEX`.
  - `Material` (64 B): `meshData.wgsl` ↔ `Renderer.prepareMaterial()`. Its textures are bound in `TEXTURE_SLOTS` order
    (binding 1 base color, 2 the sampler, 3… the rest); `LINEAR_TEXTURE_SLOTS` are uploaded as `rgba8unorm`
    (`Texture.gpuLinear`), the others as sRGB (`Texture.gpu`).
  - 2D vertex (40 B: position 3, uv 2, color 4, threshold 1; threshold < 0 = solid): `shape2d.wgsl` ↔
    `VERTEX2D_FLOATS` / `Batch2D.vertex()` and the 2D pipeline's attributes.
  - `Object` (model + normal matrix, 128 B, `OBJECT_FLOATS`): one per drawn instance in a storage buffer
    (`array<Object>`, indexed by the instance index), shared by the mesh and shadow pipelines (declared in
    `meshData.wgsl`) ↔ `DrawList.emit()`.
- **Shaders:** `common.wgsl` is *prepended* to `mesh`, `grid`, `overlay` and `sky`.
  It declares `@group(0) @binding(0) frame`, the sky texture and sampler, `PI` and `skyRadiance()`,
  so don't redeclare them. `meshData.wgsl` (the `Material` and `Object` structs) is prepended to `mesh` (after
  `common`) and `shadow`. `mesh` and `sky` output linear radiance with alpha 1; only `tonemap.wgsl` tone maps.
  `mipmap.wgsl`, `shape2d.wgsl` and `tonemap.wgsl` are standalone. Shaders load with Vite
  `?raw` imports, and `tests/render/run.mjs` emulates that with an esbuild plugin.
- **Bind groups:** group 0 = frame (uniform, lights storage, shadow map,
  comparison sampler, sky texture, sky sampler), group 1 = material, group 2 = objects (the instance array, read-only storage). The frame
  group is rebuilt when the sky image changes (a 1×1 white placeholder otherwise).
  The shadow pass never binds the frame group (the shadow map would be in a usage conflict): its group 0 is its own
  (the light's view-projection), group 1 the object, and the alpha-tested shadow variant binds the material (the
  same bind group as the main pass's group 1) as group 2. The 2D pipelines have their own group 0 too (view matrix,
  font atlas, sampler), so rebind the frame group before drawing anything that uses it after them.
- **Color spaces:** material and light colors are **linear**. Textures are
  `rgba8unorm-srgb`. Meshes and the sky render linear radiance into an `rgba16float` target, and the tonemap pass
  applies exposure, ACES and gamma 2.2 (the canvas is non-sRGB). Sky gradient colors are linear too (tone-mapped like
  lights). Anything display-space draws in the overlay pass, after the tonemap. `scene.background` and 2D colors (`Shape2D`, `Text2D`, `draw2d`) are display-space
  (written as is, no tone mapping). UI pickers convert with `hexToLinear`/`linearToHex` or,
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
`src/engine/behaviours.ts`, give it a unique `static readonly typeName`, public
number fields as parameters (with a constructor taking a partial init), `_`
names for private state, and add it to `BEHAVIOURS`. The inspector picks it
up automatically. Override only the hooks you need. User-written behaviours are
TypeScript `Script` classes edited in the Scripts tab (see `docs/scripting.md`).

**Add a component type.** Extend `Component` (data) or `Behaviour` (hooks). The
default `clone()` copies public fields (arrays one level deep, Signals fresh,
other objects shared); override it if that's wrong. To save it with scenes,
extend `objectFields`/`dataToObject` in `serialize.ts` (see below). Systems that
process every instance should iterate `scene.query(Type)`, not the hierarchy.

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
component, extend `objectFields`/`dataToObject` in `serialize.ts` and the
round-trip test in `tests/render`, and add its key to `COMPONENT_KEYS` in `prefab.ts` so prefab instances
override it field by field.

**Change the scene format.** New keys that old readers can ignore need nothing more. For anything old readers
would misread (a renamed or reinterpreted key), bump `SCENE_VERSION` in `sceneFormat.ts` and append a migration to
`MIGRATIONS` that upgrades the previous version's documents (scenes and prefabs; rename override keys
`<component>.<field>` too), add a case to the format test in `tests/unit/prefab.test.ts`, call the bump out in the
change log, and regenerate the example projects.

**Add a material or light property.** Add the field (and copy it in `clone()`
and the `*_FIELDS` list; a material field also in `materialHash()`/`materialsEqual()`),
extend the WGSL struct and the TS packing (keep 16-byte alignment, and grow
`*_UNIFORM_SIZE` if needed), add an inspector row in `inspector.ts`, and map it
in the glTF/OBJ loaders if a standard field exists.

**Add a 2D field.** Add it to `Shape2D`/`Text2D` and to `SHAPE2D_FIELDS`/`TEXT2D_FIELDS` (the default
`clone()` copies public fields), add an inspector row in `buildShape2D`/`buildText2D`, and include it in
`Text2D.layout()`'s cache key if it changes the layout. Validate enum values in `dataToObject`.

**Add or change a sound.** Synthesized sounds are `SfxParams` (`sfx.ts`); append new parameters to the end of
`SFX_KEYS`, since saved `{ sfx }` refs are positional lists. New presets go in `SFX_PRESETS` (they show up in the
inspector's clip picker). Rendering must stay deterministic (seeded noise only). Games trigger sounds from scripts
through `AudioSource`s their builders lay out (`soundObject()` in `src/demos/shared.ts`); a sound that must outlive
its object (a destroyed pickup, a scene change) goes through `audio.play()`, because a source's voices stop with it.
Unit tests get Web Audio from `tests/unit/fakeAudio.ts` (import it first, then `audio.resume()`); `played()` in
`demos.test.ts` counts a sound's plays.

**Add a shader feature or pipeline variant.** Only for what a uniform or a placeholder texture can't do (vertex
layout, blend or depth state, bindings, a stage). Add a field to `MeshVariantKey` and to `KEY_FIELDS` (the string
form's fixed order), derive it in `meshVariantKey()` from the material, the mesh or the target, and act on it in
`MeshPipelines.describe()`: pipeline state directly; a branch inside a stage every variant of the pass has as a WGSL
`override` constant set through the stage's `constants`; different inputs, bindings or stages as another entry point
(like the shadow pass's `vs_alpha` / `fs_alpha`) or another WGSL piece in `module()`, with a new pipeline layout in
`pipelineLayout()` if the groups change. Make `allMeshVariantKeys()` produce the new values, so `test:render` builds
them, and extend `tests/unit/pipelines.test.ts`. Bind what the variant needs in the draw loops when its key says so
(`drawShadowCasters` binds the material only for `alphaTest`). A variant's vertex stage must keep indexing `objects` by the instance index.

**Add a render pass.** Declare it in `Renderer.render()` on `this.graph`, with its draw code in a private method.
Declare every texture it samples or writes, since that's what orders and culls passes and sets usage flags; textures
it only needs for this frame are transients:

```ts
const bright = g.createTexture('bright', { format: 'rgba16float', scale: 0.5 }); // or `size: [w, h]`; default: output size
g.addRenderPass('bright pass', (pass) => {
  pass.read(hdr); // sampled through a bind group made in execute
  pass.colorAttachment(bright, { clearValue: { r: 0, g: 0, b: 0, a: 0 } });
  return (encoder, res) => this.drawBrightPass(encoder, res.texture(hdr));
});
```

Passes run after the passes whose textures they read, whatever order they're declared in. A pass whose results
nothing reads is culled: write an imported texture, or call `pass.sideEffect()` (readbacks, picking). Don't create
GPU textures for per-frame targets by hand, and don't bind the frame group in a pass that writes the shadow map (use
its own group 0, like `drawShadowCasters`). A bind group over a transient texture must be remade when the pool hands
out a different texture (see `drawTonemap`). Check `tests/.out/frame.png` afterwards; a pure refactor should leave it
pixel-identical with `Math.random` seeded (the demo's flickering light is random).

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

**Change what a built game does.** Edit `src/player.ts` (boot, input, error page) or `gameHTML()` in
`src/editor/build.ts` (the page). Check it for real: `test:ui` builds the demo, unzips it to
`tests/.out/game/index.html`, plays it from `file://` and screenshots `ui-game*.png`.

**Add or change a showcase game.** Each scene of the demo project beyond `Main` is built by a function: the games
in `src/demos/` (listed in `DEMO_GAMES`; `shared.ts` has the helpers) and Gem Rush in `src/demoGame.ts`. A game's
rules are script source strings, which `tsc` never checks, so play it in `tests/unit/demos.test.ts` (that's what
catches typos) and avoid backticks and `${}` inside them. Builders only lay out objects (pools are inactive
children the script hands out), so scenes round-trip through `serialize.ts`. The engine has no bloom: halos are
stacked translucent `Shape2D` discs (`glow()`). Keep `ambientIntensity` low (0.1 to 0.3) or metals wash out (with a gradient or image sky,
`sky.lighting` takes its place: a daylight sky is much dimmer than the sun, see the `Sky` defaults), and
unlit emissive strengths near 1. The menu scene must be named `ARCADE_SCENE`, and its stands are named after the
scenes they load. `test:ui` writes `ui-<game>.png` and `ui-game-<game>.png`: **look at them**.

**Change anything in the demo project.** `buildDemoProject()` (`src/demoProject.ts`, engine-only) assembles it:
`Main` from `src/demo.ts` plus the sample models, then the showcase scenes, with fixed scene and asset ids. The
editor opens it through the normal project load on a first visit (kept in the browser), and `examples/Demo/` is the
same project as a folder. `examples/` is ignored by the engine repository: `examples/Demo/` is a git repository of its
own (the generator keeps its `.git`), so commit demo changes there. After changing a builder, a demo script or a sample model, run `npm run generate:demo` (and commit in `examples/Demo/`):
`tests/unit/demo-project.test.ts` writes a fresh copy to `tests/.out/demo-folder` (opens it, type-checks its scripts)
and, when `examples/Demo/` exists, compares every file and fails while it's stale. Changing the engine's public API
changes `examples/Demo/.messier/messier.d.ts` too, so regenerate after that as well; the same test type-checks the
demo scripts against it with `tsc`. Keep the builders deterministic (`seeded()`, no
`Math.random` or dates at build time).

**Change the Material Lab example.** `buildMaterialLabProject()` (`src/materialLab/`, engine-only) builds
`examples/MaterialLab/`, a second example project (its own git repository, like `examples/Demo/`) that shows the
material maps. Its textured meshes and materials all come from `public/models/material-lab.glb`, whose textures are
procedural (`scripts/generate-material-glb.mjs`, `npm run generate:materials-glb`); the builders only lay them out. After
changing either, or the engine's public API, run `npm run generate:materials` and commit in `examples/MaterialLab/`.
`tests/unit/material-lab.test.ts` plays both scenes, checks every map resolves after a folder round trip and fails
while the folder is stale. Both example generators share `scripts/example-project.mjs`.

**Make an edit undoable.** Push a `Command` with `undo`/`redo` closures to
`editor.history` *after* applying the change. For transform edits, use
`beginTransformEdit(obj)` / `commitTransformEdit(obj)`, which skip no-op
commands. Call `hierarchy.markDirty()` after structural changes.

**Change the sample glTF.** Edit `scripts/generate-sample-glb.mjs` and run
`npm run generate:sample`. `tests/render` asserts the lantern's mesh and light
counts, so update it too. Then run `npm run generate:demo`, because the demo project embeds the file.

**Record a change, cut a release.** Every user-visible change adds a line under `## [Unreleased]` in
`CHANGELOG.md` (Added / Changed / Fixed / Removed), in the same commit. Never edit the version by hand: it lives in
`package.json` (the editor shows it through `__APP_VERSION__`, and `flake.nix` reads it), and
`npm run release -- <patch|minor|major|x.y.z>` bumps it in `package.json` and `package-lock.json`, dates the
Unreleased section, and refreshes `npmDepsHash` in `flake.nix` (the lockfile's version field is part of that hash). It refuses with uncommitted changes or an empty Unreleased section, and prints the commit and
tag commands without running them. While 0.x, bump minor for features and breaking changes to saved files or the
script API, patch for fixes. `SCENE_VERSION`/`PROJECT_VERSION` are separate file-format numbers; call out a bump in
the change log. `tests/unit/version.test.ts` checks that it all agrees.

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
- During Play, `engine.scene` is the play copy, and the objects in it are
  different instances from the ones you edited. UI tests that read state during
  Play must look it up again through `window.engine.scene`.
- The editor boots from the IndexedDB autosave when there is one (or reopens the last project folder). `test:ui`
  relies on puppeteer's fresh temporary profile to start from the demo, and its
  project checks (reload, scenes, Save/Open) run last because they replace the
  scene. Headless Chromium has no folder picker: `test:ui` replaces `showDirectoryPicker` with one that returns a
  folder in the origin-private file system (`navigator.storage.getDirectory()`), a real
  `FileSystemDirectoryHandle`, and writes files into it with `window.__fs` to act like a file manager. When
  debugging in a normal browser, clear site data to get back to the demo.
- Chrome warns in the console when an `AudioContext` is created before a user gesture, and `test:ui` fails on
  console warnings. That's why `audio.resume()` (not `play()` or `decode()`) creates the context, and decoding uses
  an `OfflineAudioContext`. `test:ui` also launches Chromium with `--autoplay-policy=no-user-gesture-required`.
- Dawn under Node prints `maxDynamic…BuffersPerPipelineLayout artificially
  reduced` warnings. They're harmless.

## Style

- Licensing: the engine is PolyForm Shield 1.0.0 with the additional permissions in `LICENSE-EXCEPTIONS.md`.
  Don't change `LICENSE`, `LICENSE-EXCEPTIONS.md` or the `license` field without the owner, and don't copy in
  third-party code whose terms conflict with them.
- TypeScript strict, ES modules, no runtime dependencies. Keep it that way
  unless there's a strong reason.
- Match the surrounding code: small focused modules, comments that explain
  *why* (or a non-obvious layout), not what.
- 2-space indent, single quotes, trailing commas, about 140-column lines.
