# Fog-to-Horizon Blending: How It Works

## Overview

Our terrain fog system uses a classic technique where the fog color **exactly matches** the sky horizon color, making fully-fogged terrain invisible against the sky. This is fundamentally different from modern fog approaches and produces a seamless horizon without any visible transition line.

## The Problem We Solved

### Color Space Mismatch

The renderer uses `THREE.ACESFilmicToneMapping` with sRGB output encoding. Three.js `ColorManagement` converts hex colors (sRGB) to linear space internally. The pipeline is:

```
THREE.Color(0xbbd0e8)  →  linear space  →  shader uniform  →  tone mapping  →  sRGB output
```

The bug: the sky shader hardcoded `vec3(0.7333, 0.8157, 0.9098)` — these are sRGB values for `0xbbd0e8`. But the renderer treats shader output as linear and encodes it to sRGB again. This **double-encoding** made the sky horizon much brighter than the terrain fog, which correctly went through the linear→sRGB pipeline once.

| Component | Input | Encoding | Result |
|-----------|-------|----------|--------|
| Terrain fog | `THREE.Color(0xbbd0e8)` (linear) | linear → sRGB | Correct `0xbbd0e8` |
| Sky horizon (old) | `vec3(0.7333, 0.8157, 0.9098)` (sRGB, treated as linear) | sRGB → sRGB | Double-encoded, too bright |
| Sky horizon (fixed) | `THREE.Color(0xbbd0e8)` (linear) | linear → sRGB | Correct `0xbbd0e8` |

### The Fix

1. **Sky shader now receives `fogColor` as a uniform** — a `THREE.Color` already in linear space, identical to what the terrain shader receives. Both go through the same linear→sRGB output encoding, producing the exact same on-screen color.

2. **Flat horizon band** — the sky shader outputs exactly `fogColor` for `vHeight < 0.02` (near-horizon directions), then transitions to `zenithColor` via `smoothstep(0.02, 0.45, vHeight)`. This means the sky at the horizon is a solid band of fog color, not a gradient that happens to be close.

## How It Works

### Terrain Fog (Fragment Shader)

```glsl
float fogDist = length(vWorldPos - vCameraPos);
float fogFactor = smoothstep(fogStart, fogEnd, fogDist);
// Height-augmented fog: tall terrain at distance gets extra fog
float heightFog = smoothstep(fogStart * 0.6, fogEnd * 0.7, fogDist)
                 * smoothstep(0.3, 0.8, height);
fogFactor = clamp(fogFactor + heightFog, 0.0, 1.0);
col = mix(col, fogColor, fogFactor);
```

- Linear distance fog using `smoothstep(fogStart, fogEnd, dist)`
- Height-augmented fog adds extra fog to tall terrain at distance, so mountain peaks don't pop in at the horizon
- At `fogEnd` (600 units), terrain is 100% `fogColor`

### Sky Horizon (Fragment Shader)

```glsl
float t = smoothstep(0.02, 0.45, vHeight);
vec3 color = mix(fogColor, zenithColor, t);
```

- `vHeight` is the normalized Y component of the sky dome vertex position (−1 at nadir, +1 at zenith)
- For `vHeight < 0.02`: sky = exactly `fogColor` (flat band)
- For `vHeight > 0.45`: sky = exactly `zenithColor`
- In between: smooth gradient

### The Key Insight

When terrain reaches 100% fog at 600 units, its color is `fogColor`. The sky at the horizon is also `fogColor`. Since both use the same `THREE.Color` value through the same rendering pipeline, they produce **identical pixels on screen**. Fully-fogged terrain is literally invisible against the sky — there is no silhouette, no transition line, no "edge of the world" artifact.

## How This Differs From Modern Fog

### Modern Approach (Unity, Unreal, etc.)

Modern engines typically use **exponential height fog** or **post-processing fog** that:

1. **Does not affect the skybox** — the sky renders independently, then fog is applied only to scene geometry. This creates a visible transition where fogged terrain meets unfogged sky.
2. **Uses atmospheric scattering** — physically-based fog that simulates light absorption and scattering, producing gradient skies that don't match the fog color.
3. **Requires fog skirts or horizon rings** — to hide the terrain/sky transition, modern engines add decorative geometry (fog rings, horizon clouds, atmospheric haze layers) at the horizon.
4. **Separate fog and sky systems** — fog color and sky color are independent parameters that must be manually tuned to look similar, but rarely match exactly.

### Our Approach (Classic / Retro)

Our approach is closer to **Quake/Source engine** style fog:

1. **Fog color = sky horizon color** — one color (`FOG_COLOR`) drives both the terrain fog and the sky horizon. They are guaranteed to match by construction.
2. **Sky has a flat horizon band** — the sky is solid fog color at the horizon, not a gradient. This creates a "haze" that terrain dissolves into.
3. **No separate haze layers needed** — the matching colors create a natural horizon without any decorative geometry.
4. **Linear distance fog** — simple `smoothstep(start, end, distance)`, not exponential. Predictable, tunable, and cheap (important for Chromebook performance).

### Trade-offs

| Aspect | Our Approach | Modern Approach |
|--------|-------------|-----------------|
| Horizon seam | None — colors match exactly | Requires fog skirts/rings to hide |
| Sky appearance | Flat haze at horizon, gradient above | Atmospheric gradient throughout |
| Performance | Very cheap (one smoothstep) | Expensive (scattering integrals) |
| Tuning | One color controls both | Multiple parameters to balance |
| Realism | Less realistic, game-like | More physically plausible |
| Horizon popping | Eliminated by height-augmented fog | Handled by LOD + scattering |

## Configuration

```typescript
// config.ts
export const FOG_COLOR = 0xbbd0e8;  // Drives both terrain fog AND sky horizon
export const FOG_START = 120.0;     // Fog begins at 120 units
export const FOG_END = 600.0;       // Terrain fully fogged at 600 units
```

The sky zenith color (`0x2e6cb8`) is set independently in `scene.ts` when constructing the `AtmosphericSky`.

## Files Involved

- `client/src/core/config.ts` — `FOG_COLOR`, `FOG_START`, `FOG_END` constants
- `client/src/world/atmosphericSky.ts` — Sky shader with `fogColor`/`zenithColor` uniforms and flat horizon band
- `client/src/world/scene.ts` — Passes `FOG_COLOR` as `THREE.Color` to `AtmosphericSky`
- `client/src/world/terrain.ts` — Fragment shader fog calculation with height-augmented fog
- `client/src/core/renderer.ts` — `ACESFilmicToneMapping` and sRGB output encoding

## Summary

The system works by ensuring the fog color and sky horizon color are the **same linear-space value** passed through the **same rendering pipeline**. The sky has a flat band of fog color at the horizon so fully-fogged terrain vanishes into it. Height-augmented fog prevents mountain peaks from popping in at the horizon. This is a classic technique that trades physical realism for a clean, seamless horizon at minimal performance cost.
