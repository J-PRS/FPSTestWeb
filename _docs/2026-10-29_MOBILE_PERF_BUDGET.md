# Mobile perf budget — where we stand vs published targets

> Measured 2026-10-29 on the phone pipeline (`_docs/2026-10-29_PHONE_PROFILING.md`).
> Device: Redmi K70 — Snapdragon 8 Gen 2 / Adreno 740, 1440×3200 @120Hz.
> Sample: `/s/ctf-1` room, 16 bots configured, menu/lobby state (no playerId
> yet — pre-combat numbers, real match may differ).
> Source script: page-target CDP eval over `adb forward tcp:9333`.

## Us vs the budgets

| Metric | Us | Mobile 30 fps target | Mobile 60 fps target |
|---|---|---|---|
| fps | **~16** | 30 | 60 |
| Draw calls | **~502** | 100–150 | 50–100 |
| Triangles | **~429k** | 150–300k | 100–200k |
| GL buffer | 2527×1421 (~3.6 MP) | fine post-clamp | — |

We're **~3–5× over on draw calls** and **~1.5–2× over on triangles**.
That's the whole story of the 16 fps: every draw call is CPU→driver
overhead, and the K70's weak side is its CPU (N100-class) not its GPU.

## Sources

- **Arm GPU Best Practices** (Mali guidance, applies directionally to
  Adreno): *<500 draw calls/frame on OpenGL ES, <1000 on Vulkan* — we're
  AT the GLES ceiling, which is the "you're already in trouble" line,
  not a target. Batch/instancing is Arm's #1 recommendation.
  https://support.arm.com/documentation/101897/0304
- **Arm geometry budget**: *≤250k input triangles/frame* (~125k visible
  after clip+cull). We're at 429k rendered — over even the input limit.
  https://support.arm.com/documentation/102537/0100
- **PlayCanvas guidelines**: *100–200 draw calls for low-end mobile.*
  https://developer.playcanvas.com/user-manual/optimization/guidelines/
- **Hology/three.js perf docs**: *<150 draw calls for mid-tier mobile.*
- **DevForge budget calculator** (Unity-derived, direction is right):
  30 fps → ~100–150 calls / 150–300k tris; 60 fps → ~50–100 calls /
  100–200k tris.
- Field reports consistently show ~140 calls ≈ 58 fps on a Galaxy S21
  where 380 calls gave 38 fps — i.e. call count maps near-linearly to
  fps in this range.

## What the numbers imply

- Draw calls are the first bottleneck (CPU-bound dispatch), tris second
  (vertex bandwidth). Fill is fine since the maxTex clamp brought the
  buffer to ~3.6 MP.
- Suspects for the ~500 calls: per-player model meshes (16 bots + own
  viewmodel + remotes), structures/props, terrain chunks, VFX pools.
  Species already instance; players/props/structures likely don't.
- To hit 30 fps on this device: get under ~150 calls and ~300k tris.
  To hit 60: ~100 calls, ~200k tris, plus dynamic res scale.

## Next steps

1. Break down `renderer.info.render.calls` by scene subtree (players /
   structures / terrain / VFX / HUD) — find the 300+ calls to merge.
2. Re-profile spawned into actual combat (playerId set) — current sample
   is pre-spawn and flatters the real workload.
3. Candidates: merge static structure meshes per material, InstancedMesh
   for repeated props, character LOD, terrain chunk LOD.
