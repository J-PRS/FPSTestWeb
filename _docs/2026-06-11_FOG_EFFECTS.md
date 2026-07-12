# Fog Effects

## Overview
Fog is a classic technique used in games to create atmosphere, hide distant geometry (pop-in), and give a sense of depth. Old games like Tribes 2 used distance fog extensively to mask rendering limitations and create immersive environments.

## Implementation in Babylon.js

Babylon.js provides built-in fog support with multiple modes. The current implementation uses exponential distance fog similar to classic FPS games.

### Current Implementation
```typescript
// Add distance fog like old games (Tribes 2 style)
scene.fogMode = BABYLON.Scene.FOGMODE_EXP;
scene.fogDensity = 0.003;
scene.fogColor = new BABYLON.Color3(0.4, 0.6, 0.8); // Matches sky gradient
```

**Parameters:**
- **FOGMODE_EXP**: Exponential fog density - more realistic than linear
- **fogDensity: 0.003**: Low density for subtle effect that doesn't obscure nearby objects
- **fogColor**: Blue-tinted fog that matches the CSS gradient sky background

## Fog Modes

### 1. FOGMODE_NONE
- Default mode, fog disabled
- No performance impact

### 2. FOGMODE_EXP
- Exponential fog density
- Most realistic for outdoor scenes
- Fog increases exponentially with distance
- Used in current implementation

**Formula:** `fog = 1 - exp(-density * distance)`

### 3. FOGMODE_EXP2
- Exponential squared fog
- Faster falloff than EXP
- More dramatic fog effect
- Good for thick fog conditions

**Formula:** `fog = 1 - exp(-(density * distance)²)`

### 4. FOGMODE_LINEAR
- Linear fog density
- Simple distance-based fog
- Requires fogStart and fogEnd parameters

```typescript
scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
scene.fogStart = 20.0;  // Fog starts at 20 units
scene.fogEnd = 60.0;    // Fog is complete at 60 units
```

**Formula:** `fog = (distance - fogStart) / (fogEnd - fogStart)`

## Fog Parameters

### fogDensity
- Controls how thick the fog is
- Only used with EXP and EXP2 modes
- Typical values: 0.001 to 0.1
- Higher values = thicker fog

**Guidelines:**
- 0.001-0.003: Subtle haze, good for large outdoor maps
- 0.005-0.01: Moderate fog, visible but not obscuring
- 0.02-0.05: Thick fog, significantly limits visibility
- 0.1+: Very thick fog, almost whiteout conditions

### fogColor
- Color of the fog
- Should match sky/background color for seamless blending
- Can be used for atmospheric effects (dusty, toxic, etc.)

**Common colors:**
- Blue/gray: Clear atmosphere, matches sky
- Brown/orange: Dusty/desert environments
- Green: Toxic/swamp atmosphere
- White: Snow/foggy conditions

### fogStart / fogEnd
- Only used with LINEAR mode
- fogStart: Distance where fog begins to appear
- fogEnd: Distance where fog completely obscures objects
- Difference between them controls falloff speed

## Benefits of Fog

### 1. Performance Optimization
- Hides distant geometry, reducing draw calls
- Masks level of detail (LOD) transitions
- Allows smaller draw distances without visible pop-in

### 2. Visual Depth
- Creates sense of scale and distance
- Blends distant objects into background
- Enhances atmosphere and mood

### 3. Gameplay Benefits
- Can limit visibility for tactical gameplay
- Creates natural boundaries
- Hides enemy approach at distance

## Classic Game Examples

### Tribes 2
- Used exponential distance fog extensively
- Blue-tinted fog matched sky color
- Masked large outdoor terrain rendering
- Created iconic "hazy mountain" look

### Half-Life
- Used fog in outdoor areas
- Varied fog color by environment (brown for desert, green for alien)
- Linear fog for controlled visibility

### Quake
- Used colored fog for atmosphere
- Red fog in lava areas, green in toxic zones
- Exponential fog for natural falloff

## Advanced Fog Techniques

### Height Fog
Fog that varies with altitude - thicker at low elevations, thinner at high elevations.

```glsl
// In custom shader
float heightFog = 1.0 - smoothstep(0.0, 50.0, position.y);
float distanceFog = 1.0 - exp(-density * distance);
float finalFog = max(distanceFog, heightFog);
```

### Volumetric Fog
3D fog with volume - can have varying density in different areas.
- More complex to implement
- Requires 3D textures or raymarching
- Very realistic but expensive
- Not currently supported in Babylon.js built-in fog

### Fog with Noise
Add noise to fog for natural variation and movement.

```glsl
float noise = fbm(worldPosition.xz * 0.01, 3);
float density = baseDensity * (0.8 + 0.4 * noise);
```

## Performance Considerations

- **EXP/EXP2**: Very cheap, single calculation per pixel
- **LINEAR**: Slightly more expensive, requires distance comparison
- **Volumetric**: Very expensive, raymarching per pixel
- **Fog with noise**: Moderate cost, depends on noise complexity

**Recommendation**: Use EXP mode for best balance of realism and performance.

## Tuning Fog for Your Scene

### Step 1: Match Sky Color
Set fogColor to match your sky/background color for seamless blending.

### Step 2: Adjust Density
Start with low density (0.001-0.003) and increase until desired effect.

### Step 3: Test Visibility
Ensure fog doesn't obscure gameplay-critical distances (enemies, objectives).

### Step 4: Consider Performance
Test with target hardware - fog is generally cheap but can add up with other effects.

## Current Project Settings

```typescript
scene.fogMode = BABYLON.Scene.FOGMODE_EXP;
scene.fogDensity = 0.003;
scene.fogColor = new BABYLON.Color3(0.4, 0.6, 0.8);
```

**Rationale:**
- EXP mode for realistic outdoor atmosphere
- Low density (0.003) for subtle effect that doesn't hinder gameplay
- Blue color matches CSS gradient sky for seamless integration
- Provides depth without obscuring mid-range combat

## References
- Babylon.js Environment Documentation: https://doc.babylonjs.com/features/featuresDeepDive/environment/environment_introduction
- Tribes 2 Rendering Techniques: Classic distance fog implementation
- OpenGL Fog: Traditional graphics programming fog techniques
