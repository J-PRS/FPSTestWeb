# Procedural Explosion VFX System

## Overview

The explosion VFX system uses a multi-layered particle approach combined with mesh-based effects and dynamic lighting to create a visually impressive, procedural explosion effect. This system is built on Babylon.js particle systems and follows industry-standard VFX techniques for game explosions.

## Architecture

The explosion consists of 5 distinct layers that work together to create a cohesive effect:

### Layer 1: Fire Core
- **Particle Count**: 500
- **Emitter**: Sphere emitter (radius 2)
- **Blend Mode**: Additive (for bright, glowing effect)
- **Lifetime**: 0.3-0.6 seconds
- **Gravity**: Light downward pull (-2 Y)
- **Emission Power**: 5-10
- **Color Gradient**: White → Yellow → Orange → Red → Transparent
- **Size Gradient**: 0.5 → 1.5 → 0.1 (expand then contract)

The fire core provides the initial bright flash and the central heat of the explosion. The additive blend mode makes overlapping particles brighter, simulating the intense light of an explosion.

### Layer 2: Smoke Plume
- **Particle Count**: 300
- **Emitter**: Sphere emitter (radius 1.5)
- **Blend Mode**: Standard (for realistic smoke accumulation)
- **Lifetime**: 1-2 seconds
- **Gravity**: Very light downward pull (-1 Y)
- **Emission Power**: 2-5
- **Color Gradient**: Gray → Dark Gray → Transparent
- **Size Gradient**: 1 → 4 (continuous expansion)

The smoke plume adds volume and persistence to the explosion, creating the characteristic rising smoke column that follows the initial blast. Standard blend mode allows smoke to accumulate realistically.

### Layer 3: Sparks/Debris
- **Particle Count**: 200
- **Emitter**: Sphere emitter (radius 1)
- **Blend Mode**: Additive
- **Lifetime**: 0.5-1 second
- **Gravity**: Heavy downward pull (-15 Y)
- **Emission Power**: 10-20 (fast directional burst)
- **Angular Speed**: π to 2π (rapid rotation)
- **Color Gradient**: Bright Yellow → Orange → Dark
- **Direction**: Upward cone pattern (-1,1,-1 to 1,2,1)

Sparks add dynamic motion and energy to the explosion. The heavy gravity and high emission power create the characteristic debris arc pattern seen in real explosions.

### Layer 4: Shockwave Ring
- **Type**: Torus mesh
- **Initial Diameter**: 1
- **Thickness**: 0.2
- **Animation**: Expands to scale 15 over 0.5 seconds
- **Material**: Emissive orange with alpha fade
- **Orientation**: Flat on ground (X rotation = π/2)

The shockwave provides visual impact and communicates the force of the explosion. The expanding ring creates a clear visual boundary for the blast radius.

### Layer 5: Light Flash
- **Type**: Point light
- **Initial Intensity**: 50
- **Range**: 20 units
- **Color**: Warm orange (1, 0.8, 0.5)
- **Duration**: 0.2 seconds
- **Animation**: Linear intensity fade to 0

The light flash creates the initial blinding effect of an explosion, illuminating nearby objects and surfaces. This is crucial for selling the impact of the explosion.

## Technical Implementation

### Particle System Configuration

Each particle layer uses Babylon.js `ParticleSystem` with the following key properties:

```typescript
const system = new BABYLON.ParticleSystem('name', capacity, scene);
system.particleTexture = new BABYLON.Texture('texture_url', scene);
system.emitter = position;
system.createSphereEmitter(radius);
```

### Gradients

Color and size gradients are used to animate particle properties over their lifetime:

```typescript
// Color gradient (normalized 0-1 over particle lifetime)
system.addColorGradient(0, new BABYLON.Color4(1, 1, 1, 1));  // Start
system.addColorGradient(0.5, new BABYLON.Color4(1, 0.5, 0, 0.8));  // Mid
system.addColorGradient(1, new BABYLON.Color4(0.5, 0, 0, 0));  // End

// Size gradient
system.addSizeGradient(0, 0.5);  // Start size
system.addSizeGradient(1, 2);  // End size
```

### Blend Modes

Two blend modes are used for different visual effects:

- **Additive (BLENDMODE_ADD)**: Used for fire and sparks. Overlapping particles add their colors together, creating bright, glowing effects.
- **Standard (BLENDMODE_STANDARD)**: Used for smoke. Particles blend normally, allowing smoke to accumulate and create realistic volume.

### Auto-Disposal

All particle systems are configured to automatically dispose after their effect completes:

```typescript
system.targetStopDuration = duration;  // Stop emitting after X seconds
system.disposeOnStop = true;  // Dispose when stopped
system.start();
```

This ensures no memory leaks from orphaned particle systems.

## Performance Considerations

- **Total Particles**: 1000 particles per explosion (500 fire + 300 smoke + 200 sparks)
- **Duration**: 2 seconds maximum (smoke layer)
- **Memory**: Auto-disposal prevents accumulation
- **GPU**: All particle rendering is GPU-accelerated

For performance-critical scenarios, consider:
1. Reducing particle counts
2. Using GPU particle systems (GPUParticleSystem) for higher particle counts
3. Limiting concurrent explosions
4. Implementing object pooling for frequently used effects

## Customization

### Adjusting Explosion Size

Modify the `maxScale` values for mesh effects and `maxSize` for particles:

```typescript
// Shockwave
const shockwaveMaxScale = 15;  // Increase for larger blast radius

// Fire
fireSystem.maxSize = 2;  // Increase for larger fire particles
```

### Changing Colors

Modify the color gradients to match different explosion types:

```typescript
// Blue explosion (energy weapon)
fireSystem.addColorGradient(0, new BABYLON.Color4(0.5, 0.5, 1, 1));
fireSystem.addColorGradient(1, new BABYLON.Color4(0, 0, 0.5, 0));

// Green explosion (chemical/toxic)
fireSystem.addColorGradient(0, new BABYLON.Color4(0.5, 1, 0.5, 1));
fireSystem.addColorGradient(1, new BABYLON.Color4(0, 0.5, 0, 0));
```

### Adding More Layers

Additional particle systems can be added for more complex effects:

```typescript
// Example: Dust cloud
const dustSystem = new BABYLON.ParticleSystem('dust', 400, this.scene);
dustSystem.particleTexture = new BABYLON.Texture('texture_url', this.scene);
// Configure dust properties...
dustSystem.start();
```

## References

- [Babylon.js Particle System Documentation](https://doc.babylonjs.com/features/featuresDeepDive/particles/particle_system)
- [Particle Gradients](https://doc.babylonjs.com/features/featuresDeepDive/particles/particle_system/tuning_gradients)
- [Blend Modes](https://doc.babylonjs.com/features/featuresDeepDive/particles/particle_system/ramps_and_blends)
- [Shape Emitters](https://doc.babylonjs.com/features/featuresDeepDive/particles/particle_system/shape_emitters)

## Future Enhancements

Potential improvements for the explosion system:

1. **GPU Particles**: Switch to GPUParticleSystem for higher particle counts and better performance
2. **Sound Integration**: Add explosion sound effects with spatial audio
3. **Camera Shake**: Add screen shake effect on explosion
4. **Impact Decals**: Add burn marks or scorch decals to surfaces
5. **Sub-Emitters**: Use sub-emitters for secondary explosions or cascading effects
6. **Flow Maps**: Use flow maps for more complex particle motion patterns
7. **Node Particle Editor**: Visual design using Babylon.js NPE for easier iteration
