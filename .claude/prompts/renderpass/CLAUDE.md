Implement a frame graph (render graph) for Messier's renderer and port the existing passes onto it. This is a
refactor: the rendered image must not change.

## Context

- Read AGENTS.md first, especially "Invariants", the bind-group rules and "Verify every change". Prefabs and the
  material maps just landed; don't change them.
- Today `Renderer.render()` in `src/engine/renderer.ts` hard-codes the frame:
  1. a shadow pass into a persistent 2048² `depth32float` map (normal Z, clear 1), only when a shadow-casting
     directional light exists;
  2. the main pass: 4× MSAA color plus reversed-Z depth (clear 0), resolved into the canvas texture, with color and
     depth stores discarded. In order, it draws meshes, the sky, the grid, world 2D, the depth-tested overlay,
     screen 2D/HUD, then the top overlay.
  `resizeIfNeeded()` creates the MSAA and depth textures by hand. Mipmap generation runs when a texture is uploaded,
  outside the frame; leave it there.
- Upcoming features (an HDR target plus a tonemap and bloom pass, TAA, cascaded and spot shadows, a depth pre-pass,
  a picking pass) each add passes and transient textures. The graph exists so those can be added without editing
  existing passes.

## Build `src/engine/frameGraph.ts`

The graph must not import from the renderer or touch the DOM. It's plain logic plus WebGPU calls, so its scheduling
can be unit-tested against a fake device.

1. **Resources**
   - *Transient textures*: a descriptor of format, size (absolute `[w, h]`, or a scale of the output size),
     sampleCount and mipLevelCount. Usage flags are inferred from how passes use the texture.
   - *Imported textures*: the canvas texture (new each frame) and persistent textures the renderer owns (the shadow
     map). The graph never allocates or frees these.
   - Passes refer to resources through typed handles, not strings.
2. **Passes**: `addRenderPass(name, setup)`. `setup(builder)` declares the resources the pass reads and its
   color/depth attachments (clear values, load ops, resolve target), and returns
   `execute(passEncoder, resources)`. Also add `addComputePass` with storage-texture reads and writes, so bloom and
   IBL prefiltering fit later. A pass can be marked `sideEffect` so it is never culled.
3. **Compile (each frame)**
   - Order passes by their dependencies; where there's no dependency, keep declaration order.
   - Cull passes whose outputs nothing reads, unless they write an imported resource or are `sideEffect`.
   - Compute each transient's first and last use, and allocate it from the pool.
   - Fail clearly when a pass reads a resource nothing writes, or when there's a cycle.
4. **Pool**
   - Keyed by descriptor.
   - Within a frame, reuse a texture whose lifetime has already ended (aliasing).
   - Reuse textures across frames.
   - Destroy entries idle for 3 frames, and everything when the output size changes.
5. **Store ops**: an attachment no later pass reads gets `storeOp: 'discard'` automatically. That matches today's
   MSAA color and depth.
6. **Execute**: one command encoder, a debug group named after each pass.

## Port the renderer

- Rebuild `render()` as: describe the graph, then compile and execute it.
- Move the existing draw code into private methods (`drawShadowCasters`, `drawMain`, …) unchanged. Don't rewrite
  the draw logic.
- The shadow map stays an imported persistent texture, so the frame bind group that holds its view doesn't change.
  Keep the shadow pass on its own group 0; binding the frame group there would cause a usage conflict.
- Remove the hand-made MSAA and depth textures from `resizeIfNeeded()`. A size change now just sets the graph's
  output size.
- `RenderStats` counts stay identical, and the 2D/overlay draw order stays exactly as it is.

## Tests

- **test:unit**: add `tests/unit/frameGraph.test.ts` with a fake GPU device. Cover:
  - ordering by dependencies;
  - culling of unread passes;
  - imported and `sideEffect` passes surviving culling;
  - two transients with the same descriptor and non-overlapping lifetimes sharing one texture, and none sharing
    when lifetimes overlap;
  - reuse across frames, and release after 3 idle frames and on resize;
  - discard vs store inference;
  - the read-without-writer and cycle errors.
- **test:render**: before changing anything, run it and copy `tests/.out/frame.png` aside. After the port, compare
  the two images pixel by pixel; they should be identical. Look at both.
- **test:ui** must pass. WebGPU validation warnings fail it, which is the check that the usage flags inferred for
  the pool are right.

## Docs

- In AGENTS.md:
  - update the `renderer.render` line in the architecture diagram;
  - add a "Frame graph" bullet;
  - add a "Add a render pass" entry under Common tasks, with a short example;
  - fix any text that describes how the MSAA and depth textures are made.
- No CHANGELOG entry: nothing user-visible should change.

## Not in scope

HDR targets, moving tone mapping out of the shaders, bloom, new shadow types, shader or pipeline changes, new
dependencies.

## How to work

Work in steps and verify each one with the commands AGENTS.md lists:
1. the graph and its unit tests;
2. port the shadow and main passes, then compare the frame;
3. clean up and update the docs.

Commit after each step. If keeping the output identical forces a design compromise in the graph, stop and tell me
instead of working around it.
