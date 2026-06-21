# Terrain Texturing Techniques

## Current Implementation
The current terrain uses a custom GLSL shader with height-based splatting:
- Sand at low elevations (0-6 units)
- Grass at mid elevations (6-21 units)
- Rock at high elevations (21-28.5 units)
- Snow at peaks (28.5-30 units)
- Smooth transitions between biomes
- Subtle noise for texture variation
- Basic directional lighting

## Advanced Techniques for Improvement

### 1. Triplanar Mapping
**Purpose**: Texturing surfaces without UV coordinates by projecting textures along three axes (X, Y, Z) and blending based on surface normals.

**How it works**:
- Sample texture from three projections: XY, XZ, ZY
- Blend between projections based on surface normal direction
- Prevents texture stretching on steep terrain
- Ideal for cliffs and complex terrain shapes

**Benefits**:
- No UV coordinates needed
- Textures look correct on any surface orientation
- Eliminates stretching artifacts on steep slopes

**Drawbacks**:
- 3x texture sampling cost (expensive)
- More complex shader code

**Implementation approach**:
```glsl
// Sample from three projections
float3 albedoX = tex2D(texture, position.zy);
float3 albedoY = tex2D(texture, position.xz);
float3 albedoZ = tex2D(texture, position.xy);

// Blend based on normal
float3 weights = abs(normal) / (abs(normal).x + abs(normal).y + abs(normal).z);
float3 finalColor = albedoX * weights.x + albedoY * weights.y + albedoZ * weights.z;
```

### 2. Slope-Based Texturing
**Purpose**: Use terrain steepness (slope angle) to determine material placement, not just height.

**How it works**:
- Calculate slope from terrain normal
- Flat areas → grass/dirt
- Steep areas → rock/cliffs
- Can be combined with height-based blending

**Benefits**:
- More realistic terrain (cliffs naturally get rock)
- Prevents grass on vertical surfaces
- Better visual logic

**Implementation**:
```glsl
float slope = 1.0 - normal.y; // 0 = flat, 1 = vertical
if (slope > 0.5) {
    // Rock on steep surfaces
} else {
    // Grass on flat surfaces
}
```

### 3. Detail Maps and Macro Variation
**Purpose**: Break up texture repetition and add visual interest at multiple scales.

**Techniques**:

#### Stochastic Tiling
- Randomized texture sampling to reduce visible repeating patterns
- Samples from slightly offset positions based on noise

#### Macro Variation Textures
- Large-scale color variations across terrain
- Breaks up uniform surfaces
- Can be a low-resolution color gradient texture

#### Detail Normals at Multiple Scales
- Combine fine detail normal maps (close-up detail)
- With coarse normal maps (distance detail)
- Maintains detail at all viewing distances

**Implementation**:
```glsl
// Base texture
float3 baseColor = tex2D(baseTexture, uv * tiling);

// Macro variation
float3 macroColor = tex2D(macroTexture, uv * macroTiling);
baseColor *= macroColor;

// Detail normal at multiple scales
float3 detail1 = tex2D(detailNormal1, uv * detailTiling1);
float3 detail2 = tex2D(detailNormal2, uv * detailTiling2);
normal = normalize(normal + detail1 * 0.5 + detail2 * 0.25);
```

### 4. Height-Based Blending with Displacement
**Purpose**: Use height information within textures to create natural material transitions.

**How it works**:
- Each texture has a height map
- When blending materials, use height to determine which material "wins"
- Dirt accumulates in cracks between rocks
- More natural transitions than simple alpha blending

**Benefits**:
- Dirt naturally fills low areas
- Rock appears on top of dirt
- Self-shadowing effects possible

### 5. Parallax Occlusion Mapping (POM)
**Purpose**: Simulate 3D depth and detail in textures without adding geometry.

**How it works**:
- Use a height map to offset texture coordinates
- Simulates depth by "pushing" texture pixels based on viewing angle
- Can include self-occlusion (depth shadows)

**Benefits**:
- Adds perceived depth without geometry
- Great for rocky surfaces, brick walls, cobblestone
- Relatively inexpensive compared to actual geometry

**Drawbacks**:
- Performance cost (multiple texture samples per pixel)
- Can have artifacts at extreme angles
- Requires good height maps

### 6. Procedural Texturing Rules
**Purpose**: Automatically generate material distribution based on terrain data.

**Data sources**:
- **Slope angle**: Cliffs get rock, flat areas get grass
- **Altitude**: Snow line on peaks, sand at beaches
- **Curvature**: Dirt accumulates in valleys/crevices
- **Erosion data**: Sediment distribution along riverbeds
- **Flow maps**: Water-influenced material placement

**Benefits**:
- Scales to large worlds
- Automatic updates when terrain changes
- Consistent material placement
- Faster production workflow

## Recommended Improvements for Current Project

### Priority 1: Slope-Based Texturing
Add slope detection to the current shader:
- Steep areas (>45°) → rock
- Flat areas → grass/sand
- Combine with existing height-based blending

**Implementation**: Add to current fragment shader
```glsl
float slope = 1.0 - normalize(vNormal).y;
float rockWeight = smoothstep(0.3, 0.7, slope);
color = mix(color, rockColor, rockWeight);
```

### Priority 2: Detail Normal Map
Add a tiling detail normal map for surface detail:
- Small rocky detail texture
- Tiled at high frequency
- Adds surface roughness

**Implementation**: Create or find a rocky detail texture, sample in shader

### Priority 3: Macro Variation
Add large-scale color variation:
- Low-resolution noise texture
- Breaks up uniform color
- Makes terrain look more organic

### Priority 4: Triplanar Mapping (Optional)
If performance allows, implement triplanar for steep areas:
- Only use on surfaces with slope > threshold
- Blends with existing UV mapping
- Prevents texture stretching on cliffs

## Performance Considerations

- **Triplanar mapping**: 3x texture samples - expensive
- **POM**: 8-16 samples per pixel - very expensive
- **Detail maps**: 1-2 extra samples - moderate cost
- **Slope-based**: Just math - very cheap
- **Macro variation**: 1 extra sample - cheap

**Recommendation**: Start with slope-based and detail maps (cheap, good impact). Add triplanar/POM only if performance budget allows.

## Runtime Procedural Texture Generation

Beyond vertex painting and static textures, we can generate textures at runtime using procedural techniques. This offers infinite variation without requiring external texture assets.

### Options for Runtime Texture Generation

#### 1. Babylon.js DynamicTexture with Canvas API
**Purpose**: Generate textures using HTML5 Canvas 2D drawing operations.

**How it works**:
- Create a DynamicTexture that wraps an HTML5 Canvas
- Use Canvas 2D API to draw gradients, patterns, noise
- Update the texture in real-time
- Apply as material texture

**Benefits**:
- Full Canvas API access (gradients, paths, images, text)
- Easy to implement
- Can generate complex patterns
- Updates in real-time

**Drawbacks**:
- CPU-based generation (slower than GPU)
- Limited to 2D operations
- Performance cost for frequent updates

**Implementation**:
```javascript
// Create dynamic texture
const dynamicTexture = new BABYLON.DynamicTexture(
  'noiseTexture',
  { width: 512, height: 512 },
  scene
);

// Get canvas context
const ctx = dynamicTexture.getContext();

// Generate noise pattern
for (let x = 0; x < 512; x++) {
  for (let y = 0; y < 512; y++) {
    const noise = Math.random();
    ctx.fillStyle = `rgb(${noise * 255}, ${noise * 255}, ${noise * 255})`;
    ctx.fillRect(x, y, 1, 1);
  }
}

// Update texture
dynamicTexture.update();

// Apply to material
material.diffuseTexture = dynamicTexture;
```

**Use cases**:
- Procedural gradients
- Simple noise patterns
- Dynamic text/labels
- User-customizable textures

#### 2. GLSL Shader-Based Noise Generation
**Purpose**: Generate textures directly in the fragment shader using mathematical noise functions.

**How it works**:
- Implement noise functions (Perlin, Simplex, Worley) in GLSL
- Sample noise in fragment shader
- Use noise to drive color, roughness, or displacement
- All computation happens on GPU

**Benefits**:
- GPU-accelerated (very fast)
- No texture memory overhead
- Infinite resolution
- Can be animated

**Drawbacks**:
- More complex shader code
- Limited to what can be expressed mathematically
- Can be expensive if noise is complex

**Noise Types**:

##### Perlin Noise
Classic gradient noise, smooth and natural-looking.
```glsl
float perlinNoise(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  
  // Smooth interpolation
  vec2 u = f * f * (3.0 - 2.0 * f);
  
  return mix(
    mix(dot(hash2D(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
        dot(hash2D(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
    mix(dot(hash2D(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
        dot(hash2D(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
    u.y
  );
}
```

##### Simplex Noise
Improved version of Perlin noise, faster and fewer artifacts.
```glsl
float simplexNoise(vec2 st) {
  // Skew input space
  vec2 s = floor(st + (st.x + st.y) * 0.5);
  vec2 f = fract(st + (st.x + st.y) * 0.5);
  
  // Determine simplex cell
  float t = fract(s.x + s.y) * 0.5;
  vec2 ofs = (t < 0.5) ? vec2(0.0, 0.0) : vec2(1.0, 0.0);
  
  // Calculate noise
  // ... (full implementation is more complex)
}
```

##### Worley Noise (Cellular/Voronoi)
Creates cell-like patterns, great for rocky surfaces.
```glsl
float worleyNoise(vec2 st) {
  vec2 ist = floor(st);
  vec2 fst = fract(st);
  
  float minDist = 1.0;
  
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 point = hash2D(ist + neighbor);
      vec2 diff = neighbor + point - fst;
      float dist = length(diff);
      minDist = min(minDist, dist);
    }
  }
  
  return minDist;
}
```

**Fractal Brownian Motion (FBM)**
Layer multiple octaves of noise for detail.
```glsl
float fbm(vec2 st, int octaves) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  
  for (int i = 0; i < octaves; i++) {
    value += amplitude * perlinNoise(st * frequency);
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  
  return value;
}
```

**Implementation in terrain shader**:
```glsl
// In fragment shader
float noise = fbm(vUv * 10.0, 4); // 4 octaves
vec3 color = mix(grassColor, rockColor, noise);
```

#### 3. Babylon.js NoiseProceduralTexture
**Purpose**: Built-in procedural noise texture generator.

**How it works**:
- Babylon.js provides a pre-built noise texture generator
- Configurable octaves, persistence, animation speed
- Generates noise on GPU

**Benefits**:
- Easy to use (no custom shader needed)
- GPU-accelerated
- Configurable parameters
- Can be animated

**Drawbacks**:
- Limited to built-in noise types
- Less control than custom GLSL
- Still requires texture memory

**Implementation**:
```javascript
const noiseTexture = new BABYLON.NoiseProceduralTexture('noise', 512, scene);
noiseTexture.octaves = 4;
noiseTexture.persistence = 0.8;
noiseTexture.animationSpeedFactor = 0; // Static
noiseTexture.brightness = 1.0;

material.diffuseTexture = noiseTexture;
```

#### 4. Hybrid Approach: Canvas + Shader
**Purpose**: Generate base texture with Canvas, add detail with shader noise.

**How it works**:
- Use DynamicTexture to generate base color patterns
- Use GLSL noise for fine detail and variation
- Combine in fragment shader

**Benefits**:
- Best of both worlds
- Canvas for complex patterns (gradients, shapes)
- Shader for performance and detail
- Flexible

**Implementation**:
```javascript
// Generate base gradient with Canvas
const baseTexture = new BABYLON.DynamicTexture('base', 512, scene);
const ctx = baseTexture.getContext();
const gradient = ctx.createLinearGradient(0, 0, 0, 512);
gradient.addColorStop(0, '#2d5a27');
gradient.addColorStop(1, '#8b7355');
ctx.fillStyle = gradient;
ctx.fillRect(0, 0, 512, 512);
baseTexture.update();

// Use in shader with additional noise
material.diffuseTexture = baseTexture;
```

```glsl
// In fragment shader
vec3 baseColor = texture2D(baseTexture, vUv).rgb;
float noise = perlinNoise(vUv * 20.0);
vec3 finalColor = baseColor * (0.8 + 0.4 * noise);
```

### Recommended Approach for This Project

**Option 1: GLSL Shader Noise (Recommended)**
- Add Perlin/Simplex noise functions to current terrain shader
- Use noise to vary color within each biome
- Add FBM for multi-scale detail
- No extra texture memory, GPU-accelerated

**Option 2: DynamicTexture for Macro Variation**
- Generate a low-res noise texture with Canvas
- Use as macro variation texture
- Combine with shader-based detail noise
- Good balance of control and performance

**Option 3: NoiseProceduralTexture (Quickest)**
- Use Babylon's built-in noise texture
- Simple to implement
- Limited customization but effective

### Performance Comparison

| Method | GPU Cost | Memory | Complexity | Flexibility |
|--------|----------|--------|------------|-------------|
| DynamicTexture (Canvas) | Low (upload) | Medium | Low | High |
| GLSL Shader Noise | Medium | None | High | Very High |
| NoiseProceduralTexture | Low | Medium | Very Low | Low |
| Hybrid | Medium | Low | Medium | Very High |

**Recommendation**: Start with GLSL shader noise for maximum flexibility and zero memory overhead. If shader complexity becomes an issue, fall back to NoiseProceduralTexture.

## Current Implementation (Advanced Procedural Shader)

The terrain now uses a sophisticated GLSL shader with multiple advanced techniques:

### Techniques Implemented

#### 1. Domain Warping
Organic noise patterns created by warping the noise space with additional noise layers. Creates natural, flowing patterns instead of regular grid-like noise.

```glsl
vec2 domainWarp(vec2 p) {
  vec2 q = vec2(fbm(p + vec2(0.0, 0.0), 3), fbm(p + vec2(5.2, 1.3), 3));
  vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2), 3), fbm(p + 4.0 * q + vec2(8.3, 2.8), 3));
  return p + 4.0 * r;
}
```

#### 2. Multi-Scale Noise Layers
Three noise layers at different scales:
- **Macro noise** (domain-warped): Large-scale patterns
- **Detail noise**: Medium-scale variation
- **Fine noise**: Small-scale detail

Combined with weighted blending for natural appearance.

#### 3. Wetness Accumulation
Simulates water pooling in low areas and flat surfaces:
- Lower elevations = more wet
- Flatter slopes = more wet (water pools)
- Noise variation for patchy wetness

Creates darker, wetter areas in valleys and depressions.

#### 4. Snow Accumulation
Realistic snow distribution:
- High elevations = more snow
- Flat areas hold snow better (doesn't slide off)
- Noise for patchy, natural snow coverage

Snow accumulates on peaks and flat high areas, not on steep cliffs.

#### 5. Crevice/Dirt Accumulation
Dirt accumulates in low areas and crevices:
- Based on noise values
- Only in flat areas (not on cliffs)
- Only at lower elevations

Creates realistic dirt patches in valleys and depressions.

#### 6. Wet/Dry Color Variants
Each biome has wet and dry color variants:
- Wet colors are darker and more saturated
- Wetness blends between dry and wet variants
- Creates realistic moisture variation

#### 7. Enhanced Lighting
- Ambient occlusion approximation based on slope and noise
- Steep areas and dark noise areas receive less ambient light
- Creates depth and realism

#### 8. Fog Integration
- Shader calculates fog factor based on distance
- Blends terrain color with fog color
- Matches scene fog for seamless integration

### Biomes with Transitions
- **Sand/Beach** (0-15%): Sandy brown, wet variant
- **Sand to Grass** (15-40%): Smooth transition
- **Grass** (40-70%): Green grass, wet/dark variants
- **Grass to Rock** (70-85%): Smooth transition
- **Rock** (85-95%): Gray rock, wet/dark variants
- **Rock to Snow** (95-100%): Snow on peaks

### Performance Characteristics
- All procedural (no texture memory)
- GPU-accelerated
- Moderate cost due to multiple noise samples
- Optimized with early breaks in loops

## References
- Triplanar Mapping: https://catlikecoding.com/unity/tutorials/advanced-rendering/triplanar-mapping/
- World Creator Terrain Guide: https://www.world-creator.com/en/learn/guides/digital-terrain-creation/digital-terrain-creation.phtml
- Texture Splatting: https://en.wikipedia.org/wiki/Texture_splatting
- Parallax Occlusion Mapping: https://en.wikipedia.org/wiki/Parallax_occlusion_mapping
- Babylon.js DynamicTexture: https://doc.babylonjs.com/features/featuresDeepDive/materials/using/dynamicTexture
- WebGL Noise (GLSL): https://github.com/ashima/webgl-noise
- The Book of Shaders - Noise: https://thebookofshaders.com/11/
- GLSL Noise Library: https://stegu.github.io/webgl-noise/webdemo/
- Slope Based Texturing: https://rastertek.com/tertut14.html
- Domain Warping: Inigo Quilez domain warping techniques
