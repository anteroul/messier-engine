# Changelog

User-visible changes to Messier Engine, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (while 0.x: minor for features or
breaking changes to saved files or the scripting API, patch for fixes).

Add a line under **Unreleased** with every user-visible change.
`npm run release -- <patch|minor|major|x.y.z>` turns it into a version.

## [Unreleased]

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

[Unreleased]: https://github.com/anteroul/messier-engine/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/anteroul/messier-engine/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/anteroul/messier-engine/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/anteroul/messier-engine/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/anteroul/messier-engine/releases/tag/v0.1.0
