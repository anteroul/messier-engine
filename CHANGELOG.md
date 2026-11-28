# Changelog

User-visible changes to Messier Engine, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (while 0.x: minor for features or
breaking changes to saved files or the scripting API, patch for fixes).

Add a line under **Unreleased** with every user-visible change.
`npm run release -- <patch|minor|major|x.y.z>` turns it into a version.

## [Unreleased]

### Added

- **Bloom:** light brighter than a threshold glows over its surroundings. The scene inspector's new **Post processing**
  section sets its strength (**Bloom**, 0 is off and the default), **Threshold** and **Scatter** (how far it spreads);
  scripts use `scene.post`. The demo's glowing orb blooms.
- **Temporal antialiasing:** **Antialiasing** in the same section switches the scene from 4× MSAA to TAA, which
  renders one jittered sample per pixel and blends it with the previous frames, following each object's motion. It
  also smooths shimmering highlights, thin lines and fine textures that MSAA leaves aliased, at the cost of a slightly
  softer image. The editor's grid, gizmos and 2D stay multisampled either way.

### Changed

- **Image-based lighting:** gradient and image skies now light the scene properly. When the sky changes it's baked
  into a prefiltered reflection map (one blur per roughness) and an irradiance map, so rough metals show a smoothly
  blurred sky instead of a resampled one, ambient light comes from the whole sky around a surface, and reflections
  dim at grazing angles as they should (split-sum BRDF). Mirror-like surfaces no longer show the sun twice (its disc
  in the sky reflection and its light's highlight).

## [0.8.0] - 2026-11-27

### Added

- **Transparent materials:** a material's new **Blend** setting (inspector, `material.blend`) is `opaque` (as before),
  `alpha` (glass, smoke: mixes by the base color's alpha, set with the new **Opacity** row) or `additive` (fire,
  beams: adds light). Blended meshes are drawn after the opaque ones, sorted back to front, don't write depth and
  cast no shadows. glTF materials with `alphaMode: BLEND` load as `alpha`.
- **Cascaded shadows:** the sun's shadows now follow the camera out to the scene's **Shadows to** distance
  (`scene.shadowDistance`, default 50 m), split into up to four **Cascades** (`scene.shadowCascades`) that keep
  near shadows sharp and still reach far, with soft transitions between them and a fade at the end. Shadow edges no
  longer shimmer as the camera moves or turns.
- **Point and spot light shadows:** **Cast shadows** now works on point and spot lights too. Up to twelve spot
  lights or two point lights (or a mix) cast shadows at once; the ones nearest to the view get them first. The demo's
  spot light casts them now.
- **Twilight Heist**, a new example project (`examples/TwilightHeist/`, `npm run generate:heist`): a stealth game in a
  castle garden at dusk. Sneak past sweeping watchtower lamps to take six coins; whatever a lamp lights sees you, so
  the shadows of hedges and statues are where you hide. It shows cascaded, spot and point light shadows, alpha-blended
  stained glass and water, and additive flames, halos and fireflies.

### Changed

- `scene.shadowExtent` (a box around the camera's target) is replaced by `scene.shadowDistance` (how far from the
  camera shadows reach). **Scene format 3**: older scenes are upgraded on load, with three times their extent as the
  distance. Scripts that set `shadowExtent` need to set `shadowDistance` instead.

### Removed

- Neon Run's engine drone.

## [0.7.0] - 2026-11-23

### Added

- **Profiler** (the ⏱ Profiler toolbar button or `F2`, also during Play): a viewport overlay with a frame-time graph,
  the engine's CPU time by phase (fixed update with scripts and physics apart, update, late update, matrices,
  render, audio), GPU time per render pass (shadow, main, tonemap, overlay; needs the browser's `timestamp-query`
  feature) and the renderer's counters. Scripts can time their own code with `profiler.begin(name)` /
  `profiler.end()` from `'messier'`. Nothing is measured while the panel is hidden.

- **Frustum culling:** meshes outside the camera's view aren't drawn, and shadow casters outside the shadow map
  aren't rendered into it. `renderer.frustumCulling = false` turns it off; the stats bar and the profiler show how
  many were culled.
- **Instancing:** objects that share a mesh and have materials that look the same (duplicates, pooled objects,
  prefab instances) are drawn with one instanced draw call. Nothing to set up: change one copy's material and it
  simply leaves the batch. `RenderStats` gained `instances` and `culled`, and `materialsEqual()` is exported.

### Changed

- `RenderStats.drawCalls` counts batches, so it drops where instancing applies, and `shadowCasters` counts only the
  casters inside the shadow map.

### Fixed

- Alpha-tested materials (alpha cutoff) now cast shadows with matching holes.

## [0.6.0] - 2026-11-18

### Added

- **Material maps:** normal, metallic-roughness, occlusion and emissive textures, with `normalScale` and
  `occlusionStrength`. glTF models load all of them; OBJ/MTL loads `map_Ke` and normal maps (`norm`, or `map_Bump`
  as Blender writes it). Normal maps need no tangents: the shader derives them per pixel from the UVs. The inspector
  has a row for each map, and scenes save them.
- **Material Lab example project** (`examples/MaterialLab/`, written by `npm run generate:materials`): a gallery that
  adds the maps one at a time, a wall of hull plating under a sweeping light, and an orbiting sun. Space toggles the
  maps in Play.
- **Prefabs:** drag an object from the hierarchy onto the Assets panel (or right-click → Create Prefab) to save it
  with its children as `assets/<Name>.prefab`, then place instances from the Assets panel. Scenes save an instance
  as a link plus its changes (edited fields, removed and added objects), so editing the prefab updates every
  instance except where it overrides it. The inspector shows an instance's changes and can Apply them to the
  prefab, Revert them or Unpack the instance. Prefabs can contain other prefabs, and a prefab made from an instance
  is a variant. Prefab files edited outside the editor update their instances. Scripts spawn instances with
  `scene.instantiate('Name')`, and built games include every prefab.

### Changed

- **Scene format version 2:** scene and prefab files carry a format version, and files from older versions are
  upgraded when they load (and saved in the new format). Version 2 saves the base color texture as
  `baseColorTexture` (it was `texture`) and adds prefab instances. Older Messier versions refuse version 2 scenes.

### Fixed

- A project folder no longer briefly reports a file the editor just wrote as removed and added again.

## [0.5.0] - 2026-11-17

### Changed

- **License:** from this version, Messier is licensed under the PolyForm Shield License 1.0.0 instead of MIT, with
  additional permissions (`LICENSE-EXCEPTIONS.md`): you may use, modify and share Messier and make and sell games
  with it, but not sell or offer Messier itself or a competing product. Versions up to 0.4.0 stay available under
  MIT.
- `examples/Demo/` left the engine repository: `npm run generate:demo` writes it, and it's a git repository of its
  own, like any game project.

## [0.4.0] - 2026-11-17

### Changed

- **Projects are folders**, like in Godot and Unity: `project.json`, one `scenes/<Name>.messier` file per scene,
  one `scripts/<Name>.ts` file per script, and `assets/` for imported files. Every asset has a `.meta` file with the
  id scenes refer to, so files moved or renamed together with it keep working. Folder projects are saved as you
  work (Chrome and Edge). Other browsers keep the project in the browser and download it as a `.zip` of the same
  folder.
- `.messier` now means a scene file. Single-file projects from earlier versions still open; save one to turn it
  into a project folder.
- The demo project in the repository is the folder `examples/Demo/`.

### Added

- Live asset sync: files copied into `assets/` from outside the editor appear in the new **Assets** panel within a
  second, loaded; changed files reload wherever they're used.
- The **Assets** panel: drag models and sounds into the viewport or hierarchy, images onto objects or the sky;
  rename and delete assets.
- Scripts edited outside the editor (VS Code) hot-reload, even during Play.
- Project folders get `.messier/messier.d.ts`, the types of the `'messier'` module scripts import from, and a
  `tsconfig.json`, so VS Code type-checks and autocompletes scripts instead of reporting "Cannot find module
  'messier'".
- **Export to Folder…** and **Export as .zip** write a copy of the project (script types included) without moving
  the editor to it.

## [0.3.0] - 2026-11-16

### Added

- Skies: a gradient sky with a sun disc that follows the scene's directional light, or an equirectangular (2:1)
  panorama image. Gradient and image skies also light the scene: metals reflect them, blurrier with roughness.
  Set them in the inspector's new *Sky* section (with nothing selected), or drop an image onto the viewport.
- Topple has a daytime sky that its sea and metals reflect.

### Fixed

- Textures loaded into a material with **Load…** are now saved with the project (they were lost on reload).

## [0.2.0] - 2026-11-16

### Added

- Audio: an `AudioSource` component that plays a clip from its object, in 2D or positioned in 3D relative to the
  camera being rendered, with volume, pitch, loop, play on start and min/max distance.
- Sound files (`.wav`, `.mp3`, `.ogg`, `.flac`, `.m4a`) import like models: they're saved inside the `.messier`
  project and included in game builds.
- A built-in sound-effect synthesizer with presets (coin, laser, explosion, hit, jump, powerup, blip, select, thump
  and a looping hum). Synthesized sounds are saved as their parameters, so they need no files.
- Editor: **＋ Add → Audio Source**, an *Audio Source* inspector section (clip picker, ▶ preview, **Vary**), a 🔊
  mute button in the toolbar and a ♪ hierarchy icon.
- Script API: `play()`, `stop()` and `playOneShot()` on sources, and `audio.play(clip, { position, … })`,
  `audio.muted` and `audio.masterVolume`. See `docs/scripting.md`.
- Sound in all demo games.

## [0.1.0] - 2026-11-14

First version.

### Added

- WebGPU forward PBR renderer: metallic-roughness shading, ACES tone mapping, directional shadow maps, up to 128
  directional, point and spot lights, reversed-Z depth.
- glTF 2.0 and OBJ/MTL model loading, from a URL or dropped files.
- Unity-style scene graph: GameObjects with a cached `Transform` and components, groups, deferred destroy,
  `instantiate`, signals and a fixed-step `Time` clock.
- Perspective and orthographic camera components.
- Rigid body physics with box and sphere colliders.
- TypeScript scripts written in the editor's code editor, compiled as you type and hot-reloaded into a running
  scene, with a keyboard `input` API.
- 2D shapes and SDF text, in world space or as a screen-space HUD.
- Editor: hierarchy with multi-selection and a context menu, inspector, move/rotate/scale gizmos, undo/redo, Play
  mode on a copy of the scene.
- Projects: several scenes, scripts and imported models in one `.messier` file, with an autosave in the browser.
- Game builds: a `.zip` with one self-contained `index.html` playing the scenes chosen in the build settings, with
  `sceneManager` to switch scenes at runtime.
- Demo project with the Arcade menu and the Neon Run, Topple, Starfall and Gem Rush games, also saved as
  `examples/Demo.messier`.
- The version is shown in the ☰ menu and the help dialog.

### Fixed

- The script editor's caret drifted from the highlighted text.

[Unreleased]: https://github.com/anteroul/messier-engine/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/anteroul/messier-engine/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/anteroul/messier-engine/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/anteroul/messier-engine/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/anteroul/messier-engine/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/anteroul/messier-engine/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/anteroul/messier-engine/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/anteroul/messier-engine/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/anteroul/messier-engine/releases/tag/v0.1.0
