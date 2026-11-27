# Roadmap

Where Messier is going, in the order it gets built. Each phase unblocks the next: foundations come first because
later features build on them.

**Status:** `[x]` done · `[ ]` planned · `[?]` decision to make (settle it before the items that depend on it).

**The rule:** after each phase, build and finish a small game in Messier. Add nothing to the engine just for that
game; write down every workaround and frustration, and let that list order the next phase.

When you finish an item, tick it here in the same commit and note the version it shipped in once released. Link an
item to its design doc in `docs/design/` when it has one.

## Phase 0: Foundations (done)

- [x] Prefabs + versioned scene format (0.6.0)
- [x] Render pass / frame graph (0.6.0)
- [x] Shader variant system (0.7.0)
- [x] GPU + CPU profiling in the editor (0.7.0)
- [x] Frustum culling + instancing (0.7.0)

## Phase 1: Render quality

- [x] Full PBR texture set: normal, metallic-roughness, occlusion, emissive (0.6.0; tangents derived per pixel)
- [ ] Prefiltered IBL (split-sum)
- [x] HDR render target + tonemap pass (0.6.0)
- [ ] Post stack: bloom, TAA
- [ ] Cascaded shadows, spot and point shadows
- [ ] Transparency sorting

## Phase 2: Animation

- [ ] GPU skinning + glTF animation clips
- [ ] Blending, layers, animation state machine
- [ ] Morph targets, root motion, animation events

## Phase 3: Physics

- [ ] Implement Rapier for more advanced physics.
- [ ] BVH broad phase
- [ ] Capsule, convex and mesh colliders
- [ ] Triggers, collision layers, joints
- [ ] Character controller
- [ ] Continuous collision detection + buoyancy

## Phase 4: Game systems

- [ ] Input actions: gamepad, touch
- [ ] GPU particles + editor
- [ ] Game UI system
- [ ] Async loading + scene streaming
- [ ] Audio mixer + buses
- [ ] Save data, tweens, timers
- [ ] Navmesh + pathfinding

## Phase 5: Scale

- [ ] Clustered forward lighting
- [ ] LOD + compressed assets (KTX2 / meshopt)
- [ ] GPU-driven + occlusion culling
- [ ] Terrain + foliage

## Phase 6: Platform

- [?] WebGL2 fallback: current answer is skip (WebGPU-only).
- [ ] Mobile quality tiers
- [ ] Plugin / package system
- [ ] Networking: WebSocket, WebRTC
- [ ] Desktop export: Tauri / Electron
- [ ] Docs, tutorials, templates

## Rough timing (solo)

| Phases | Estimate |
| --- | --- |
| 0–1 | 3–6 months |
| 2–3 | 6–9 months |
| 4–5 | a year or more |
