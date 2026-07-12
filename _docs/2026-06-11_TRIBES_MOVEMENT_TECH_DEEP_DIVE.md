# Tribes Movement Technology Deep Dive

## Overview

This document provides a comprehensive technical analysis of the movement systems in Tribes 1 and Tribes 2, based on the reverse-engineering work documented at [floodyberry.wordpress.com](https://floodyberry.wordpress.com/2008/02/20/tribes-1-physics-part-one-overview/).

## Tribes 1 Movement System

### Core Philosophy

Tribes 1's movement system is renowned for its fluid, predictable feel that enables the signature "skiing" mechanic. The system is built around several key principles:

1. **Constant Gravity**: Gravity is always applied, never disabled even when resting on a surface
2. **Tick-Based Physics**: Runs at 31.25 ticks per second (32ms per tick)
3. **Velocity-Based Movement**: Position updates are derived from velocity, not direct position manipulation
4. **Surface-Aware Physics**: Jump and collision responses respect surface normals
5. **Energy Management**: Jetpack energy system with drain/charge mechanics

### Physics Constants

```typescript
// Tribes 1 Constants (Light Armor - Scout)
TRIBES_TICKS_PER_SECOND = 31.25
TRIBES_TICK_LENGTH = 1.0 / 31.25 = 0.032s
GRAVITY = (0, -20, 0) // m/s²

// Armor Stats
ARMOR_WALKSPEED = 7 // m/s
ARMOR_JUMPIMPULSE = 9 // m/s
ARMOR_MASS = 0.8 // kg
ARMOR_MAXENERGY = 60
ARMOR_JETENERGY_DRAIN = 12 // energy per second
ARMOR_JETENERGY_CHARGE = 8 // energy per second
JET_FORCE = 28 // m/s²
CRAWLTOSTOP = 0.5 // m/s

// Jump Mechanics
MAXJUMPTICKS = 8 // 256ms / 32ms = 8 ticks (jump grace period)
```

### Movement Update Loop

The main physics tick follows this sequence:

```typescript
Player.Tick(Move move, int tickLenMs) {
    float tickLen = (1000 / tickLenMs)
    
    // 1. Create movement vectors from input
    move.speed = Vector3((right-left)*forwardSpeed, (forward-back)*sideSpeed, 0)
    move.speed = ToWorldSpace(move.speed)
    move.direction = move.speed.Normalize()
    
    // 2. Update energy
    energy += (armor.JETENERGY_CHARGE * tickLen)
    
    // 3. Check jump/jet conditions
    bool isJetting = (move.jetting && (energy > 0))
    bool isJumping = (move.jumping && (lastJumpableNormalTimestamp < MAXJUMPTICKS))
    
    // 4. Apply jump
    if (isJumping) velocity += Jump(move.direction)
    
    // 5. Apply jets and acceleration
    accel = Gravity.force
    if (isJetting) {
        accel += Jet(move.direction, tickLen)
        energy -= (armor.JETENERGY_DRAIN * tickLen)
    }
    energy.Clamp(0, armor.MAXENERGY)
    velocity += (accel / tickLen)
    
    // 6. Apply friction (only if on ground)
    if (collisionLastTick) velocity += Friction(move.speed, tickLen)
    
    // 7. Update jumpable timestamp
    lastJumpableNormalTimestamp += tickLenMs
    
    // 8. Update position
    position, velocity = UpdatePosition(tickLen)
}
```

### Jump Mechanics

The jump function is surface-aware and adds horizontal momentum based on movement direction:

```typescript
Player.Jump(Vector3 moveDirection) {
    // Reset jumpable timestamp
    lastJumpableNormalTimestamp = MAXJUMPTICKS
    
    // Calculate vertical jump component
    float surfaceDirection = lastJumpableNormal.Dot(Gravity.upNormal)
    float impulse = MetersToUnits(armor.JUMPIMPULSE / armor.MASS)
    Vector3 jump = (surfaceDirection * impulse) * Gravity.upNormal
    
    // Add horizontal component if moving away from surface
    float orientation = lastJumpableNormal.Dot(moveDirection)
    if (orientation > 0) {
        jump += (impulse * orientation) * moveDirection
    }
    
    return jump
}
```

**Key Insight**: The jump impulse is split between vertical (surface normal) and horizontal (movement direction) components. This means jumping while moving gives you forward momentum, which is crucial for skiing.

### Jet Mechanics

```typescript
Player.Jet(Vector3 moveDirection, float tickLen) {
    float jetForce = MetersToUnits(JET_FORCE)
    return moveDirection.scale(jetForce)
}
```

The jetpack applies force in the movement direction, not just upward. This allows for diagonal jetting and more precise control.

### Friction System

Friction is only applied when the player is on the ground:

```typescript
Player.Friction(Vector3 moveSpeed, float tickLen) {
    float velocityLen = velocity.Length
    float crawlToStop = MetersToUnits(CRAWLTOSTOP)
    
    // Stop completely if moving very slowly
    if (velocityLen < crawlToStop) {
        return velocity.scale(-1)
    }
    
    // Apply friction to match movement speed
    Vector3 friction = moveSpeed.subtract(velocity)
    return friction.scale(0.1) // Friction coefficient
}
```

**Critical Detail**: Friction is only applied when `collisionLastTick` is true. When airborne, there is NO friction, which enables skiing.

### Collision System

Tribes 1 uses a unique collision approach:

1. **Sliced Movement**: Movement is divided into 1-meter chunks for collision detection
2. **Velocity-First Update**: Position is updated based on velocity regardless of collision
3. **Velocity Adjustment**: On collision, velocity is adjusted based on surface normal
4. **Bounce Effect**: The player bounces slightly away from surfaces due to the velocity-first approach

```typescript
// Collision handling (simplified)
if (collisionDetected) {
    // Adjust velocity based on surface normal
    velocity = Reflect(velocity, surfaceNormal)
    
    // Position is still updated from original position
    // This creates the "bounce" effect
}
```

This approach feels more fluid than standard physics where position is clamped to collision point.

### Skiing Mechanic

Skiing in Tribes 1 is an emergent behavior from the physics system:

1. **No Air Friction**: When airborne, friction is not applied
2. **Gravity Acceleration**: Constant gravity accelerates the player downward
3. **Slope Conversion**: Downward velocity on slopes converts to horizontal velocity
4. **Momentum Preservation**: Jumping preserves horizontal momentum

The result: Players can build up massive speed by skiing down slopes, then maintain that speed across flat terrain.

## Tribes 2 Movement System

### What Went Wrong

According to the analysis at floodyberry.wordpress.com, Tribes 2's physics were "an abomination" for several reasons:

1. **Base+ Mod Influence**: Dynamix play-tested the Base+ mod for Tribes 1, which the community hated
2. **Different Feel**: Attempted to build on Tribes 1 when it was 2 years old, not 2 weeks old
3. **Incorrect Assumptions**: Made changes without understanding why Tribes 1 felt good

### Key Differences from Tribes 1

While specific technical details of Tribes 2's implementation are less documented, the community consensus identifies these issues:

1. **Different Gravity**: Gravity may have been disabled on ground contact
2. **Altered Friction**: Friction behavior differs, affecting skiing
3. **Jump Changes**: Jump mechanics don't preserve momentum the same way
4. **Collision Response**: Different collision handling feels "sticky" rather than fluid
5. **Jetpack Changes**: Energy system and force application differ

### Community Response

The Tribes community's reaction to Tribes 2 physics was overwhelmingly negative:

- **Base+ Mod**: Attempted to fix Tribes 2 physics but was "a pale ghost of Tribes 1"
- **Team Rabbit 2**: Another physics mod that failed to capture the feel
- **Classic Mod**: The most successful attempt, but still not authentic
- **Legends**: Different game that claimed to have original source code but felt wrong
- **Tribes Vengeance**: "So far removed from the feel of Tribes that it shouldn't even enter the discussion"

## Why Tribes 1 Feels Better

### The "Velcro" vs "Fluid" Distinction

The floodyberry analysis identifies a critical difference:

- **Standard Physics**: Clamp position to collision point → feels "velcroish" or sticky
- **Tribes Physics**: Update position from velocity regardless, then adjust velocity → feels fluid

This subtle difference is responsible for ~90% of the "Tribes feel."

### Emergent Gameplay

Tribes 1's physics enable emergent gameplay that wasn't explicitly designed:

1. **Skiing**: Discovered by players, became core mechanic
2. **Disc Jumping**: Using explosions to launch
3. **Route Planning**: Players memorize optimal paths across terrain
4. **Momentum Management**: Skill in preserving and building speed

### Predictability

Tribes 1 physics are highly predictable:

- Consistent tick rate (31.25 Hz)
- No random elements
- Mathematical precision
- Reproducible results

This predictability allows players to master the system and execute precise maneuvers.

## Implementation in Our Project

### Current Implementation

Our `tribesPhysics.ts` implements the core Tribes 1 mechanics:

```typescript
export class TribesPhysics {
    // Constants from Tribes 1
    private readonly TRIBES_TICKS_PER_SECOND = 31.25;
    private readonly GRAVITY = new BABYLON.Vector3(0, -20, 0);
    
    // Movement functions
    private jump(moveDirection: BABYLON.Vector3): BABYLON.Vector3
    private jet(moveDirection: BABYLON.Vector3, tickLen: number): BABYLON.Vector3
    private friction(moveSpeed: BABYLON.Vector3, tickLen: number): BABYLON.Vector3
    
    // Main physics tick
    tick(input: any, dt: number): void
}
```

### Integration

The Tribes physics system is integrated into `PlayerController`:

1. Initialized when ground mesh is provided
2. Replaces old physics system when active
3. Handles input, physics update, and camera positioning
4. Provides debug logging for tuning

### Differences from Original

Our implementation has some simplifications:

1. **Tick Rate**: Currently using frame time instead of fixed 31.25 Hz
2. **Collision**: Using raycast instead of triangle-level collision
3. **Movement Slicing**: Not implementing 1-meter movement chunks
4. **Energy Stutter**: Not implementing the 5% energy cutoff behavior

These can be refined for more authentic feel if needed.

## Tuning Guidelines

### If Movement Feels Too Fast/Slow

Adjust these constants in `tribesPhysics.ts`:

```typescript
ARMOR_WALKSPEED = 7; // Adjust walk speed
GRAVITY = new BABYLON.Vector3(0, -20, 0); // Adjust gravity strength
JET_FORCE = 28; // Adjust jetpack power
```

### If Jumping Feels Wrong

```typescript
ARMOR_JUMPIMPULSE = 9; // Adjust jump height
MAXJUMPTICKS = 8; // Adjust jump grace period (256ms / 32ms)
```

### If Skiing Doesn't Work

Ensure friction is only applied when on ground:

```typescript
if (this.state.collisionLastTick) {
    this.state.velocity.addInPlace(this.friction(moveSpeed, tickLen));
}
```

### If Energy Feels Wrong

```typescript
ARMOR_MAXENERGY = 60; // Total energy pool
ARMOR_JETENERGY_DRAIN = 12; // How fast energy depletes
ARMOR_JETENERGY_CHARGE = 8; // How fast energy recharges
```

## References

### Primary Sources

1. **[Tribes 1 Physics, Part One: Overview](https://floodyberry.wordpress.com/2008/02/20/tribes-1-physics-part-one-overview/)**
   - Overview of Tribes 1 physics system
   - Constants and structures
   - Tick-based physics explanation

2. **[Tribes 1 Physics, Part Two: Movement](https://floodyberry.wordpress.com/2008/02/24/tribes-1-physics-part-two-movement/)**
   - Jump, jet, and friction mechanics
   - Energy system
   - Movement code

3. **[Tribes 1 Physics, Part Three: Collision](https://floodyberry.wordpress.com/2008/04/11/tribes-1-physics-part-three-collision/)**
   - Collision detection and response
   - Movement slicing
   - Velocity-first vs position-first approaches

4. **[Tribes 1 Physics, Part Four: Explosions](https://floodyberry.wordpress.com/2008/04/29/tribes-1-physics-part-four-explosions/)**
   - Knockback mechanics
   - Disc jumping physics

### Community Resources

- **[Tribes Papers](https://tribespapers.blogspot.com/)**: Analysis of Tribes mechanics
- **[r/Tribes](https://www.reddit.com/r/Tribes/)**: Community discussions on physics
- **[Tribes Wiki](https://tribes.fandom.com/)**: Game documentation and mechanics

## Conclusion

Tribes 1's movement system is a masterpiece of emergent gameplay design. The combination of constant gravity, surface-aware physics, and the lack of air friction created a system that enabled skiing - a mechanic that became the defining feature of the series.

Tribes 2's failure to replicate this feel demonstrates that the details matter. Small changes to friction, collision response, or gravity application can completely alter the feel of a movement system.

Our implementation captures the core principles of Tribes 1 physics, providing an authentic feel while allowing for modern engine integration. Further tuning can refine the experience to match the original game's feel more closely.
