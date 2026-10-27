---
name: run
description: Launch the Messier editor in headless Chromium with WebGPU, optionally drive it with JS (select, play, switch view, tweak a material), screenshot it and report console errors. Use to see a change working in the real app, to reproduce a bug visually, or when asked to run, start or screenshot the app. Also explains how to start the dev server for the user.
argument-hint: "[what to show, e.g. 'play mode' or 'select the torus']"
allowed-tools: Bash(nix develop .#tests -c node .claude/skills/run/shot.mjs:*), Bash(nix shell nixpkgs#nodejs_22 -c npm install), Read
---

# /run: see the editor running

Request: `$ARGUMENTS`

WebGPU needs special Chromium flags on this NixOS machine, so don't open a
browser by hand. `shot.mjs` (next to this file) does the whole job: it starts
Vite, launches Chromium with the flags from `tests/ui`, waits for
`window.editor`, runs your JS, saves a screenshot and lists console errors and
warnings.

## 1. Prerequisites

- Root `node_modules` must exist. If it doesn't, run `nix shell nixpkgs#nodejs_22 -c npm install`.
- `tests/node_modules` provides puppeteer. If it's missing, run
  `nix develop .#tests -c sh -c 'cd tests && npm install'`.

## 2. Take the screenshot

```sh
nix develop .#tests -c node .claude/skills/run/shot.mjs \
  [--eval '<js>']... [--out tests/.out/run-<name>.png] [--wait 500] [--size 1400x820] [--url URL]
```

- Each `--eval` is an async function body with `engine` and `editor` in
  scope. Its return value is printed as `eval: <json>`, so return the state
  you want to check. The evals run in order, with a 200 ms pause after each.
- Every run uses a fresh browser profile, so the **demo scene** loads, not an
  autosave.
- With no `--url`, it starts its own Vite server on port 5198 (override with `RUN_PORT`).
  Pass `--url http://localhost:5173/` to reuse a dev server that's already running.
- Use a descriptive `--out` name when you take several shots. `tests/.out/`
  is scratch output.

Useful evals (check `src/editor/editor.ts` if a name has changed):

| Goal | `--eval` |
|---|---|
| Select an object | `editor.select(engine.scene.findByName('Torus')); return editor.selected?.name` |
| Enter Play, let it run | `editor.togglePlay(); await new Promise(r => setTimeout(r, 1500)); return engine.playing` |
| Scripts tab | `editor.setView('scripts')` |
| View through the scene camera | `engine.useSceneCamera = true` |
| Change a material | `const o = engine.scene.findByName('Torus'); o.material.roughness = 0.05` |
| Move the editor camera | Read `src/engine/camera.ts` first and set the look-at fields |

Exit codes: `0` means the shot was taken and the console was clean, `2` means
the shot was taken but there were console errors or warnings (`test:ui` would
fail on them), and `1` means the editor didn't start or an eval threw.

## 3. Look at it

**Read the PNG** with the Read tool. Don't report success from the exit code
alone. Check for the specific thing you were asked to show, then for
regressions: black or missing meshes, missing shadows, z-fighting on the floor
grid, a broken panel layout, or a gizmo in the wrong place.

If `#error` says "WebGPU unavailable", the GPU or Vulkan setup failed. That's
an environment problem, so report it and don't change any code.

## 4. Report

Say what you ran, show the `eval:` results, and describe what the screenshot
shows (give its path). List any console messages word for word.

## Running it for the user

If the user wants to use the editor themselves, don't start a long-running
server in the background. Tell them to run `nix run` (dev server at
http://localhost:5173) or `nix run .#serve` (production build on :8080), and
to use a Chromium-based browser. On Linux they may need
`--enable-unsafe-webgpu --enable-features=Vulkan`.
