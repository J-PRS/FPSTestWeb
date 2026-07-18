# Infinite Terrain Techniques — Research Report

**Date:** 2026-07-18
**Context:** Evaluating modern infinite/repeating terrain techniques for the FPSWebTest WebGL client.

---

## 1. Current Implementation

The existing terrain system in `client/src/world/terrain.ts` uses:

- **Wrapping heightmap** — A single 2048×2048 heightmap image is tiled infinitely using modular arithmetic on world coordinates. The heightmap repeats every `TERRAIN_WORLD_SCALE` (1500) units in both X and Z.
- **3×3 tile grid** — Nine mesh tiles (each 500×500 units, 100×100 subdivisions) are centered on the player. Total visible area: 1500×1500 units.
- **Full rebuild on tile crossing** — When the player crosses a tile boundary, all 9 tiles are disposed and rebuilt.
- **CPU-bound height sampling** — Every vertex height and normal is computed in JavaScript via `sampleHeight()` / `sampleNormal()`.
- **Procedural fragment shader texturing** — All surface detail (FBM noise, Worley cells, triplanar mapping, erosion) is generated in GLSL from world-space coordinates. No texture files needed for texturing.

### Limitations

| Issue | Description |
|---|---|
| **No LOD** | All 9 tiles are full 100×100 resolution, even distant ones near the fog horizon |
| **Frame spike on tile crossing** | Disposing + recreating 9 geometries at once causes a noticeable hitch |
| **CPU bottleneck** | Height/normal sampling in JS for every vertex on every tile rebuild |
| **Visible repetition** | Period is 1500 units; fog ends at 400 units, so ~3.5 heightmap repetitions are visible to the horizon |
| **Fixed resolution** | No way to increase detail near the player without increasing it everywhere |

---

## 2. Modern Techniques Surveyed

### 2.1 Geometry Clipmaps

**Source:** Losasso & Hoppe 2004 ([paper](https://www.hhoppe.com/geomclipmap.pdf)); GPU Gems 2 Chapter 2 ([NVIDIA](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry)); Terrain3D (Godot); [tschie/geo-clipmap](https://github.com/tschie/geo-clipmap) (Three.js demo)

**How it works:**

Terrain is cached as a set of **nested concentric regular grids** centered on the viewer. Each ring (level) covers a larger area than the one inside it, but has the same vertex count. This produces uniform screen-space triangle size — near triangles are small/dense, far triangles are large/sparse.

```
Level 0:  ┌─────────────────────────────────┐
          │ ┌───────────────────────────┐   │
          │ │ ┌─────────────────────┐   │   │
          │ │ │ ┌───────────────┐   │   │   │
          │ │ │ │   player      │   │   │   │
          │ │ │ │   (high res)  │   │   │   │
          │ │ │ └───────────────┘   │   │   │
          │ │ └────── Level 1 ──────┘   │   │
          │ └──────── Level 2 ──────────┘   │
          └─────────── Level 3 ──────────────┘
```

**Key properties:**

- **Toroidal addressing** — Each level's vertex buffer is a ring buffer in GPU memory. When the player moves, only the newly-exposed strip of vertices is updated. No full geometry rebuild.
- **GPU-resident** — Elevation data stored as 2D textures (one per level). Vertex shader samples the texture to displace vertices. CPU does almost nothing.
- **Geomorphing** — Transition zones near ring boundaries smoothly blend between LOD levels in the vertex shader, eliminating popping.
- **Constant memory** — Fixed number of vertices regardless of world size. The GPU Gems 2 implementation renders a 20-billion-sample terrain at 90 FPS from 355 MB of memory.
- **Detail synthesis** — Finer levels than the stored data can be synthesized with fractal noise displacement in the shader.

**Three.js implementation reference:** [tschie/geo-clipmap](https://github.com/tschie/geo-clipmap) uses instanced meshes with a shared plane geometry. The shader removes overlapping vertices and interpolates heights at LOD boundaries to fix seams.

**Terrain3D (Godot) approach:** Mesh components are generated once at startup. At periodic intervals, they're recentered on the camera. The vertex shader reads heights from a heightmap texture. LOD is built into the mesh layout — lower detail levels automatically end up far away when components are recentered.

**Pros:**
- Constant memory footprint
- No allocation spikes (incremental updates)
- Built-in LOD with uniform screen-space triangle size
- GPU-resident data, minimal CPU work
- Proven in production (The Witcher 3, Terrain3D)

**Cons:**
- More complex to implement than tile grid
- Requires vertex texture fetch support (available in WebGL2, standard in WebGPU)
- Seam stitching between LOD levels needs careful shader work
- Heightmap must be uploaded as a texture (not sampled on CPU)

**Fit for FPSWebTest:** High. The existing wrapping heightmap maps naturally to clipmap levels. Fog (ends at 400 units) hides the lowest-detail rings. The "low server cost / lagless" priority benefits from reduced CPU work and smoother frame times.

---

### 2.2 GPU-Side Height Sampling (Vertex Shader Displacement)

**Source:** GPU Gems 2 Chapter 2; common technique in modern WebGL/WebGPU terrain engines

**How it works:**

Instead of computing vertex heights on the CPU in JavaScript, the heightmap is uploaded to the GPU as a `DataTexture` once at load time. The vertex shader samples this texture to displace vertices upward.

```glsl
// Vertex shader
uniform sampler2D heightmap;
uniform float heightmapSize;
uniform float worldScale;
uniform float heightScale;
uniform vec2 gridOrigin;  // updated when player moves

void main() {
  vec2 worldUV = (gridOrigin + position.xz) / worldScale;
  worldUV = mod(worldUV, 1.0);  // wrap
  float h = texture2D(heightmap, worldUV).r * heightScale;
  vec3 displaced = vec3(position.x, h, position.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
```

**Key properties:**

- **One-time geometry creation** — A flat grid is created once. The shader displaces it every frame.
- **Tile updates are free** — Moving to a new tile just updates a `uniform vec2 gridOrigin`. No geometry rebuild at all.
- **CPU/GPU parity** — CPU still samples the same heightmap for collision/physics, but only for the player's current position (1 sample), not for every terrain vertex (10,000+ samples).
- **Bilinear filtering** — GPU's hardware texture filtering handles interpolation for free. The current CPU bilinear interpolation code becomes unnecessary for rendering.

**Pros:**
- Eliminates the entire `buildTile` CPU loop
- Tile updates become a single uniform update (sub-millisecond)
- Hardware-accelerated bilinear filtering
- Works with existing heightmap image (just upload as texture)

**Cons:**
- Requires WebGL2 (vertex texture fetch) — available in all modern browsers
- CPU still needs heightmap data for physics/collision sampling (but only 1 point, not 10,000)
- Slightly more complex shader

**Fit for FPSWebTest:** Very high. This is the quickest win — the heightmap is already loaded as an image, just needs to be uploaded as a `DataTexture`. The fragment shader already does procedural texturing on GPU; the vertex side should match.

---

### 2.3 Camera-Following Radial Fan (Polar Grid)

**Source:** [Eternal Ride](https://discourse.threejs.org/t/eternal-ride-infinite-terrain-in-three-js-with-no-lod-no-seams/91868) (Three.js forum)

**How it works:**

Instead of a grid of tiles, the terrain is a **single fan-shaped mesh** centered on the player:

- **Polar layout** — Vertices arranged in rings × sectors around the player
- **Power-curve radius** — Near rings are close together (dense), far rings are far apart (sparse). This provides built-in LOD without explicit LOD levels.
- **Constant angular density** — Every triangle subtends roughly the same screen angle regardless of distance
- **One geometry, constant memory** — No chunks, no streaming, no seams, no popping

```
            ╱ ╲
          ╱   ╲
        ╱ ┌───┐ ╲
      ╱  │     │  ╲
    ╱   │  P    │   ╲
  ╱────┴───────┴────╲
 ╱                   ╲
╱_____________________╲
  (sparse far, dense near)
```

**Key properties:**

- **Pure math terrain** — Height is a function `h = f(x, z)` evaluated in the vertex shader. No heightmap texture needed.
- **Periodic noise** — Uses `periodicPerlin(x, z, period)` to ensure seamless tiling. The period is chosen so tiling is invisible (period × scale ≫ fan radius).
- **Float64 precision fix** — World origin is wrapped modulo period on the CPU in float64 (exact at any distance). The small wrapped value is passed to the GPU as a uniform. The vertex shader only adds the local fan offset (≤300m), which stays float32-clean.
- **Per-pixel normals** — Analytical normals computed in the fragment shader (not per-vertex) to maintain lighting detail on distant slopes.
- **CPU/GPU parity** — The exact same math function runs on GPU (rendering) and CPU (collisions). They never disagree.

**Pros:**
- Simplest implementation (one geometry, one shader)
- No seams, no popping, no LOD transitions to manage
- Constant memory (one mesh)
- Perfect CPU/GPU sync (same function)
- Works on phones (low vertex count)

**Cons:**
- Requires giving up authored heightmaps — terrain must be a math function
- No control over specific terrain features (can't place a mountain at a specific location)
- Radial layout is unusual; may not suit all art styles
- Limited to periodic noise (no simplex noise unless wrapped manually)

**Fit for FPSWebTest:** Medium. The project already has a nice authored heightmap with specific terrain features. Converting to pure procedural noise would lose that. However, the **float64 wrapping trick** and **per-pixel normal** technique are applicable regardless of terrain approach.

---

### 2.4 Chunked LOD with Quadtree

**Source:** [CK42BB/procedural-landscapes-threejs](https://github.com/CK42BB/procedural-landscapes-threejs); [kenjinp/hello-terrain](https://github.com/kenjinp/hello-terrain); [Cinevva guide](https://app.cinevva.com/guides/landscape-generation-browser.html)

**How it works:**

The world is divided into a quadtree of square chunks. Each chunk is subdivided or merged based on distance to the camera:

- Near chunks: high resolution (e.g. 64×64 vertices)
- Far chunks: low resolution (e.g. 8×8 vertices)
- Chunks are loaded/unloaded as the player moves
- Seam stitching required between adjacent chunks of different LOD

**WebGPU variant:** GPU-driven quadtree (CDLOD) with compute culling + indirect draw. The GPU itself determines which chunks to render, eliminating CPU overhead entirely. Performance budget: ~3.5ms for terrain.

**WebGL2 variant:** Geometry clipmaps with CPU-side ring updates. Performance budget: ~6.5ms for terrain.

**Pros:**
- Standard, well-documented technique
- Many open-source implementations available
- Supports streaming from CDN (chunks can be loaded on demand)
- Works with authored heightmaps

**Cons:**
- Seam stitching is notoriously fiddly
- Chunk loading causes allocation/frame spikes if not carefully managed
- More complex than clipmaps for the same visual result
- CPU overhead for quadtree traversal and chunk management

**Fit for FPSWebTest:** Medium-low. Chunked LOD is more complex than clipmaps without clear advantages for this project. The wrapping heightmap doesn't need streaming (it's already fully loaded). Clipmaps provide the same LOD benefit with simpler implementation.

---

### 2.5 WebGPU Compute Shader Terrain

**Source:** [pgomur/ng-terrain-procedural](https://github.com/pgomur/ng-terrain-procedural); [hlsvortex/HLS_WebGPUPlugins](https://github.com/hlsvortex/HLS_WebGPUPlugins); [Cinevva guide](https://app.cinevva.com/guides/landscape-generation-browser.html)

**How it works:**

Terrain generation is moved entirely to the GPU using WebGPU compute shaders:

- **Heightmap generation** — FBM, ridged multifractal, domain-warped noise computed in WGSL compute shaders
- **Hydraulic erosion** — Stream power law erosion simulated on GPU in milliseconds
- **Normal computation** — GPU compute pass generates normal maps from heightmaps
- **Biome classification** — Compute shader assigns biomes based on height/slope/moisture
- **Memory pooling** — Zero-allocation ring buffers for typed arrays, storage buffers, and GPU staging buffers to avoid GC pauses
- **Predictive streaming** — Camera velocity vector used to pre-load chunks before they enter the frustum

**Advanced techniques:**

- **Terrain Diffusion / InfiniteDiffusion** (SIGGRAPH 2026) — Replaces noise with diffusion models trained on real elevation data. Generates geologically realistic landforms from a seed. Works on unbounded domains.
- **Volumetric terrain** — SDF volumes for caves, overhangs, arches. WebGPU marching cubes processes 256³ grid in real-time.
- **Transvoxel** — LOD boundary handling for volumetric terrain.

**Pros:**
- Maximum performance (GPU does everything)
- Geologically realistic terrain possible
- Supports volumetric features (caves, overhangs)
- Zero CPU overhead for terrain

**Cons:**
- Requires WebGPU (Chrome 121+, Edge 121+) — not universally available
- Significantly more complex to implement
- WebGL2 fallback needed for broader compatibility
- Overkill for a heightfield-only terrain

**Fit for FPSWebTest:** Low (for now). The project targets WebGL (Three.js WebGLRenderer). WebGPU would be a future direction if the project migrates renderers. The compute shader approach is overkill for a wrapping heightfield terrain.

---

## 3. Comparison Matrix

| Technique | Memory | CPU Cost | LOD | Seams | Complexity | WebGL2 | WebGPU |
|---|---|---|---|---|---|---|---|
| **Current (tile grid)** | 9 meshes | High (rebuild) | None | None | Low | Yes | Yes |
| **Geometry clipmaps** | Fixed rings | Very low | Built-in | Managed (geomorphing) | Medium | Yes | Yes |
| **GPU height sampling** | 1 texture + 1 mesh | Very low | None (same as current) | None | Low-Medium | Yes | Yes |
| **Radial fan** | 1 mesh | Very low | Built-in (power curve) | None | Low | Yes | Yes |
| **Chunked quadtree LOD** | Variable (chunks) | Medium (traversal) | Yes | Yes (stitching needed) | Medium-High | Yes | Yes |
| **WebGPU compute** | GPU buffers | Near-zero | Yes | Managed | High | No | Yes |

---

## 4. Recommendations for FPSWebTest

### Priority 1: GPU-Side Height Sampling (Quick Win)

**Effort:** Low-Medium | **Impact:** High | **Risk:** Low

Upload the existing heightmap as a `DataTexture`. Create a flat grid geometry once. The vertex shader samples the texture to displace vertices. Moving to a new tile becomes a single uniform update instead of a 9-tile rebuild.

**Why first:** Eliminates the frame spike on tile crossing. Eliminates the CPU bottleneck. Minimal change to existing architecture. The fragment shader already works on GPU — this just brings the vertex side up to par.

### Priority 2: Incremental Tile Updates (Quick Win)

**Effort:** Low | **Impact:** Medium | **Risk:** Low

Even without GPU height sampling, avoid rebuilding all 9 tiles. When the player crosses a boundary:
- Shift 6 existing tiles' positions (no rebuild)
- Build only 3 new tiles (the new row/column)
- Dispose only 3 old tiles

This turns a 9-tile spike into a 3-tile update.

### Priority 3: Geometry Clipmaps (Major Upgrade)

**Effort:** Medium-High | **Impact:** High | **Risk:** Medium

Replace the 3×3 tile grid with nested clipmap rings. Each ring has the same vertex count but covers a larger area. This provides LOD — near terrain is detailed, far terrain is coarse. Combined with GPU height sampling (Priority 1), updates are just texture region refills.

**Why third:** Requires the GPU height sampling foundation from Priority 1. More complex shader work (geomorphing, seam management). But provides the biggest visual/performance improvement — distant terrain looks better without increasing vertex count.

### Priority 4: Larger Period / Multi-Octave Wrapping (Visual Polish)

**Effort:** Low | **Impact:** Medium | **Risk:** Low

Increase `TERRAIN_WORLD_SCALE` from 1500 to 6000 to push the repeat distance beyond the fog horizon. Alternatively, add a second wrapping noise layer with a different period (e.g. 4000 units) — two non-harmonic periods create a much longer effective repeat (LCM). The fragment shader's FBM could also displace vertices in the vertex shader for non-repeating fine detail.

### Optional: Radial Fan (Alternative Architecture)

If the project ever moves away from authored heightmaps to fully procedural terrain, the radial fan approach from "Eternal Ride" is the simplest infinite terrain technique: one mesh, built-in LOD, no seams, no chunks. The float64 wrapping trick and per-pixel normal technique are worth adopting regardless.

---

## 5. References

- [Geometry Clipmaps (Losasso & Hoppe 2004)](https://www.hhoppe.com/geomclipmap.pdf) — Original paper
- [GPU Gems 2 Chapter 2](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry) — GPU implementation with vertex textures
- [tschie/geo-clipmap](https://github.com/tschie/geo-clipmap) — Three.js geometry clipmap demo
- [Terrain3D System Architecture](https://terrain3d.readthedocs.io/en/stable/docs/system_architecture.html) — Godot terrain plugin using clipmaps
- [Eternal Ride (Three.js forum)](https://discourse.threejs.org/t/eternal-ride-infinite-terrain-in-three-js-with-no-lod-no-seams/91868) — Radial fan infinite terrain
- [Cinevva: Landscape Generation for Browser Open Worlds](https://app.cinevva.com/guides/landscape-generation-browser.html) — Comprehensive guide covering CDLOD, streaming, WebGPU
- [pgomur/ng-terrain-procedural](https://github.com/pgomur/ng-terrain-procedural) — WebGPU compute shader terrain with predictive streaming
- [hlsvortex/HLS_WebGPUPlugins](https://github.com/hlsvortex/HLS_WebGPUPlugins) — Three.js r184 WebGPU terrain with quadtree LOD
- [kenjinp/hello-terrain](https://github.com/kenjinp/hello-terrain) — Realtime web terrain engine with variable LOD
- [CK42BB/procedural-landscapes-threejs](https://github.com/CK42BB/procedural-landscapes-threejs) — Three.js WebGPU terrain with WebGL2 fallback
