# Fog & Sky Horizon Blending — Research Report

## Problem Statement

When looking at the horizon, there is a visible seam/line where the terrain meets the sky. Distant terrain appears darker/more saturated than the sky's horizon color, breaking immersion. The goal is seamless Tribes 2-style fog blending where terrain dissolves into haze at the horizon.

---

## Root Causes Identified

### 1. Sky Sphere Not Following Camera
**Problem:** The `AtmosphericSky` sphere was centered at world origin `(0,0,0)`. As the player moves away from origin, the sphere edge (equator) cuts across the view — causing a visible circular arc at the horizon.

**Fix:** Call `atmosphericSky.followCamera(camera.position)` each frame so the sphere is always centered on the camera.

### 2. Low Sphere Segment Count
**Problem:** `SphereGeometry(4000, 32, 16)` — only 32 horizontal, 16 vertical segments. The polygon edges were visible as a "geometric circle" at the horizon.

**Fix:** Increased to `SphereGeometry(4000, 64, 32)`.

### 3. Fog Color / Sky Horizon Color Mismatch
**Problem (critical):** Three sources of color all need to match exactly at the horizon:
- `scene.fog` color (Three.js `FogExp2`)
- `renderer.setClearColor()` / `scene.background`
- Sky shader `hazeColor` at `direction.y = 0`
- Terrain shader `fogColor` uniform

Any mismatch creates a visible seam. This was the main persistent issue.

**Additional complication:** The terrain shader applies lighting (`ambientColor * sunColor`) to terrain geometry *before* mixing in fog color. This means the terrain never reaches the raw fog color unless `fogFactor = 1.0` exactly. At asymptotic exponential fog, this never quite happens.

### 4. Terrain Shader Fog Color Hardcoded Independently
**Problem:** `terrain.ts` had its own hardcoded `fogColor: 0x88bbdd` and `fogDensity: 0.006` — completely different from `config.ts` values. These were never synchronized, so terrain fog always differed from scene fog.

**Fix:** Update terrain shader uniforms to match config values.

### 5. Dark Ambient Color Making Distant Terrain Too Dark
**Problem:** `ambientColor: (0.18, 0.22, 0.28)` was very dark. Even fogged distant terrain retained this dark tint before the fog mix fully kicked in, making it look grey-blue instead of matching the lighter sky haze.

**Fix:** Raised to `(0.38, 0.45, 0.55)`.

### 6. Tone Mapping Interaction
**Problem (theoretical):** `ACESFilmicToneMapping` at exposure `0.4` transforms colors non-linearly. Fog colors specified as hex are linear input, but the visual output is tone-mapped. Sky shader output also goes through tone mapping. However since both go through the same pipeline, if input linear values match, output should match — so this is less of an issue than initially suspected.

---

## What The Three.js Docs / Community Say

### Three.js Manual (fog.html)
> "It is part of the calculation of each pixel of the color of the object. What that means is if you want your scene to fade to a certain color you need to set the fog **and** the background color to the same color."

**Key requirement:** `scene.background = new THREE.Color(FOG_COLOR)` must match `scene.fog.color`. We added this.

### Three.js Forum (discourse.threejs.org)
The proper solutions in order of complexity:

1. **Manual color matching** — eyedrop sky horizon, set fog to same value. Works but fragile if sky is dynamic.

2. **Post-processing fog pass** — render depth buffer, reconstruct world position per pixel, apply sky-aware fog as full-screen quad. Most correct solution — fog color can vary based on view direction (matching the sky gradient). Recommended for serious projects.

3. **Inject into `THREE.ShaderChunk.fog_fragment`** — override Three.js's built-in fog shader chunks globally at runtime to use sky-color logic. Complex, hacky, but works.

4. **`onBeforeCompile` per material** — inject custom fog logic into specific materials only. More targeted than global chunk replacement.

### Wolfire Games Blog (Overgrowth devs)
Technique used: **"horizon band"** — a fuzzy strip at the horizon colored by a blurred version of the sky. Drawn as a separate mesh. Entirely automated, cheap, effective.

---

## Techniques Implemented

### Sky Shader Gradient
```glsl
vec3 hazeColor   = vec3(0.7333, 0.8157, 0.9098); // = 0xbbd0e8, exact match to FOG_COLOR
vec3 skyColorMid = vec3(0.18, 0.38, 0.72);
vec3 skyColorTop = vec3(0.04, 0.12, 0.38);

float h = direction.y; // -1..+1

// Power curve: wide haze band near horizon
vec3 aboveColor = mix(hazeColor, skyColorMid, pow(clamp(h, 0.0, 1.0), 0.20));
aboveColor      = mix(aboveColor, skyColorTop, pow(clamp(h, 0.0, 1.0), 0.9));

// Smooth band at/below horizon → pure haze
vec3 color = mix(hazeColor, aboveColor, smoothstep(-0.12, 0.18, h));
```

The `pow(h, 0.20)` makes the sky stay very close to `hazeColor` for a wide arc above the horizon (Tribes 2 style), then deepens toward zenith.

### Terrain Height Fog + Hard Cutoff
```glsl
float heightFog = exp(-max(vWorldPos.y - vCameraPos.y, 0.0) * 0.003);
float fogFactor = (1.0 - exp(-fogDensity * dist)) * heightFog;
fogFactor = clamp(fogFactor, 0.0, 1.0);
if (dist > 200.0) fogFactor = 1.0; // hard cutoff
col = mix(col, fogColor, fogFactor);
```

**Height fog:** terrain below camera level fogs faster than terrain above (mountains stay visible longer). Classic technique from Quake/Tribes era.

**Hard cutoff at 200 units:** guarantees terrain is 100% fog color beyond that distance. No asymptotic leak-through of dark terrain color.

---

## Current Config Values

| Parameter | Value | Notes |
|-----------|-------|-------|
| `FOG_COLOR` | `0xbbd0e8` | Used by scene.fog, scene.background, renderer clear, terrain shader |
| `FOG_DENSITY` | `0.030` | Scene FogExp2 density |
| Terrain `fogDensity` | `0.030` | Terrain shader density (matched) |
| Terrain `fogColor` | `0xbbd0e8` | Terrain shader fog target (matched) |
| Sky `hazeColor` | `vec3(0.7333, 0.8157, 0.9098)` | Exact float conversion of `0xbbd0e8` |
| Hard cutoff | 200 units | Terrain forced to 100% fog beyond this |

---

## Ideal Future Solution (Post-Processing Fog)

For truly seamless sky-aware fog, the right approach is:

1. Enable `depthBuffer` on `EffectComposer` render target
2. Add a `ShaderPass` that reads `tDiffuse` + `tDepth`
3. Reconstruct view-space direction per pixel from depth
4. Compute fog color from view direction using same sky gradient formula
5. Mix scene color toward fog color based on depth-derived distance

This means **one fog system** drives everything — no separate terrain fog uniforms, no color synchronization issues. The sky gradient and fog gradient are literally the same shader.

Cost: moderate complexity, needs `THREE.DepthTexture` piped into the composer.
