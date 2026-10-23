---
name: cr
description: Code review the changes made in Messier Engine (uncommitted work by default, or a given commit/range/branch). Checks correctness and this repo's invariants from AGENTS.md (uniform layouts, reversed-Z, engine/editor boundary, undo, docs), runs typecheck/build, and reports ranked findings. Read-only; never edits code unless asked afterwards.
argument-hint: "[ref | range | --staged | --gpu]"
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git show:*), Bash(git rev-parse:*), Bash(nix shell nixpkgs#nodejs_22 -c npm run typecheck), Bash(nix shell nixpkgs#nodejs_22 -c npm run build), Read, Grep, Glob
---

# /cr: review the changes

Review the changes for **bugs and broken invariants**. Don't comment on style
unless it breaks the conventions in `AGENTS.md`. Don't edit any files. Report
your findings and stop.

## 1. Work out what to review

Arguments: `$ARGUMENTS`

- No argument: review all uncommitted work, meaning `git diff HEAD` plus any
  untracked files (`git status --short`). Read untracked source files in full.
- `--staged`: review only `git diff --cached`.
- A ref, range or branch (`HEAD~1`, `main..feature`, `abc123`): review
  `git diff <range>`. A single commit means `git show <ref>`.
- `--gpu`: can be combined with any of the above. It also runs the GPU smoke
  tests (see step 4).

If the diff is empty, say so and stop. Run `git diff --stat` first to see how
big the change is.

## 2. Load the context

- Read `AGENTS.md`. Its invariants and "Gotchas" sections are the review checklist.
- For each changed hunk, read enough of the surrounding file to understand it.
  Follow the callers and callees of any changed function. Most bugs come from
  the interaction between the diff and code it didn't touch.

## 3. Review

Look for real defects first:

- Logic errors, wrong conditions, off-by-one, null or undefined paths, stale
  cached state, and missing cleanup (GPU buffers, event listeners).
- Behaviour that breaks for an input the diff didn't consider (zero-size
  canvas, empty scene, hidden objects, object deleted during Play, undo after
  deletion).

Then check the repo-specific invariants that the diff touches:

- **Uniform layouts** are mirrored by hand between TS and WGSL (`Frame` 176 B,
  `Light` 64 B, `Material` 48 B, `Object` 128 B in 256 B slots). A change on one
  side without the other is a high-severity finding. Check 16-byte alignment
  and the `*_UNIFORM_SIZE` constants.
- **Depth:** the main pass uses reversed-Z (clear 0, `greater`, `perspectiveReversedZ` or
  `orthoReversedZ`). The shadow map uses normal Z. Flag any mix-up.
- **Math conventions:** matrices are column-major, `mat4.multiply(a, b)` = a·b,
  quaternions are `[x, y, z, w]`, Euler angles are degrees in XYZ order, and
  lights and cameras face local −Z.
- **Engine/editor boundary:** `src/engine/**` must not import from
  `src/editor/**` or touch the DOM beyond the canvas. The editor imports only
  through `src/engine/index.ts`. The `scripting.ts` → `./index` import must
  stay lazy.
- **Components:** new fields are copied in `clone()` / `copyFrom()`. Values
  that scripts can change are restored by the editor's Play snapshot. New
  public engine types are exported from the barrel.
- **Editor edits** push undo `Command`s *after* applying the change, use
  `beginTransformEdit` and `commitTransformEdit` for transforms, and call
  `hierarchy.markDirty()` after structural changes.
- **Shortcuts and toolbar:** a new shortcut lives in `bindKeyboard()` and
  respects the Play rules (plain keys go to `input`). It must also appear in
  the help table in `index.html` and the README controls table.
- **Meshes:** after mutating vertices, the code calls `mesh.destroy()` and
  `computeBounds()`. Procedural meshes call `fixWinding()`.
- **Typed arrays** passed to `writeBuffer` are `Float32Array<ArrayBuffer>`.
- **Type stripper** changes only blank text or replace it in place, never
  insert characters. There should also be a new snippet in
  `tests/render/ts-corpus.ts`.
- **WGSL:** `textureSample` stays in uniform control flow, and `common.wgsl`
  declarations aren't redeclared.
- **Tests and docs:** behaviour changes should come with a test in
  `tests/render` or `tests/ui`. User-visible changes should be reflected in
  `README.md` / `AGENTS.md`.

Before reporting a suspected bug, confirm it by reading the code. Drop
anything you can't back up with a concrete scenario.

## 4. Verify

Run `nix shell nixpkgs#nodejs_22 -c npm run typecheck`, then `npm run build`
the same way. Report any failures as findings and include the compiler output.

With `--gpu`, also run
`nix develop .#tests -c sh -c 'cd tests && npm install && npm test'`. If
shaders or rendering changed, look at `tests/.out/frame.png`. Ignore the
`artificially reduced` warnings, because they're harmless.

## 5. Report

Write one numbered list, most severe first:

```
1. [high|medium|low] path/to/file.ts:LINE: one-line statement of the defect
   Scenario: concrete input/state → wrong result.
   Fix: the smallest change that would fix it.
```

- **high:** crashes, GPU validation errors, wrong rendering, data loss, broken
  undo, or broken engine/editor boundary.
- **medium:** wrong behaviour in edge cases, missing Play-snapshot or clone
  handling, missing tests for new behaviour.
- **low:** missing docs or help-table entries, and simplifications that remove real risk.

Then end with:
- **Verification:** what you ran and its result (pass, fail, or not run).
- **Verdict:** one line, either *ready to commit* or *needs changes* (list the
  finding numbers).

If nothing survives verification, say so plainly. Don't pad the list.
