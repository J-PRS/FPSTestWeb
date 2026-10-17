# Shader-compile boot stall — investigation report

Why the game froze the entire browser for tens of seconds (felt like
minutes) at boot, what we measured, what was wrong, and the rules for
writing shaders so it never comes back.

## Symptom

Boot → black screen → browser-wide freeze ~30s+ (main thread AND other
tabs unresponsive), then the veil drops. Long-task instrumentation:
one monolithic animation frame of 28–37s during first render.

## Root cause stack (all of it had to combine)

1. **three.js compiles synchronously.** `renderer.compileAsync()` calls
   `this.compile()` synchronously — per program it does compileShader +
   linkProgram + **uniform introspection** (`getActiveUniform` × N)
   inline. `KHR_parallel_shader_compile` only makes the *status poll*
   non-blocking; link + introspection stay serial. ~10s of one boot
   frame was inside `WebGLUniforms` alone (JS self-profile).
2. **ANGLE→D3D11 is the slow path.** Every shader is GLSL → HLSL
   translate → FXC compile → link, serialized in the GPU process, each
   `getProgramParameter` round-trips and waits. Measured ~0.5–0.7s per
   program on an RTX 3070 Ti.
3. **The killer: constant-bound loops over uniform arrays.** ANGLE's
   D3D11 backend fully unrolls `for (int i = 0; i < 16/24/32; i++)`
   loops over uniform arrays. The terrain decal system (scorch 16 +
   splat 24 + field 32 = 72 iterations of projected-decal math) blew one
   fragment shader to ~72KB and ~33s of sync compile in a single
   program. THIS was the whale — not "52 programs" per se.

## Measurements (same machine, same ~43–52 programs, RTX 3070 Ti)

| ANGLE backend | Boot→connected | Worst frame | Total blocked |
|---|---|---|---|
| D3D11 (Chrome default) | ~30s+ | **28–37s** | 42–67s |
| OpenGL (`--use-angle=gl`) | 7.4s | 4.1s | 18.7s |
| Vulkan (`--use-angle=vulkan`) | 8.2s | — | — |

GL/Vulkan compile the same shaders ~5–7× faster (native NVIDIA GLSL /
glslang→SPIR-V, no FXC). Vulkan loses `KHR_parallel_shader_compile`.
`chrome://flags` → "Choose ANGLE graphics backend" → OpenGL is a fine
dev-side mitigation — **not a player fix**.

## The disk-cache reframe (important)

Chrome keeps a GPU shader disk cache keyed by shader-source hash.
Measured with a persistent profile (`E2E_PROFILE=1`):

- Cold profile: init ~61s
- **Same profile, second boot: init ~2.2s**

So the freeze is a **first-compile** event: a player's first-ever boot,
and every release that changes shader source text (any edit to shader
strings, defines, or material flags → different key → cold compile).
Devs feel it constantly because every shader edit invalidates. Sources
are deterministic — no per-boot randomization busting the cache.

Consequence: the optimization target is *cold-compile cost* =
programs × per-program D3D11 compile+introspection (~1s each at
~48 programs ≈ the observed stall). Program count and uniform count
(introspection is per-uniform `getActiveUniform` round-trips) are the
levers, not just wall-clock size.

## Program census (typical boot, ~48)

- ~24 lit-pipeline permutations @ ~34KB (Basic/Lambert/Standard ×
  fog/map/vertexColors/blending/index-type flags — partially
  geometry-driven, limited merge upside)
- ~12 heavy shaders @ 66–97KB (terrain splat+decals, atmosphere, sky,
  Standard+shadows+skinning)
- 2 legit unique `onBeforeCompile` shaders (wing flap, vertex-alpha)
- ~10 small (depth/shadow-map, sprite, points, lines)
- Count varies 42–52 per boot: async content arrival mints programs at
  different times. Not a fixed number.

## Failed approaches (do not retry)

- **Chunked compile** (compile N objects per frame): standalone object
  compilation sees different scene light/fog state → different cache
  keys → **91 programs instead of 52**, worst frame 73s. Program
  identity is scene-state-dependent; you cannot shard it.
- **compileAsync as a cure**: same serial work, just deferred.
- Merging flag-only material variants: ~8–12 programs ≈ 6–9s saved —
  worth doing eventually but was never the freeze.

## Fix that landed

`client/src/world/terrainShaders.ts` + `terrain.ts`: decal loops now
bound on a **uniform int** (`scorchCount`/`splatCount`/`fieldCount`)
with an early `break`. A dynamic bound keeps the loop rolled in the
compiled shader; constant bounds invite full unroll. Exact runtime cost
preserved (break at same count); compile size and time collapse.

## Rules for new shader code

1. **Never loop over a uniform array with a constant bound on WebGL.**
   `for (i < MAX)` + `if (arr[i].w <= 0) continue` = unrolled giant.
   Always `uniform int xCount` + `if (i >= xCount) break`.
2. Monster shaders (>60KB source) are compile-risk items — audit them
   for unrollable loops before shipping.
3. Verify with `bun _tools/e2e/_bootstall.ts --bots 8 --secs 15` +
   `E2E_GPU=1` (real GPU). Watch `worst frame` and `totalTaskMs`.
4. Program count still matters linearly on D3D11 — prefer shared
   materials/uniform-driven branches over flag permutations.

## Diagnostics tooling

- `_tools/e2e/_bootstall.ts` — injects longtask/rAF observers pre-nav,
  dumps worst frames w/ script attribution, GPU renderer string,
  program count, shader source sizes, material census, cache keys
  (`progkeys.json`), JS self-profile.
- `E2E_ANGLE=vulkan|gl` env var (`_tools/e2e/browser.ts`) switches the
  ANGLE backend for A/B measurement.
