# Three.js vs Babylon.js: Extreme Optimization for Low-Spec Devices

**Date:** 2026-06-22
**Objective:** In-depth comparison of Three.js and Babylon.js for extreme optimization on super low-spec devices (Chromebooks, low-end hardware) targeting 60fps

## Executive Summary

**For super low-spec devices (Chromebooks), Three.js has a significant advantage due to:**
- 8x smaller bundle size (168KB vs 1.4MB)
- GPU-heavy approach (better for weak CPU devices)
- More control for custom optimization
- Lower memory footprint

**However, Babylon.js can achieve 60fps on Chromebooks** (proven by Shell Shockers with 39% Chromebook player base) when using aggressive optimization techniques.

**Recommendation:** Three.js for maximum control and minimal overhead, but Babylon.js is viable if you follow proven optimization patterns.

## Hardware Profile: Chromebooks

**Typical Chromebook specifications:**
- **CPU:** Celeron, Pentium, or ARM-based (very weak)
- **GPU:** Intel HD integrated graphics (very weak)
- **RAM:** 2-4GB (severely limited)
- **Storage:** 16-32GB eMMC (limited)
- **Browser:** Chrome only

**Performance constraints:**
- Both CPU and GPU are bottlenecks
- Memory pressure is critical
- Thermal throttling under sustained load
- Limited bandwidth for asset loading

**Key insight:** On Chromebooks, the 8x bundle size difference alone is a decisive factor. 1.4MB vs 168KB matters enormously on 2-4GB RAM.

## Bundle Size Comparison

### Three.js

**Core bundle:**
- **Minified + gzipped:** ~168KB
- **With tree-shaking:** ~150-200KB for simple scenes
- **Full bundle (no tree-shaking):** ~700KB

**Tree-shaking benefits:**
- Import only what you need
- Simple scenes can ship ~150-200KB of Three.js code
- React Three Fiber adds ~50KB on top

**Memory impact:**
- Minimal memory footprint on load
- Leaves more RAM for game assets
- Critical for 2-4GB Chromebooks

### Babylon.js

**Core bundle:**
- **Minified + gzipped:** ~1.4MB (full engine)
- **Minimal scene (rendering only):** ~300KB
- **Full engine (physics + XR):** ~2MB+ before gzip

**Modular system:**
- Each subsystem is separate package (physics, XR, GUI, particles)
- Can reduce size by importing only what's needed
- Still larger than Three.js even with minimal imports

**Memory impact:**
- 8x larger than Three.js core
- Significant memory pressure on low-RAM devices
- Takes longer to load and parse

**Winner:** Three.js (8x smaller, critical for limited RAM)

## Performance Characteristics

### Three.js: GPU-Heavy Approach

**Architecture:**
- Pushes rendering complexity to shader level
- Minimal CPU overhead for scene management
- GPU does most of the work
- Lightweight scene graph

**Advantages for low-spec:**
- **Better for weak CPU devices** (Chromebooks)
- Less CPU overhead leaves cycles for game logic, networking, physics
- GPU can handle shader work even if weak
- More predictable performance

**Disadvantages:**
- Can become CPU bottleneck if not managed with custom ECS
- Requires manual optimization for complex scenes
- No built-in scene management tools
- Must implement optimization yourself

**CPU usage:** Slightly lighter
**GPU usage:** Higher (by design)

### Babylon.js: CPU-Heavy Approach

**Architecture:**
- Significant CPU use for scene management
- Sophisticated frustum culling
- Internal state tracking
- Built-in optimization systems

**Advantages for low-spec:**
- **Better for strong CPU, weak GPU** (not Chromebooks)
- Better predictable frame times with thousands of objects
- Built-in optimization tools (Inspector, Performance Monitor)
- Automatic optimizations (LOD, instancing helpers)

**Disadvantages:**
- **CPU overhead problematic on weak CPU** (Chromebooks)
- Takes CPU cycles away from game logic, networking, physics
- More complex internal state
- Heavier engine overhead

**CPU usage:** Higher (scene management, culling, state tracking)
**GPU usage:** Lower (CPU does more work)

**Winner:** Three.js for Chromebooks (weak CPU, GPU-heavy approach is better)

## Extreme Optimization Techniques

### Three.js Optimization Strategies

#### 1. Geometry Optimization

**Geometry Merging:**
```javascript
// Merge 50 identical objects into 1 draw call
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils';

const mergedGeometry = BufferGeometryUtils.mergeGeometries([geo1, geo2, geo3]);
```
- **Impact:** Reduces draw calls from 50 to 1
- **Use case:** Static geometry (rocks, trees, buildings)
- **Result:** 95% reduction in draw calls possible

**InstancedMesh:**
```javascript
// Render 10,000 objects with 1 draw call
const instancedMesh = new THREE.InstancedMesh(geometry, material, 10000);
```
- **Impact:** Single most powerful optimization for repeated geometry
- **Use case:** Trees, bullets, projectiles, particles
- **Result:** 10,000+ objects at 60fps

**Material Purge (The "Expeditione" technique):**
```javascript
// In Blender: Delete all material slots, use single material
// Export as single primitive = 1 draw call
// In Three.js: Apply baked texture
```
- **Impact:** Collapses entire static scene to 1 draw call
- **Use case:** Static environment (terrain, buildings)
- **Result:** 9 draw calls for entire scene (95% reduction)

#### 2. Material Optimization

**Material hierarchy (cheapest to most expensive):**
```javascript
// Cheapest
MeshBasicMaterial

// Cheap
MeshLambertMaterial

// Medium
MeshStandardMaterial

// Most expensive
MeshPhysicalMaterial
```
- **Impact:** Shader complexity directly affects GPU load
- **Use case:** Use cheapest material that achieves desired look
- **Result:** 2-3x performance difference between cheapest and most expensive

**Texture Atlasing:**
```javascript
// Pack 10 textures into 1 atlas
// Adjust UV coordinates per object
// Use 1 material instead of 10
```
- **Impact:** Reduces draw calls, texture switches
- **Use case:** Objects with different textures but same material properties
- **Result:** 10x reduction in draw calls for textured objects

#### 3. Texture Optimization

**Texture compression:**
```javascript
// Use KTX2/Basis Universal (5-10x smaller than PNG)
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader';
```
- **Impact:** 5-10x smaller GPU memory usage
- **Use case:** All textures in production
- **Result:** 4096x4096 texture: 64MB → 6-12MB

**Texture resolution:**
```javascript
// Cap texture resolutions
if (texture.image.width > 1024) {
  // Resize or use lower resolution version
}
```
- **Impact:** Direct reduction in GPU memory
- **Use case:** All textures, use mipmaps
- **Result:** 4x reduction in memory when halving resolution

**Mipmaps:**
```javascript
texture.generateMipmaps = true;
texture.minFilter = THREE.LinearMipmapLinearFilter;
```
- **Impact:** Reduces GPU memory bandwidth for distant objects
- **Use case:** All textures
- **Result:** Smoother performance, less shimmering

#### 4. Draw Call Optimization

**Draw call targets:**
- **Desktop:** < 100 draw calls
- **Mobile:** < 50 draw calls
- **Chromebook:** Target < 30 draw calls

**Techniques:**
- Geometry merging
- InstancedMesh
- Texture atlasing
- Material purging
- Frustum culling (manual)

**Result:** Aggressive optimization can achieve < 10 draw calls for entire scene

#### 5. Pixel Ratio Capping

```javascript
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
```
- **Impact:** Rendering at 3x means 9x pixel fill vs 1x
- **Use case:** Always cap at 2x
- **Result:** Visual difference negligible, performance difference massive

#### 6. Shadow Optimization

**Disable shadow maps:**
```javascript
renderer.shadowMap.enabled = false;
```
- **Impact:** Shadow map generation requires full-scene render pass
- **Use case:** Chromebooks, mobile
- **Result:** Can double frame rate on weak GPUs

**Alternative:** Bake shadows into lightmaps (pre-computed)

#### 7. Object Pooling

```javascript
class ObjectPool {
  constructor(createFn, maxSize) {
    this.pool = [];
    this.createFn = createFn;
    this.maxSize = maxSize;
  }

  get() {
    return this.pool.pop() || this.createFn();
  }

  release(obj) {
    if (this.pool.length < this.maxSize) {
      obj.visible = false;
      this.pool.push(obj);
    }
  }
}
```
- **Impact:** Avoids memory allocation in hot loop
- **Use case:** Projectiles, particles, temporary objects
- **Result:** Eliminates garbage collection pauses

#### 8. Web Worker Offloading

```javascript
// worker.js
self.onmessage = (e) => {
  const { positions, velocities } = e.data;
  // Heavy computation here
  self.postMessage(result);
};

// main.js
worker.postMessage({ positions, velocities });
```
- **Impact:** Moves heavy computation off main thread
- **Use case:** Physics calculations, pathfinding
- **Result:** Smoother main thread, better frame times

#### 9. Level of Detail (LOD)

```javascript
const lod = new THREE.LOD();
lod.addLevel(meshHigh, 0);
lod.addLevel(meshMedium, 50);
lod.addLevel(meshLow, 100);
```
- **Impact:** Reduces polygon count for distant objects
- **Use case:** Large environments, many objects
- **Result:** 50-70% polygon reduction at distance

#### 10. Memory Management

**Dispose pattern:**
```javascript
function disposeObject(obj) {
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    if (Array.isArray(obj.material)) {
      obj.material.forEach(m => disposeMaterial(m));
    } else {
      disposeMaterial(obj.material);
    }
  }
}

function disposeMaterial(mat) {
  if (mat.map) mat.map.dispose();
  if (mat.normalMap) mat.normalMap.dispose();
  mat.dispose();
}
```
- **Impact:** Prevents memory leaks
- **Use case:** When removing objects from scene
- **Result:** Stable memory usage over time

### Babylon.js Optimization Strategies

#### 1. Performance Priority Modes

```javascript
scene.performancePriority = BABYLON.ScenePerformancePriority.Aggressive;
```

**Modes:**
- **BackwardCompatible (default):** No changes, prioritizes ease of use
- **Intermediate:** Automatic optimizations
- **Aggressive:** Maximum performance optimizations

**Aggressive mode automatically:**
- Disables some features
- Uses faster algorithms
- Reduces accuracy for performance

**Impact:** Significant performance boost with single line of code

#### 2. Freeze Active Meshes

```javascript
scene.freezeActiveMeshes();
```
- **Impact:** Removes frustum culling overhead
- **Use case:** Static scenes, no dynamic additions
- **Result:** Dramatic reduction in CPU time for mesh selection
- **Trade-off:** Cannot add/remove meshes without unfreezing

#### 3. Thin Instances

```javascript
const thinInstance = mesh.createThinInstance();
```
- **Impact:** More efficient than regular instances
- **Use case:** Static meshes with many instances
- **Result:** Better performance than regular instances
- **Trade-off:** More complex to manage

#### 4. Merge Meshes

```javascript
const merged = BABYLON.Mesh.MergeMeshes([mesh1, mesh2, mesh3]);
```
- **Impact:** Reduces draw calls
- **Use case:** Static geometry
- **Result:** Similar to Three.js geometry merging

#### 5. GPU Particle Systems

```javascript
const particleSystem = new BABYLON.GPUParticleSystem("particles", capacity, scene);
```
- **Impact:** Moves particle computation to GPU
- **Use case:** Particle systems (instead of CPU particles)
- **Result:** Significant CPU savings

#### 6. Disable Stencil

```javascript
engine.setStencilBuffer(false);
```
- **Impact:** Saves GPU memory and performance
- **Use case:** If not using stencil operations
- **Result:** Small but measurable improvement

#### 7. Hardware Scaling Level

```javascript
engine.setHardwareScalingLevel(0.5); // Render at half resolution
```
- **Impact:** Reduces pixel fill
- **Use case:** Low-end devices
- **Result:** 4x reduction in pixel fill (0.5 scaling)

#### 8. AutoClear Optimization

```javascript
scene.autoClear = false;
scene.autoClearDepthAndStencil = false;
```
- **Impact:** Skips clearing if not needed
- **Use case:** When camera always covers full viewport
- **Result:** Small performance gain

#### 9. Skip Mesh Selection

```javascript
scene.skipFrustumClipping = true;
```
- **Impact:** Skips CPU-side mesh selection
- **Use case:** When you know all meshes are visible
- **Result:** Significant CPU savings
- **Trade-off:** Only works for specific scenarios

#### 10. Pre-create Lights

```javascript
// Create all lights with intensity 0 at startup
// Enable/disable as needed instead of creating/destroying
```
- **Impact:** Avoids shader compilation during gameplay
- **Use case:** Dynamic lighting
- **Result:** Eliminates lag spikes when lights appear

#### 11. Built-in Inspector

```javascript
scene.debugLayer.show();
```
- **Impact:** Real-time debugging and profiling
- **Use case:** Development, optimization
- **Result:** Identify bottlenecks quickly

#### 12. SceneInstrumentation

```javascript
const instrumentation = new BABYLON.SceneInstrumentation(scene);
instrumentation.captureGPUFrameTime = true;
instrumentation.captureShaderCompilationTime = true;
```
- **Impact:** Detailed performance metrics
- **Use case:** Profiling, optimization
- **Result:** Data-driven optimization decisions

## Real-World Performance Data

### Shell Shockers (Babylon.js on Chromebooks)

**Success story:**
- **Engine:** Babylon.js
- **Platform:** Browser FPS
- **Chromebook players:** 39% of player base
- **Performance:** 60fps on Chromebooks
- **Lifetime players:** 200M+
- **Optimization strategy:** Aggressive asset budgets, cartoon shading

**Key insights:**
- Babylon.js CAN achieve 60fps on Chromebooks
- Requires aggressive optimization
- Cartoon shading reduces GPU load
- Asset budgeting critical

### Expeditione (Three.js 1MB, 9 Draw Calls)

**Success story:**
- **Engine:** Three.js
- **Bundle size:** ~1MB total (geometry, textures, shaders, audio, code)
- **Draw calls:** 9 (95% reduction from original)
- **Technique:** Material purging + instancing
- **Result:** Flawless performance on any device

**Key insights:**
- Three.js can achieve extreme optimization
- Material purging is powerful technique
- Draw call reduction is critical
- Bundle size can be extremely small

### BattleTabs (Babylon.js Optimization Journey)

**Optimization results:**
- **CPU throttle:** 6x slowdown simulation
- **Performance improvement:** 70-100%
- **Key optimizations:**
  - freezeActiveMeshes (removed mesh selection time)
  - VATs (Vertex Animation Textures) for animations
  - Reduced draw calls

**Key insights:**
- Babylon.js CPU overhead can be significant
- freezeActiveMeshes is powerful optimization
- VATs move animation to GPU
- 70-100% improvement possible with optimization

## Performance Targets by Platform

| Platform | Target FPS | Draw Calls | Triangles | Memory |
|----------|------------|------------|-----------|--------|
| Desktop | 60 | < 100 | < 10M | < 500MB |
| Mobile | 60 | < 50 | < 1M | < 200MB |
| Chromebook | 60 | < 30 | < 500K | < 100MB |
| Low-end mobile | 30 | < 20 | < 200K | < 100MB |

**Chromebook-specific targets:**
- **Draw calls:** < 30 (aggressive)
- **Triangles:** < 500K
- **Memory:** < 100MB total
- **Bundle size:** < 5MB total
- **Texture memory:** < 50MB

## Comparison Summary

| Aspect | Three.js | Babylon.js | Winner for Chromebooks |
|--------|----------|------------|------------------------|
| **Bundle size** | 168KB | 1.4MB | Three.js (8x smaller) |
| **Memory footprint** | Minimal | Higher | Three.js |
| **CPU usage** | Lighter | Heavier | Three.js (weak CPU) |
| **GPU usage** | Higher | Lower | Three.js (GPU-heavy better) |
| **Draw call optimization** | Manual (more control) | Built-in helpers | Three.js (more control) |
| **Instancing** | InstancedMesh | Thin instances | Tie |
| **Geometry merging** | Manual | Built-in | Babylon.js (easier) |
| **Material optimization** | Manual (more control) | Built-in | Three.js (more control) |
| **Texture compression** | KTX2Loader | KhronosTextureContainer2 | Tie |
| **Debugging tools** | External (Chrome DevTools) | Built-in Inspector | Babylon.js |
| **Performance profiling** | Manual | SceneInstrumentation | Babylon.js |
| **Learning curve** | Steeper | Easier | Babylon.js |
| **Chromebook proven** | Yes (Krunker) | Yes (Shell Shockers) | Tie |
| **Extreme optimization** | More control | Built-in modes | Three.js (control) |

## Recommendations for Tribes-Inspired Browser FPS

### Primary Recommendation: Three.js

**Reasons:**
1. **Bundle size critical** - 8x smaller (168KB vs 1.4MB) matters enormously on 2-4GB Chromebooks
2. **GPU-heavy approach** - Better for weak CPU devices (Chromebooks)
3. **More control** - Can optimize specifically for your use case
4. **Custom physics** - Need custom skiing/jetpack physics anyway
5. **Custom networking** - Need custom implementation anyway
6. **Don't pay for unused features** - Babylon's built-in features not needed

**Optimization strategy:**
1. **Material purging** for static environment (1 draw call)
2. **InstancedMesh** for projectiles, particles
3. **Texture atlasing** for weapons, players
4. **KTX2 compression** for all textures
5. **Cap pixel ratio at 2x**
6. **Disable shadow maps** (bake if needed)
7. **Object pooling** for projectiles
8. **Web Workers** for physics calculations
9. **LOD** for distant players
10. **Aggressive draw call target** (< 30)

**Expected results:**
- Bundle size: < 5MB total
- Draw calls: < 30
- Memory: < 100MB
- FPS: 60fps on Chromebooks

### Alternative: Babylon.js (if team prefers)

**Reasons to choose Babylon.js:**
1. **Proven on Chromebooks** - Shell Shockers success story
2. **Built-in Inspector** - Excellent for debugging
3. **Performance priority modes** - One-line optimizations
4. **Easier learning curve** - More guided
5. **Built-in optimization tools** - Less manual work

**Optimization strategy:**
1. **Aggressive performance mode**
2. **freezeActiveMeshes** for static environment
3. **Thin instances** for repeated geometry
4. **GPU particle systems**
5. **Hardware scaling level** for quality settings
6. **Pre-create lights** (intensity 0)
7. **Merge meshes** in Blender
8. **Disable stencil** if not needed
9. **Use Inspector** for profiling
10. **SceneInstrumentation** for metrics

**Expected results:**
- Bundle size: < 8MB total (larger due to engine)
- Draw calls: < 50
- Memory: < 150MB
- FPS: 60fps on Chromebooks (with aggressive optimization)

## Decision Framework

### Choose Three.js if:
- Targeting Chromebooks specifically (39% of Shell Shockers players)
- Bundle size is critical (< 5MB target)
- Need maximum control over optimization
- Custom physics required (skiing, jetpacks)
- Custom networking required (WebTransport)
- Team comfortable with manual optimization
- Want to minimize engine overhead

### Choose Babylon.js if:
- Team prefers guided development
- Want built-in debugging tools (Inspector)
- Value built-in optimization modes
- Less experienced with 3D optimization
- Want faster initial development
- Accept larger bundle size
- Willing to follow Shell Shockers optimization patterns

## Conclusion

**For super low-spec devices (Chromebooks), Three.js has a clear advantage:**

1. **8x smaller bundle** (168KB vs 1.4MB) - decisive factor on 2-4GB RAM
2. **GPU-heavy approach** - better for weak CPU devices
3. **More control** - can optimize specifically for your use case
4. **Proven success** - Krunker runs on Chromebooks with Three.js

**However, Babylon.js is viable:**
- Shell Shockers proves 60fps on Chromebooks is achievable
- Requires aggressive optimization (asset budgets, cartoon shading)
- Built-in tools make optimization easier
- Better for teams less experienced with optimization

**For Tribes-inspired browser FPS:**
- **Three.js recommended** for maximum control and minimal overhead
- Custom physics and networking required anyway
- Bundle size critical for viral sharing
- GPU-heavy approach better for Chromebook profile

**The key insight:** Both can achieve 60fps on Chromebooks with proper optimization. The choice comes down to team preference and development philosophy. Three.js gives you more control; Babylon.js gives you more built-in tools. For extreme optimization on super low-spec devices, Three.js's smaller bundle and GPU-heavy approach provide a measurable advantage.
