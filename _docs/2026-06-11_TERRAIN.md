# Terrain System
## Infinite Procedural Tiled Terrain (Heaps/HXSL)

---

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Noise Pipeline](#noise-pipeline)
4. [9-Tile Infinite Grid](#9-tile-infinite-grid)
5. [Height Sampling](#height-sampling)
6. [Gameplay Shaping](#gameplay-shaping)
7. [Key Constants](#key-constants)
8. [Future Improvements](#future-improvements)

---

## Overview

The terrain system is a **fully procedural, infinite tiled world** implemented in Haxe using the Heaps engine. There are no heightmap image assets — all geometry is generated at runtime from a noise pipeline. The world appears infinite via a scrolling **3×3 tile grid** that rebuilds around the player as they move.

**Key properties:**
- Zero external assets — pure math
- Truly infinite world — no boundary clamps
- Seamless across tile edges — noise is sampled in continuous world space
- Gameplay-aware shaping — valleys are flat and walkable, peaks are compressed
- Full procedural texturing via `TerrainShader.hx` (see `TERRAIN_TEXTURING.md`)

---

## Architecture

Two files implement the terrain:

| File | Responsibility |
|---|---|
| `Terrain.hx` | CPU-side: noise, mesh generation, 9-tile grid management, `getHeight()` |
| `TerrainShader.hx` | GPU-side: HXSL fragment shader, all material/lighting/fog |

### `TileData` typedef
Each of the 9 live tiles is tracked as:
```haxe
private typedef TileData = {
  mesh    : h3d.scene.Mesh,
  heights : Array<Float>,   // not actively used post-build, retained for future LOD
  originX : Float,
  originZ : Float,
}
```

---

## Noise Pipeline

All height is computed by `Terrain.sampleHeight(wx, wz)` — a **static** function callable from anywhere (used by player, rockets, ball targets for ground collision).

### Step 1 — Primitives

**`hash(x, y)`** — deterministic pseudo-random float in 0..1:
```haxe
Math.sin(x * 127.1 + y * 311.7) * 43758.5453  // fractional part only
```

**`valueNoise(x, y)`** — bicubic-interpolated smooth noise in 0..1 using `hash` at integer corners.

### Step 2 — fBm (smooth macro shape)
6 octaves, frequency doubles each octave (`×2.0`), amplitude halves (`×0.5`). Produces rolling hills with natural scale hierarchy.

### Step 3 — Ridged fBm (mountain spines)
5 octaves, slightly detuned frequency (`×2.1`). Per-octave: `1.0 - abs(noise)` — inverted absolute value creates sharp ridgelines instead of smooth bumps.

### Step 4 — Domain Warping
Before sampling the main noise, the input coordinates are offset by a 4-octave fBm:
```haxe
var qx = fbm(nx,       nz,       4) * 1.2;
var qz = fbm(nx + 5.2, nz + 1.3, 4) * 1.2;
// then sample at (nx+qx, nz+qz)
```
This folds and twists the terrain organically, eliminating all periodicity. The magic offsets `(5.2, 1.3)` ensure the two warp axes are decorrelated. This is the same technique used by **No Man's Sky** ("uber noise").

### Step 5 — Smooth + Ridge Blend
```haxe
var blend  = smooth * smooth;  // quadratic: high terrain = more ridged
var height = smooth * (1.0 - blend) + ridged * blend;
```
Valley floors stay smooth and walkable. Only elevated terrain develops sharp ridge spines.

### Step 6 — Gameplay Shaping
```haxe
height = Math.pow(height, 0.75);       // plateau compression: flattens peaks
height = Math.max(height, 0.22);       // hard floor: valleys never become pits
height = (height - 0.22) / (1.0 - 0.22); // rescale to 0..1
return height * HSCALE - HSCALE * 0.15;   // world units, slight negative offset
```

---

## 9-Tile Infinite Grid

### Initialization
On startup, `Terrain.new()` builds a `3×3` grid of tiles centred at tile `(0,0)`. Each tile is a `SUBDIV×SUBDIV` quad mesh in world space.

### Tile shifting (`update(px, pz)`)
Called every frame from `Game.update()` with the player's world position:
```haxe
var ptx = Math.floor(px / SIZE + 0.5);  // nearest tile centre X
var ptz = Math.floor(pz / SIZE + 0.5);  // nearest tile centre Z
```
If the player has moved to a new tile cell, `centerTX/TZ` is updated and **all 9 tiles are rebuilt** around the new centre. The player is always in the middle tile; 8 neighbours surround them.

### Why no seams?
`sampleHeight` takes **true world-space coordinates** and converts to noise space via `NSCALE`. Adjacent tiles share the same world-space edge vertices, so they automatically evaluate to identical heights — zero stitching logic required.

### Performance
Each tile: `SUBDIV=120`, so `121×121 = 14641` vertices, `14400` quads. Nine tiles = ~130K triangles total. Rebuild on tile shift takes ~1ms on modern hardware.

---

## Height Sampling

`Terrain.sampleHeight(wx, wz)` is `public static` — anything that needs ground height calls it directly:

```haxe
// Player ground collision (Player.hx)
var groundY = terrain.getHeight(pos.x, pos.z) + PLAYER_HEIGHT;

// `getHeight` just delegates:
public function getHeight(wx, wz) return sampleHeight(wx, wz);
```

Rockets, ball targets, and spawn logic all use this same path, ensuring physics and visuals always agree.

---

## Gameplay Shaping

The shaping operators are deliberately tuned for FPS gameplay:

| Operator | Effect | Gameplay reason |
|---|---|---|
| `pow(h, 0.75)` | Plateau compression | Peaks become flat-topped — usable sniper/vantage positions |
| `max(h, 0.22)` | Hard floor | Valleys never become deep pits; always walkable |
| Smooth/ridge blend (`smooth²`) | Low ground = smooth, high = ridged | Valley floors easy to navigate; peaks dramatic |
| Domain warp | Irregular shapes | Avoids symmetrical, gamey-looking hills |

---

## Key Constants

Defined at the top of `Terrain.hx`:

| Constant | Value | Meaning |
|---|---|---|
| `SIZE` | `500` | World units per tile side |
| `SUBDIV` | `120` | Vertex subdivisions per tile edge |
| `HSCALE` | `30.0` | Max terrain height in world units |
| `NSCALE` | `0.008` | World-to-noise-space frequency (`1/125`) |

**Tuning guide:**
- Increase `NSCALE` → terrain features appear more frequently, smaller scale
- Decrease `NSCALE` → larger, more spread-out terrain features
- Increase `HSCALE` → taller terrain overall
- Increase `SUBDIV` → smoother geometry, more triangles (current: ~130K total)
- Increase `SIZE` → larger tiles, fewer tile rebuilds, but coarser grid around player

---

## Future Improvements

| Improvement | Complexity | Benefit |
|---|---|---|
| Recycle-row tile shifting (only rebuild 3 new tiles on shift instead of 9) | Medium | Smoother tile transitions, less CPU spike |
| Async/deferred tile rebuild (spread over multiple frames) | Medium | Eliminate any frame hitch on tile shift |
| Second domain warp pass | Low | Deeper, more chaotic terrain folding |
| Terrace function `floor(h * steps)/steps` | Low | Stepped cliffs for more varied cover |
| Biome mask (separate macro noise layer controlling ridge vs smooth weighting) | Medium | Desert zones, forested plains, mountain ranges |
| Geometry clipmap LOD | High | High-detail near player, coarser at distance |

---

*Last Updated: June 2026*

**Technical Approach**:
- Heightmap-based terrain system
- 256x256 to 512x512 heightmap resolution
- Simple geometric primitives for buildings
- Efficient rendering for 64-player matches
- Optimized for wide range of hardware

**Map Features**:
- Capture points and bases
- Vehicle paths
- Sniper positions
- Flag stands
- Turrets and sensors
- Indoor/Outdoor hybrid maps

### Our Adaptation

**Similarities**:
- Heightmap-based outdoor terrain
- Large playable areas
- Strategic elevation changes
- Simple geometric structures
- Clean aesthetic

**Modern Enhancements**:
- Dynamic LOD for performance
- Procedural generation options
- Web-optimized asset sizes
- Real-time terrain updates
- Better texture streaming

---

## Babylon.js Heightmap Terrain

### Basic Heightmap Terrain

Babylon.js provides `CreateGroundFromHeightMap` for creating terrain from grayscale heightmap images.

**How It Works**:
- Grayscale image where brightness = elevation
- White = highest point, black = lowest point
- Mesh vertices displaced based on pixel values
- Supports texture mapping and materials

**Basic Implementation**:
```javascript
const ground = BABYLON.MeshBuilder.CreateGroundFromHeightMap("ground", "heightmap.png", {
  width: 100,           // World units width
  height: 100,          // World units height (depth)
  subdivisions: 128,    // Vertex resolution (128x128 = 16K vertices)
  minHeight: 0,         // Minimum elevation
  maxHeight: 20,        // Maximum elevation
  updatable: false      // Whether mesh can be updated dynamically
}, scene);

// Apply material
const groundMaterial = new BABYLON.StandardMaterial("groundMat", scene);
groundMaterial.diffuseTexture = new BABYLON.Texture("ground_texture.jpg", scene);
ground.material = groundMaterial;
```

**Heightmap Image Requirements**:
- Grayscale (black to white)
- Square or rectangular
- PNG or JPEG format
- 256x256 to 1024x1024 resolution recommended
- Higher resolution = more detail but larger file size

**Performance Considerations**:
- Subdivisions: 64-128 for good balance
- 64x64 = 4K vertices (fast)
- 128x128 = 16K vertices (good)
- 256x256 = 65K vertices (heavy)
- Keep under 50K vertices for target specs

### Advanced Heightmap Options

**Texture Splatting** (Multiple textures based on height):
```javascript
// Create custom shader material for height-based texture blending
const groundMaterial = new BABYLON.StandardMaterial("groundMat", scene);
groundMaterial.diffuseTexture = new BABYLON.Texture("grass.jpg", scene);
groundMaterial.bumpTexture = new BABYLON.Texture("heightmap.png", scene);
```

**Color Map** (Vertex colors for variety):
```javascript
// Babylon.js supports vertex colors
const ground = BABYLON.MeshBuilder.CreateGroundFromHeightMap("ground", "heightmap.png", {
  width: 100,
  height: 100,
  subdivisions: 128,
  minHeight: 0,
  maxHeight: 20
}, scene);

// Apply vertex colors based on height
const positions = ground.getVerticesData(BABYLON.VertexBuffer.PositionKind);
const colors = new Float32Array(positions.length);
for (let i = 0; i < positions.length; i += 3) {
  const height = positions[i + 1];
  const normalizedHeight = height / 20;
  colors[i] = normalizedHeight;     // R
  colors[i + 1] = 1 - normalizedHeight; // G
  colors[i + 2] = 0.5;              // B
  colors[i + 3] = 1;               // A
}
ground.setVerticesData(BABYLON.VertexBuffer.ColorKind, colors);
```

---

## Dynamic Terrain Extension

### Overview

The Babylon.js Dynamic Terrain extension provides:
- Large terrain rendering from data maps
- Automatic LOD (Level of Detail)
- Camera-following terrain updates
- Efficient memory usage
- Support for millions of map points

**When to Use**:
- Maps larger than 500x500 units
- Need for dynamic LOD
- Camera moves across large areas
- Performance optimization critical

**Installation**:
```html
<script src="babylon.js"></script>
<script src="dynamicTerrain.min.js"></script>
```

### Basic Dynamic Terrain

**Data Map Creation**:
```javascript
// Create data map (array of x, y, z coordinates)
const mapSubX = 500;  // 500 points on width
const mapSubZ = 300;  // 300 points on depth
const mapData = new Float32Array(mapSubX * mapSubZ * 3);

// Populate with noise-generated terrain
for (let l = 0; l < mapSubZ; l++) {
  for (let w = 0; w < mapSubX; w++) {
    const x = (w - mapSubX * 0.5) * 5.0;
    const z = (l - mapSubZ * 0.5) * 2.0;
    const y = noise.simplex2(x, z) * 10; // Elevation
    
    mapData[3 * (l * mapSubX + w)] = x;
    mapData[3 * (l * mapSubX + w) + 1] = y;
    mapData[3 * (l * mapSubX + w) + 2] = z;
  }
}
```

**Dynamic Terrain Creation**:
```javascript
const terrainSub = 100; // 100x100 terrain vertices
const params = {
  mapData: mapData,
  mapSubX: mapSubX,
  mapSubZ: mapSubZ,
  terrainSub: terrainSub,
};

const terrain = new BABYLON.DynamicTerrain("terrain", params, scene);
const terrainMesh = terrain.mesh;
terrainMesh.material = groundMaterial;
```

### LOD Configuration

**Initial LOD** (Detail level):
```javascript
// Default: 1 terrain quad = 1 map quad
// Higher values = less detail, larger area covered
terrain.initialLOD = 1; // Default
// terrain.initialLOD = 4; // 1 terrain quad = 4x4 map quads
```

**Camera LOD** (Adjust based on altitude):
```javascript
// LOD increases with camera altitude
terrain.updateCameraLOD = function (terrainCamera) {
  const camLOD = Math.abs((terrainCamera.globalPosition.y / 16.0) | 0);
  return camLOD;
};
```

**Perimetric LOD** (Reduce detail at edges):
```javascript
// Reduce detail in distance
terrain.LODLimits = [4, 3, 2, 1, 1];
// First 4 rows: LOD +1
// Next 3 rows: LOD +1 (total +2)
// Next 2 rows: LOD +1 (total +3)
// First row: LOD +2 (total +5)
```

### Performance Optimization

**Update Tolerance** (Update less frequently):
```javascript
// Update only after crossing N quads
terrain.subToleranceX = 8;  // Update after 8 quads on X
terrain.subToleranceZ = 8;  // Update after 8 quads on Z
```

**Useful Functions**:
```javascript
// Get height at world position
const y = terrain.getHeightFromMap(x, z);

// Get height and normal
const normal = BABYLON.Vector3.Zero();
const y = terrain.getHeightFromMap(x, z, normal);

// Check if position is in terrain
if (terrain.contains(x, z)) {
  // Position is visible
}
```

### Heightmap to Dynamic Terrain

**Convert heightmap image to data map**:
```javascript
const hmURL = "heightmap.png";
const hmOptions = {
  width: 5000,      // World width
  height: 4000,     // World depth
  subX: 1000,      // Map points width
  subZ: 800,       // Map points depth
  minHeight: 0,
  maxHeight: 20,
  onReady: function (mapData, mapSubX, mapSubZ) {
    // Create terrain when heightmap is loaded
    const terrain = new BABYLON.DynamicTerrain("dt", {
      mapData: mapData,
      mapSubX: mapSubX,
      mapSubZ: mapSubZ,
      terrainSub: 100
    }, scene);
  }
};

const mapData = new Float32Array(1000 * 800 * 3);
BABYLON.DynamicTerrain.CreateMapFromHeightMapToRef(hmURL, hmOptions, mapData, scene);
```

---

## Geometry Clipmaps (Advanced)

### Overview

Geometry clipmaps are a highly efficient terrain LOD technique introduced by Losasso and Hoppe (2004). They provide:
- Nested regular grids centered on the camera
- Continuous LOD without discrete level switching
- Constant vertex count regardless of map size
- Excellent performance for very large terrains
- Simple implementation compared to other LOD techniques

**When to Use**:
- Very large maps (10km+)
- Need for infinite terrain
- Maximum performance optimization
- GPU-based terrain rendering

**When NOT to Use**:
- Small to medium maps (<5km)
- Simple implementation priority
- Limited development time
- Babylon.js Dynamic Terrain is sufficient

### How It Works

**Core Concept**:
- Create a mesh that's more finely tessellated in the center than at edges
- Center the mesh on the camera
- Move vertices to correct height in vertex shader
- Result: More detail near camera, less detail far away

**Nested Grid Structure**:
- Multiple rings (levels) around the camera
- Each ring has same vertex count as inner ring
- Each ring is twice as large as the previous
- Resolution halves with each level

**Advantages**:
- No complex decimation algorithms
- No need to stitch arbitrary meshes
- No discrete LOD level selection
- Easy to tune for quality settings
- Minimal data transfer to GPU per frame

### Implementation Details

**Mesh Structure**:
```
Level 0 (finest): 4x4 grid of tiles + filler + trim
Level 1: 4x4 grid of tiles (2x larger) + filler + trim
Level 2: 4x4 grid of tiles (4x larger) + filler + trim
...
```

**Position Snapping**:
- Critical: Snap mesh positions to multiples of resolution
- Prevents vertices from "swimming" over terrain
- Eliminates shimmering/waving artifacts
- Each level moves half as fast as inner neighbor

**Filler and Trim Meshes**:
- Filler: Red cross that gets fatter outward
- Trim: Green L-shaped mesh separating levels
- Purpose: Provide padding for inner level movement
- Prevent tile overlap between levels

**Seam Handling**:
- T-junctions at level boundaries cause cracks
- Solution: Draw seam triangles between levels
- Seam geometry is simple (1/3 as many triangles as naive approach)
- Vertices at coarser level match finer level vertices

### Code Example (Conceptual)

**Pseudocode**:
```javascript
for (let level = 0; level < levels; level++) {
  const scale = 1 << level; // 1, 2, 4, 8, ...
  const snappedPos = floor(cameraPos / scale) * scale;
  
  // Draw 4x4 grid of tiles
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) {
      if (innermostLevel || notInMiddle2x2) {
        drawTile(snappedPos, x, y, scale);
      }
    }
  }
  
  drawFillers(snappedPos, scale);
  drawTrim(snappedPos, scale);
}
```

**Vertex Shader**:
```glsl
// Sample height from heightmap texture
float getHeight(vec2 worldPos) {
  vec2 uv = worldPos / mapSize;
  return texture2D(heightmap, uv).r * maxHeight;
}

void main() {
  vec2 worldPos = position.xz + cameraOffset;
  float height = getHeight(worldPos);
  gl_Position = worldViewProj * vec4(position.x, height, position.z, 1.0);
}
```

### Advanced Features

**Skirts** (Ocean rendering):
- Extra geometry around coarsest level
- Extends terrain to horizon
- Triangle fan from terrain edge to far distance
- Useful for island-in-ocean scenarios

**Empty Tiles** (Optimization):
- Detect tiles fully outside world bounds
- Swap in simpler low-poly mesh
- Must maintain full resolution at edges
- Prevents T-junctions

**Geomorphing** (Smooth transitions):
- Blend between clipmap levels near boundaries
- Reduces LOD transition artifacts
- Requires additional shader complexity
- Optional enhancement

### Comparison with Other Techniques

**vs Geomipmapping**:
- Clipmaps: Constant vertex count, simpler
- Geomipmapping: Variable vertex count, more complex
- Clipmaps better for very large maps
- Geomipmapping better for smaller maps

**vs Quadtree LOD**:
- Clipmaps: Regular grid, simpler
- Quadtree: Hierarchical, more flexible
- Clipmaps better for uniform terrain
- Quadtree better for variable detail

**vs Babylon Dynamic Terrain**:
- Clipmaps: More complex, higher performance ceiling
- Dynamic Terrain: Simpler, easier to implement
- Dynamic Terrain sufficient for most web games
- Clipmaps overkill for typical FPS maps

### Web Implementation Considerations

**WebGL Support**:
- Requires WebGL 2.0 for optimal performance
- Texture arrays for efficient heightmap access
- Instancing for tile rendering
- Pixel buffer objects for async uploads

**Performance**:
- GPU-bound rather than CPU-bound
- Excellent for modern graphics cards
- May be overkill for integrated graphics
- Consider target hardware carefully

**Complexity**:
- Significant implementation effort
- Requires custom shader work
- More complex than Dynamic Terrain
- Consider development time vs benefit

### Recommendation for Our Project

**Use Babylon Dynamic Terrain Instead**:
- Sufficient for Tribes 2-style maps (500x500 to 2000x2000 units)
- Easier to implement and maintain
- Good performance on target hardware (Intel HD 5000+)
- Built-in LOD and optimization
- Less development time

**Consider Clipmaps If**:
- Maps exceed 5km x 5km
- Need infinite procedural terrain
- Performance is critical bottleneck
- Have dedicated graphics programmer
- Target high-end hardware only

### Clipmap Implementation Examples

**Godot Engine Examples** (for reference):
- [Instant Massive Infinite Terrain Clipmap Collisions - COMPLETE](https://github.com/TheGodojo/Instant-Massive-Infinite-Terrain-Clipmap-Collisions-COMPLETE)
- [Instant Massive Infinite Terrain Clipmap Collisions - STARTER](https://github.com/TheGodojo/Instant-Massive-Infinite-Terrain-Clipmap-Collisions-STARTER)
- [YouTube Tutorial Series](https://www.youtube.com/watch?v=Hgv9iAdazKg)

These Godot projects demonstrate:
- Complete clipmap implementation with collisions
- Procedural infinite terrain generation
- LOD and mesh seam stitching
- Real-time terrain updates

**Note**: These are Godot Engine projects, not WebGL/Babylon.js. The techniques are applicable but would require significant adaptation for web implementation.

---

## Procedural Generation

### Noise-Based Terrain

**Simplex Noise** (Recommended):
```javascript
// Using noisejs library
const noise = new Noise(Math.random());

function generateTerrainMap(width, depth, scale) {
  const mapData = new Float32Array(width * depth * 3);
  
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      const worldX = (x - width / 2) * scale;
      const worldZ = (z - depth / 2) * scale;
      
      // Multi-octave noise for detail
      let elevation = 0;
      elevation += noise.simplex2(worldX * 0.01, worldZ * 0.01) * 10;
      elevation += noise.simplex2(worldX * 0.03, worldZ * 0.03) * 5;
      elevation += noise.simplex2(worldX * 0.1, worldZ * 0.1) * 2;
      
      const index = 3 * (z * width + x);
      mapData[index] = worldX;
      mapData[index + 1] = elevation;
      mapData[index + 2] = worldZ;
    }
  }
  
  return mapData;
}
```

**Terrain Features**:
```javascript
// Add mountains
function addMountains(mapData, width, depth, count) {
  for (let i = 0; i < count; i++) {
    const centerX = Math.random() * width;
    const centerZ = Math.random() * depth;
    const radius = 20 + Math.random() * 30;
    const height = 15 + Math.random() * 20;
    
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        const dist = Math.sqrt((x - centerX) ** 2 + (z - centerZ) ** 2);
        if (dist < radius) {
          const falloff = 1 - (dist / radius);
          const index = 3 * (z * width + x) + 1;
          mapData[index] += height * falloff * falloff;
        }
      }
    }
  }
}

// Add valleys
function addValleys(mapData, width, depth, count) {
  for (let i = 0; i < count; i++) {
    const centerX = Math.random() * width;
    const centerZ = Math.random() * depth;
    const radius = 15 + Math.random() * 25;
    const depth = -5 - Math.random() * 10;
    
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        const dist = Math.sqrt((x - centerX) ** 2 + (z - centerZ) ** 2);
        if (dist < radius) {
          const falloff = 1 - (dist / radius);
          const index = 3 * (z * width + x) + 1;
          mapData[index] += depth * falloff;
        }
      }
    }
  }
}
```

### Simple Geometric Primitives

**Base Structures** (Tribes 2 style):
```javascript
// Create simple base building
function createBase(position, scene) {
  // Main structure
  const base = BABYLON.MeshBuilder.CreateBox("base", {
    width: 20,
    height: 8,
    depth: 20
  }, scene);
  base.position = position;
  
  // Roof
  const roof = BABYLON.MeshBuilder.CreateCylinder("roof", {
    diameter: 25,
    height: 5,
    tessellation: 4
  }, scene);
  roof.position.y = 6;
  roof.parent = base;
  
  // Entrance
  const entrance = BABYLON.MeshBuilder.CreateBox("entrance", {
    width: 6,
    height: 4,
    depth: 2
  }, scene);
  entrance.position.z = 11;
  entrance.position.y = -2;
  entrance.parent = base;
  
  return base;
}

// Create turret
function createTurret(position, scene) {
  const base = BABYLON.MeshBuilder.CreateCylinder("turretBase", {
    diameter: 4,
    height: 3
  }, scene);
  base.position = position;
  
  const barrel = BABYLON.MeshBuilder.CreateCylinder("turretBarrel", {
    diameter: 1,
    height: 6
  }, scene);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = 3;
  barrel.position.y = 1;
  barrel.parent = base;
  
  return base;
}

// Create flag stand
function createFlagStand(position, scene) {
  const pole = BABYLON.MeshBuilder.CreateCylinder("pole", {
    diameter: 0.3,
    height: 8
  }, scene);
  pole.position = position;
  
  const flag = BABYLON.MeshBuilder.CreatePlane("flag", {
    width: 3,
    height: 2
  }, scene);
  flag.position.y = 6;
  flag.position.z = 1.5;
  flag.parent = pole;
  
  return pole;
}
```

---

## Terrain Optimization

### Level of Detail (LOD)

**Why LOD Matters**:
- Reduces vertex count in distance
- Improves performance on lower-end hardware
- Maintains visual quality near camera
- Critical for large outdoor maps

**LOD Strategy**:
```javascript
// Near camera (0-50 units): Full detail
// Mid range (50-150 units): 2x reduction
// Far range (150-300 units): 4x reduction
// Very far (300+ units): 8x reduction

terrain.LODLimits = [8, 6, 4, 2];
```

### Texture Optimization

**Texture Atlasing**:
- Combine multiple textures into one
- Reduce texture switches
- Improve batching performance

**Texture Compression**:
- Use WebP format (better compression than JPEG)
- Consider ASTC for mobile (if supported)
- Mipmap generation for distance

**Texture Resolution**:
- Near terrain: 1024x1024
- Mid terrain: 512x512
- Far terrain: 256x256

### Vertex Optimization

**Vertex Count Targets**:
- Low-end: <10K vertices
- Mid-range: 10K-30K vertices
- High-end: 30K-50K vertices

**Optimization Techniques**:
```javascript
// Reduce subdivisions in flat areas
// Increase subdivisions in steep areas
// Use backface culling
// Enable frustum culling
```

### Draw Call Optimization

**Batching**:
```javascript
// Merge similar meshes
const merged = BABYLON.Mesh.MergeMeshes([mesh1, mesh2, mesh3], true, true);

// Use instances for repeated objects
const instance = baseMesh.createInstance("instance1");
instance.position = new BABYLON.Vector3(10, 0, 10);
```

**Material Sharing**:
```javascript
// Reuse materials across meshes
const sharedMaterial = new BABYLON.StandardMaterial("shared", scene);
mesh1.material = sharedMaterial;
mesh2.material = sharedMaterial;
```

---

## Implementation Guide

### Phase 1: Basic Heightmap Terrain

**Steps**:
1. Create heightmap image (256x256 grayscale)
2. Use `CreateGroundFromHeightMap` in Babylon.js
3. Apply basic material with texture
4. Test performance on target hardware

**Code**:
```javascript
const ground = BABYLON.MeshBuilder.CreateGroundFromHeightMap("ground", "heightmap.png", {
  width: 200,
  height: 200,
  subdivisions: 128,
  minHeight: 0,
  maxHeight: 30
}, scene);
```

### Phase 2: Dynamic Terrain

**Steps**:
1. Install Dynamic Terrain extension
2. Create data map from heightmap
3. Configure LOD settings
4. Test camera movement and updates

**Code**:
```javascript
const terrain = new BABYLON.DynamicTerrain("terrain", {
  mapData: mapData,
  mapSubX: 500,
  mapSubZ: 300,
  terrainSub: 100
}, scene);

terrain.LODLimits = [4, 3, 2, 1];
terrain.subToleranceX = 8;
terrain.subToleranceZ = 8;
```

### Phase 3: Procedural Generation

**Steps**:
1. Integrate noise library
2. Generate terrain data map
3. Add terrain features (mountains, valleys)
4. Test variety and performance

**Code**:
```javascript
const mapData = generateTerrainMap(500, 300, 5.0);
addMountains(mapData, 500, 300, 5);
addValleys(mapData, 500, 300, 3);
```

### Phase 4: Structures and Objects

**Steps**:
1. Create geometric primitives for bases
2. Place structures on terrain
3. Use instances for repeated objects
4. Optimize draw calls

**Code**:
```javascript
const base = createBase(new BABYLON.Vector3(0, 0, 0), scene);
const turret = createTurret(new BABYLON.Vector3(50, 0, 50), scene);
const flag = createFlagStand(new BABYLON.Vector3(-50, 0, -50), scene);
```

### Phase 5: Optimization

**Steps**:
1. Profile performance
2. Adjust LOD settings
3. Optimize textures
4. Batch meshes
5. Test on target hardware

---

## Asset Pipeline

### Heightmap Creation

**Tools**:
- **GIMP** (Free): Paint heightmaps
- **L3DT** (Free): Professional terrain generation
- **Terragen** (Free tier): High-quality terrain
- **World Machine** (Paid): Professional tool

**Workflow**:
1. Create grayscale heightmap in tool
2. Export as PNG (256x256 to 1024x1024)
3. Test in Babylon.js
4. Adjust based on gameplay needs
5. Optimize file size

### Texture Creation

**Tools**:
- **GIMP**: Texture painting
- **Substance Painter**: Professional texturing
- **Krita**: Free painting tool

**Guidelines**:
- Use seamless textures
- Keep resolution reasonable (512x512 to 2048x2048)
- Optimize for web (WebP format)
- Consider texture atlasing

### Asset Organization

**Directory Structure**:
```
assets/
├── terrain/
│   ├── heightmaps/
│   │   ├── map1_heightmap.png
│   │   └── map2_heightmap.png
│   ├── textures/
│   │   ├── grass.jpg
│   │   ├── rock.jpg
│   │   └── water.jpg
│   └── materials/
├── structures/
│   ├── bases/
│   ├── turrets/
│   └── flags/
└── props/
    ├── trees/
    └── rocks/
```

---

## References

### Babylon.js Documentation
- [Ground from Height Map](https://doc.babylonjs.com/features/featuresDeepDive/mesh/creation/set/ground_hmap)
- [Dynamic Terrain Extension](https://doc.babylonjs.com/communityExtensions/dynamicTerrains/)
- [Dynamic Terrain Documentation](https://github.com/BabylonJS/Extensions/blob/master/DynamicTerrain/documentation/dynamicTerrainDocumentation.md)

### Terrain Generation
- [Simplex Noise](https://github.com/josephg/noisejs)
- [Perlin Noise](https://github.com/stegu/perlin-noise)
- [L3DT Terrain Editor](http://www.bundysoft.com/L3DT/)

### Tribes 2 Resources
- [Tribes 2 Map Catalog](https://playt2.com/maps)
- [Tribes 2 Mapping Tutorial](http://tribes.necrobones.com/tribes2/files/nbt2-mappingtutorial.doc)

### Performance Optimization
- [WebGL Best Practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- [Babylon.js Optimization](https://doc.babylonjs.com/featuresAndDeepDive/optimizing)

---

*Last Updated: June 2026*
