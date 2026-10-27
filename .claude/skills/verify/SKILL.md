---
name: verify
description: Verify a change to Messier Engine before claiming it works. Picks the checks the diff needs (typecheck, build, GPU render + UI smoke tests, Nix build for dependency changes), runs them, and looks at the rendered frame and UI screenshots. Use after finishing any code change, before committing, or when asked to test or check the work.
argument-hint: "[--all | --quick]"
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(nix shell nixpkgs#nodejs_22 -c npm run typecheck), Bash(nix shell nixpkgs#nodejs_22 -c npm run build), Bash(nix develop .#tests -c sh -c:*), Bash(nix build path:.), Read, Grep
---

# /verify: prove the change works

Arguments: `$ARGUMENTS` (`--quick` = only typecheck; `--all` = every tier
regardless of the diff).

Never say something works on the strength of a check you didn't run. If you
skip a tier, say why.

## 1. Decide what to run

Look at `git status --short` and `git diff HEAD --stat`, including untracked files.

| Changed | Run |
|---|---|
| Anything in `src/`, `index.html`, `tests/` | typecheck + build |
| `src/engine/**`, `*.wgsl`, `src/engine/typescript.ts`, `serialize.ts`, `tests/render/**` | + `test:render` |
| `src/editor/**`, `index.html`, CSS, `src/main.ts`, `src/demo.ts`, `public/`, `tests/ui/**` | + `test:ui` |
| Root `package.json` / `package-lock.json` | + Nix build (step 5) |
| Only docs (`*.md`) | nothing; say so |

When in doubt, run both GPU tests. The engine is shared, so an engine change
can also break the editor.

## 2. Typecheck and build

```sh
nix shell nixpkgs#nodejs_22 -c npm run typecheck
nix shell nixpkgs#nodejs_22 -c npm run build
```

`noUnusedLocals` and `noUnusedParameters` are on, so fix leftovers instead of
silencing them. Stop here if either fails. The GPU tests won't tell you anything more.

## 3. GPU smoke tests

Run the tests you picked (for both, use `npm test`):

```sh
nix develop .#tests -c sh -c 'cd tests && npm install && npm run test:render'
nix develop .#tests -c sh -c 'cd tests && npm install && npm run test:ui'
```

Read the output carefully:

- Each check prints `PASS` or `FAIL`. Quote every `FAIL` line. The run ends
  with `ALL PASSED` or `N FAILURE(S)`.
- Ignore `maxDynamic…BuffersPerPipelineLayout artificially reduced` lines. They're harmless Dawn noise.
- In `test:render`, a warning about glTF textures failing to load is
  expected, because `createImageBitmap` is stubbed under Node.
- `test:ui` fails on **any** console error or warning. When that check fails,
  find the message that caused it and decide whether your change caused it.
- If Vulkan or Chromium can't start (no adapter, `WebGPU unavailable`), that's
  an environment problem. Report it as **not run** and don't count it as a
  pass or blame the code.

## 4. Look at the images

This step is required whenever renderer, shader, material, light or editor UI
code changed.

- `test:render`: Read `tests/.out/frame.png`. It should show the lit demo
  scene with shadows on the floor. Look for black or missing meshes, NaN
  speckles, inverted depth (far objects drawn over near ones), lost shadows,
  or blown-out or flat lighting.
- `test:ui`: Read the `tests/.out/ui-*.png` files that relate to the change
  (`ui-final.png` always, `ui-playing.png` for Play/physics/scripting,
  `ui-scripts*.png` for the Scripts tab, `ui-camera-*.png` for cameras). Check
  that panels are laid out correctly and that the gizmo and grid render.

The images don't come with a baseline. Compare them against what the change
should produce, and if a previous run's images are open in this conversation,
compare against those too. To see something the tests don't capture, use the
`run` skill.

## 5. Dependency changes only

```sh
nix run nixpkgs#prefetch-npm-deps -- package-lock.json
```

Put the hash in `npmDepsHash` in `flake.nix`, then run `nix build path:.`.
`tests/package-lock.json` isn't part of the Nix build.

## 6. Report

```
Verification
- typecheck: pass | fail | skipped (reason)
- build:     pass | fail | skipped (reason)
- render:    pass | N failures | not run (reason) — frame.png: <one line on what it shows>
- ui:        pass | N failures | not run (reason) — <screenshots checked>
- nix build: pass | fail | n/a
```

Then one line with the verdict: **verified**, or **broken** followed by the
first failure to fix. If something failed, quote the relevant output. Don't
just summarize it.
