# 2026-10-17 — The 40s browser hang: terrain shader compile stall (attributed) + the fix that matches the engine

Symptom: game hard-freezes the whole browser tab for ~40s–70s on boot (user reports "minutes" on a
slower/loaded box). The WebSocket starves and dies (`session died at 55ms uptime — flap damper`),
so it is a real main-thread block, not frame jank.

## Measured (E2E_GPU=1, headless Chrome, `_tools/e2e/_bootstall.ts` + `_bootmarks.ts`)

- One `gl.getProgramParameter(program, LINK_STATUS)` call blocked **33,468–71,129ms** across runs.
- `KHR_parallel_shader_compile` = **unsupported** on this path → ANGLE resolves the deferred
  D3D compile synchronously on the first link-status query (or first draw).
- The program: **terrain clipmap ShaderMaterial** — 6.1KB instanced/heightmap VS +
  **~73KB FS** (`fieldRing+scorch+splat` decal code + `shadowMap` receive + procedural stack).
- All other GL calls are noise: `useProgram` 106K calls / 70ms total, `getUniformLocation` 644,
  `linkProgram` 46 calls / 37ms total, uniform uploads ~390K calls / sub-ms each.
- Load-mark gap: `savedMapApplied` ~2–4s → `playerModelLoaded`/`networkConnected` ~40–50s —
  the freeze sits exactly in the first-render/warmup window.
- SwiftShader path boots in ~8s (Subzero JITs differently) — the hang is real-GPU-path only.

## Bisect — everything ruled OUT

| Experiment | Result |
|---|---|
| `fieldRing` decal slots 32→8 | ~39s, unchanged — the conquest ring bump is NOT the regression |
| All four decal loops `#if 0`'d (scorch/splat/ember/fieldGlow) | 36.6s — decals innocent |
| `fbmErosion`/`detailFbm` octaves capped to 2 | 71s — noise count alone isn't it |
| `lights:false` on terrain material (drops light/shadow chunks) | 66s — not the light path |
| `?shadows=off` | 38s — not the shadow map |
| Dynamic loop bounds (`scorchCount`/`splatCount`/`fieldCount` uniforms) | no compile win (kept anyway — free runtime early-out) |

Conclusion: no single block poisons it. The program is simply a ~800-line hand-written GLSL
monolith — every `terrainPreset` branch + fbm/worley/triplanar/erosion stack + decal loops +
shadow receive + fog in ONE fragment shader — and compile cost on this driver is superlinear
on structure, not bytes (a 77KB `MeshStandardMaterial` compiles in ~75ms).

## What the industry does (researched)

| Approach | Who | Texture cost | Fit |
|---|---|---|---|
| Weight map (splat) + tiled layers | Unity Terrain, UE Landscape, s&box, **T2 itself** | 1024² RGBA ≈ 4MB raw / ~500KB | Best long-term |
| Baked macro base + runtime detail | Torque3D lineage | 1024–2048² RGB ≈ 3–12MB | **Best for this engine** |
| Full albedo bake | nobody at runtime | 4096²+ ≈ 50MB+, blurry up close | No — user was right |
| Megatexture / virtual texturing | id Tech 5 / RAGE / **ET:QW** (literally this genre) | 128K² virtual, tile-streamed | Absurd scope |

Key numbers from research:
- Splat/weight-map resolution: **~1–2 px/m** is the standard (Unity defaults 512²/1km;
  1024² here = 0.25–4m/texel — soft blend edges don't need more).
- RGBA = 4 layers; a 5th is implied (`1 − Σ`); more layers = more maps.
- Anti-tiling ladder: different tile rates per layer (free) < rotated double-sample
  (cheap, 2 fetches) < hex-grid stochastic (9 fetches/layer, best) — or just let
  macro weight variation hide the tiling, which it mostly does.
- Rebake patterns: T2 `.ml` lightmaps are CRC'd to the `.mis` (edit → relight);
  Torque3D does dirty-region splat re-uploads. For us: weights/base are a pure
  function of (map, preset, heightfield) → regen on map load or via `mapbake`.

T2's own Texture Editor placed materials by `Height | Slope | Water Level | Fractal` rules
into a ≤4-texture blend + separate `.ml` baked lightmap — i.e., option A is literally the
T2 pipeline.

## What the engine already has

- `matTiles` / `matAlphaA` / `matAlphaB` / `useMats` + `setMaterialBlend()` — the T2
  splat-blend path, in-shader today, used only by T2 ports.
- `albedoMap` / `useAlbedo` / `setAlbedo()` — baked-albedo path (T2 `terrainTex`).
- `_tools/mapbake/genmap.js` — offline bake tooling.
- `rendererSetup.warmup()` → `compileAsync` — mitigation (moves stall behind the boot
  veil, cannot beat a 40s compile — keep anyway).
- `_tools/e2e/_bootmarks.ts` — streaming stall probe: heartbeats, per-GL-call timing
  totals, stalled-program attribution via `__glstall` shader markers.

## Recommendation

**Now: bake the macro base, keep the runtime thin.**
Evaluate the preset stack (fbm warps, worley, triplanar, erosion, palette) once per
(map, preset) into a 1024–2048² base-color texture — worker at map load, or `mapbake`
for zero runtime cost. Runtime shader drops to `albedo fetch + tiled detail + micro
noise + decals + fog + shadow` ≈ ~15KB → ~100ms compile, and per-fragment cost collapses
too (the same noise stack runs every fragment every frame today — part of why weak-GPU
runs show `LOW FPS sustained`).

**Later: weight map + tile atlas** — presets emit layer weights instead of final color;
real 256px tiles carry close-up detail through the existing `useMats` path. Bigger
refactor, better end state, actual T2 fidelity.

**Fallback if neither lands soon:** `terrainPreset` is a runtime uniform — all preset
branches compile into every program. Bake it as `#define` per material (rebuild on
`setPreset`) → each program compiles ~1/Nth the code. Cheap partial win.

**Keep regardless:** `warmup`/`compileAsync`, decal count bounds, and a debug escape
hatch (`?terrain=live` for shader iteration). Optional watchdog: log shader markers
when a program-status query exceeds ~5s — the probe already proves it detectable.

## Caveats

- Stall magnitude varied 33–71s across identical runs — system contention inflates it;
  the mechanism is stable regardless.
- Whether `E2E_GPU` headless lands on the real GPU vs a fallback backend is unverified
  in these runs (`gpu.renderer` field exists in `_bootstall.ts` — grab it next time).
- The exact three.js call issuing the fatal `getProgramParameter` wasn't pinned
  (link-status inside compile/first-use — doesn't change the fix).
- `nodeMarkers.hot` / `buildBy` wire additions from the conquest HUD work are unrelated
  to this stall.
