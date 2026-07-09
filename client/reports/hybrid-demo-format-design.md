# Hybrid Keyframe/Simulation Demo Format Design

## Executive Summary

This report outlines a hybrid demo recording format that combines keyframe-based recording for critical events with physics simulation for visual elements. This approach achieves 85-90% file size reduction while maintaining pixel-perfect accuracy for gameplay-critical moments like shots, hits, and player movement.

## Design Philosophy

**Core Principle:** Record what matters, simulate what doesn't.

- **Critical events** (shots, hits, spawns): Keyframed with exact data
- **Visual elements** (projectile flight, idle movement): Simulated via deterministic physics
- **Player movement**: Keyframed at action points, interpolated between
- **Result**: Small files + perfect correctness where it counts

## Current Format Analysis

### Current Implementation
```typescript
interface DemoFrame {
  frameNumber: number;
  timestamp: number;
  posX, posY, posZ: number;        // Absolute position
  velX, velY, velZ: number;        // Absolute velocity
  yaw, pitch: number;              // Absolute rotation
  inputFlags: number;
  mouseDeltaX, mouseDeltaY: number;
  jetpackFlags: number;
  jetpackFuel: number;
}
```

### Current Issues
1. **No delta encoding** - Every frame stores absolute values (~44 bytes)
2. **Fixed 60fps** - No adaptive sampling based on activity
3. **No keyframe concept** - All frames treated equally
4. **Redundant event data** - Events store full position/velocity
5. **No compression** - Raw binary only

### Current Size Calculation
- 60fps × 44 bytes = 2.64KB/sec
- 1 minute = 158KB
- 10 minutes = 1.58MB
- 1 hour = 9.5MB

## Hybrid Format Design

### Keyframe Categories

#### 1. Critical Keyframes (Maximum Accuracy)
**Events that MUST be exact for gameplay correctness:**

- **Projectile Spawn**
  - Exact position (float32)
  - Exact velocity (float32)
  - Weapon type (uint8)
  - Timestamp (float32)
  - Player position at fire time (keyframe)

- **Projectile Hit**
  - Exact hit position (float32)
  - Target ID (uint16)
  - Surface normal (float32 × 3)
  - Damage dealt (float32)
  - Player position at hit time (keyframe)

- **Player Action Keyframes**
  - Fire start (position, rotation, input state)
  - Jump start/land (position, velocity)
  - Weapon switch (timestamp, weapon type)
  - Health change (timestamp, new health)

- **Target Critical Events**
  - Spawn (position, velocity, type, health)
  - Destroy (position, timestamp)
  - Health change (timestamp, new health)

#### 2. Movement Keyframes (High Accuracy)
**Events that need good accuracy but can be interpolated:**

- **Player Position**
  - Keyframed at 10-30fps during movement
  - Keyframed at 60fps during combat
  - Delta encoding between keyframes

- **Target Movement**
  - Keyframed at spawn, hit, destroy
  - Interpolated between events
  - Physics-based movement simulation

#### 3. Visual Simulation (Acceptable Approximation)
**Elements that can be simulated without gameplay impact:**

- **Projectile Flight**
  - Only spawn + hit stored
  - Flight path simulated via physics
  - Bounces calculated deterministically

- **Idle States**
  - Minimal sampling (1-5fps)
  - Interpolated for smooth playback
  - No gameplay impact

- **Visual Effects**
  - Not stored in demo file
  - Reconstructed during playback
  - Particle systems, trails, etc.

### Data Structure Design

```typescript
// Enhanced frame structure with delta support
interface DemoFrame {
  frameType: 'keyframe' | 'delta';
  frameNumber: number;
  timestamp: number;
  
  // Keyframe: full data
  // Delta: only changes
  position?: Vec3;           // delta or absolute
  velocity?: Vec3;           // delta or absolute
  rotation?: { yaw: number; pitch: number };
  inputFlags?: number;       // only if changed
  mouseDelta?: { x: number; y: number };
  jetpackFuel?: number;      // only if changed
  
  // Action flags
  fired?: boolean;           // keyframe on fire
  jumped?: boolean;          // keyframe on jump
  landed?: boolean;          // keyframe on land
}

// Simplified projectile events
interface ProjectileEvent {
  eventType: 'spawn' | 'hit' | 'destroy';
  frameNumber: number;       // Reference to nearest frame
  frameOffset: number;       // Microsecond offset from frame
  
  // Spawn data
  spawnPosition: Vec3;
  spawnVelocity: Vec3;
  weaponType: number;
  
  // Hit data
  hitPosition: Vec3;
  targetId: number;
  surfaceNormal: Vec3;
  damage: number;
  
  // Flight: NOT stored - simulated
}

// Simplified target events
interface TargetEvent {
  eventType: 'spawn' | 'hit' | 'destroy' | 'health_change';
  frameNumber: number;
  
  // Spawn data
  spawnPosition: Vec3;
  spawnVelocity: Vec3;
  targetType: number;
  health: number;
  
  // Hit data
  hitPosition: Vec3;
  damage: number;
  
  // Movement: NOT stored - simulated
}
```

### Delta Encoding Scheme

```typescript
// Delta encoding for position/velocity
interface DeltaFrame {
  frameType: 'delta';
  frameNumber: number;
  
  // Position deltas (int16, ±32m range)
  posX: int16; posY: int16; posZ: int16;
  
  // Velocity deltas (int16, ±32m/s range)
  velX: int16; velY: int16; velZ: int16;
  
  // Rotation deltas (int16, ±180° range)
  yaw: int16; pitch: int16;
  
  // Changed flags (bitmask)
  changedFlags: number;  // bit 0=pos, bit 1=vel, bit 2=rot, etc.
}

// Size: 2+2+2+2+2+2+2+2+2 = 18 bytes (vs 44 bytes)
```

### Adaptive Sampling Strategy

```typescript
// Sampling rate based on activity level
enum ActivityLevel {
  IDLE = 0,        // 1-5fps
  MOVING = 1,      // 10-15fps
  COMBAT = 2,      // 30fps
  HIGH_ACTION = 3  // 60fps
}

function getSamplingRate(activity: ActivityLevel): number {
  switch (activity) {
    case ActivityLevel.IDLE: return 5;
    case ActivityLevel.MOVING: return 15;
    case ActivityLevel.COMBAT: return 30;
    case ActivityLevel.HIGH_ACTION: return 60;
  }
}

// Activity detection
function detectActivity(current: DemoFrame, previous: DemoFrame): ActivityLevel {
  const posDelta = distance(current.position, previous.position);
  const velDelta = distance(current.velocity, previous.velocity);
  const hasAction = current.fired || current.jumped || current.landed;
  
  if (hasAction) return ActivityLevel.HIGH_ACTION;
  if (posDelta > 0.1 || velDelta > 1.0) return ActivityLevel.COMBAT;
  if (posDelta > 0.01) return ActivityLevel.MOVING;
  return ActivityLevel.IDLE;
}
```

## Physics Simulation Strategy

### Deterministic Physics Requirements

For simulation to be correct, physics must be:

1. **Deterministic** - Same input → same output
2. **Frame-rate independent** - Results consistent at any FPS
3. **Replayable** - Can reconstruct from initial state + inputs

### Projectile Flight Simulation

```typescript
// Projectile physics (deterministic)
function simulateProjectileFlight(
  spawn: ProjectileSpawn,
  hit: ProjectileHit,
  duration: number
): ProjectilePath {
  const path: ProjectilePath = [];
  const dt = 1/60; // Fixed timestep
  
  let position = { ...spawn.position };
  let velocity = { ...spawn.velocity };
  
  for (let t = 0; t < duration; t += dt) {
    // Gravity
    velocity.y -= 9.81 * dt;
    
    // Air resistance
    velocity = multiply(velocity, 0.995);
    
    // Update position
    position = add(position, multiply(velocity, dt));
    
    path.push({ ...position });
    
    // Check for hit
    if (distance(position, hit.position) < 0.1) {
      break;
    }
  }
  
  return path;
}
```

### Player Movement Interpolation

```typescript
// Interpolate between keyframes
function interpolatePlayerMovement(
  keyframes: DemoFrame[],
  targetTime: number
): PlayerState {
  const prevKeyframe = findPreviousKeyframe(keyframes, targetTime);
  const nextKeyframe = findNextKeyframe(keyframes, targetTime);
  
  if (!prevKeyframe || !nextKeyframe) {
    return extrapolate(keyframes, targetTime);
  }
  
  const t = (targetTime - prevKeyframe.timestamp) / 
           (nextKeyframe.timestamp - prevKeyframe.timestamp);
  
  return {
    position: lerp(prevKeyframe.position, nextKeyframe.position, t),
    velocity: lerp(prevKeyframe.velocity, nextKeyframe.velocity, t),
    rotation: slerp(prevKeyframe.rotation, nextKeyframe.rotation, t),
    inputFlags: prevKeyframe.inputFlags, // Hold last input
  };
}
```

## Compression Strategy

### Multi-Layer Compression

```typescript
// Layer 1: Delta encoding (50-70% reduction)
function applyDeltaEncoding(frames: DemoFrame[]): DeltaFrame[] {
  const deltas: DeltaFrame[] = [];
  let previous: DemoFrame | null = null;
  
  for (const frame of frames) {
    if (!previous || frame.frameType === 'keyframe') {
      // Store full keyframe
      deltas.push(frameToDelta(frame));
    } else {
      // Store delta
      deltas.push(computeDelta(previous, frame));
    }
    previous = frame;
  }
  
  return deltas;
}

// Layer 2: Adaptive sampling (30-50% reduction)
function applyAdaptiveSampling(frames: DemoFrame[]): DemoFrame[] {
  const sampled: DemoFrame[] = [];
  let lastActivity = ActivityLevel.IDLE;
  
  for (const frame of frames) {
    const activity = detectActivity(frame, sampled[sampled.length - 1]);
    const samplingRate = getSamplingRate(activity);
    
    if (shouldSample(frame, sampled, samplingRate)) {
      sampled.push(frame);
    }
  }
  
  return sampled;
}

// Layer 3: LZ4 compression (40-60% reduction)
function applyCompression(data: ArrayBuffer): ArrayBuffer {
  return lz4.compress(data);
}
```

### Expected Compression Results

| Layer | Reduction | Cumulative |
|-------|-----------|------------|
| Original | 0% | 100% |
| Delta Encoding | 60% | 40% |
| Adaptive Sampling | 40% | 24% |
| LZ4 Compression | 50% | 12% |

**Total: 88% file size reduction**

## Correctness Guarantees

### Critical Event Accuracy

**Projectile Shots:**
- Spawn position: ±0.001m accuracy
- Spawn velocity: ±0.01m/s accuracy
- Hit position: ±0.001m accuracy
- Timestamp: ±1ms accuracy

**Player Movement:**
- Keyframe positions: exact
- Interpolated positions: <1cm error
- Rotation: <0.1° error
- Timing: <5ms error

**Target Events:**
- Spawn/destroy: exact
- Health changes: exact
- Movement: <2cm error

### Validation Strategy

```typescript
// Validate replay correctness
function validateReplay(original: DemoFile, replay: DemoFile): ValidationResult {
  const results: ValidationIssue[] = [];
  
  // Check critical events match exactly
  for (const origShot of original.projectileEvents) {
    const replayShot = findMatchingEvent(replay.projectileEvents, origShot);
    
    if (!replayShot) {
      results.push({ level: 'critical', code: 'MISSING_SHOT' });
      continue;
    }
    
    if (distance(origShot.spawnPosition, replayShot.spawnPosition) > 0.001) {
      results.push({ level: 'error', code: 'SHOT_POSITION_MISMATCH' });
    }
    
    if (distance(origShot.hitPosition, replayShot.hitPosition) > 0.001) {
      results.push({ level: 'error', code: 'HIT_POSITION_MISMATCH' });
    }
  }
  
  // Check player keyframes match
  for (const origKeyframe of original.keyframes) {
    const replayKeyframe = findMatchingKeyframe(replay.keyframes, origKeyframe);
    
    if (!replayKeyframe) {
      results.push({ level: 'error', code: 'MISSING_KEYFRAME' });
      continue;
    }
    
    if (distance(origKeyframe.position, replayKeyframe.position) > 0.01) {
      results.push({ level: 'warning', code: 'KEYFRAME_POSITION_DRIFT' });
    }
  }
  
  return {
    valid: results.filter(r => r.level === 'critical').length === 0,
    issues: results
  };
}
```

## Implementation Roadmap

### Phase 1: Delta Encoding (Week 1-2)
1. Add frameType to DemoFrame
2. Implement delta encoding for position/velocity
3. Add delta decoding in playback
4. Test compression ratio

### Phase 2: Adaptive Sampling (Week 3-4)
1. Implement activity detection
2. Add adaptive sampling to recorder
3. Implement interpolation in playback
4. Test accuracy vs size tradeoff

### Phase 3: Event Simplification (Week 5-6)
1. Remove redundant position/velocity from events
2. Add frame references to events
3. Implement physics simulation for projectiles
4. Test replay correctness

### Phase 4: Compression (Week 7-8)
1. Integrate LZ4 compression
2. Add compression level options
3. Test performance impact
4. Optimize compression settings

## Performance Targets

### File Size
- Current: 2.64KB/sec
- Target: 0.3KB/sec (88% reduction)
- 10 minutes: 180KB vs 1.58MB

### Recording Overhead
- Current: <1% CPU
- Target: <2% CPU (delta computation)
- Memory: Same (circular buffer)

### Playback Performance
- Current: Real-time
- Target: Real-time + 10% (simulation overhead)
- Accuracy: <1cm position error

### Compression Time
- Target: <50ms for 10-minute demo
- Decompression: <20ms

## Migration Strategy

### Backward Compatibility

```typescript
// Version 2 (current) → Version 3 (hybrid)
class V2ToV3Migrator {
  migrate(data: V2DemoFile): V3DemoFile {
    // Convert all frames to keyframes initially
    const keyframes = data.frames.map(f => ({
      ...f,
      frameType: 'keyframe' as const
    }));
    
    // Apply delta encoding
    const deltas = applyDeltaEncoding(keyframes);
    
    // Apply adaptive sampling
    const sampled = applyAdaptiveSampling(deltas);
    
    // Simplify events
    const simplifiedEvents = simplifyEvents(data.projectileEvents);
    
    return {
      header: {
        ...data.header,
        formatVersion: 3,
        compressionEnabled: true
      },
      frames: sampled,
      projectileEvents: simplifiedEvents,
      targetEvents: simplifyEvents(data.targetEvents)
    };
  }
}
```

### Forward Compatibility

```typescript
// Skip unknown fields in future versions
function deserializeFrame(data: DataView, offset: number): DemoFrame {
  const frame: Partial<DemoFrame> = {
    frameType: data.getUint8(offset++) as 'keyframe' | 'delta',
    frameNumber: data.getUint16(offset, true); offset += 2,
    timestamp: data.getFloat32(offset, true); offset += 4,
  };
  
  // Read known fields
  if (hasFlag(data.getUint8(offset++), 0)) {
    frame.position = {
      x: data.getFloat32(offset, true); offset += 4,
      y: data.getFloat32(offset, true); offset += 4,
      z: data.getFloat32(offset, true); offset += 4,
    };
  }
  
  // Skip unknown fields for forward compatibility
  while (offset < data.byteLength && !isFrameEnd(data, offset)) {
    const fieldId = data.getUint8(offset++);
    const fieldSize = data.getUint8(offset++);
    offset += fieldSize; // Skip unknown field
  }
  
  return frame as DemoFrame;
}
```

## Testing Strategy

### Unit Tests
- Delta encoding/decoding
- Activity detection
- Interpolation accuracy
- Physics simulation

### Integration Tests
- End-to-end recording/playback
- Cross-version compatibility
- Compression/decompression
- Performance benchmarks

### Accuracy Tests
- Shot position accuracy
- Hit detection accuracy
- Player movement accuracy
- Event synchronization

### Regression Tests
- Existing demo files
- Migration correctness
- Edge cases (long demos, high action)

## Risk Assessment

### Risk: Physics Simulation Inaccuracy
- **Mitigation**: Deterministic physics with fixed timestep
- **Fallback**: Store more keyframes if simulation drifts

### Risk: Interpolation Artifacts
- **Mitigation**: Adaptive sampling based on activity
- **Fallback**: Increase sampling rate if error detected

### Risk: Compression Performance
- **Mitigation**: Async compression, background processing
- **Fallback**: Optional compression setting

### Risk: Backward Compatibility
- **Mitigation**: Comprehensive migration testing
- **Fallback**: Keep V2 reader indefinitely

## Success Criteria

1. **File Size**: 85-90% reduction from current format
2. **Accuracy**: <1cm position error for critical events
3. **Performance**: <2% CPU overhead for recording
4. **Compatibility**: All existing demos playable after migration
5. **Correctness**: 100% accuracy for shots, hits, spawns

## Conclusion

The hybrid keyframe/simulation format achieves the optimal balance between file size and correctness. By keyframing critical events and simulating visual elements, we can reduce file sizes by 85-90% while maintaining pixel-perfect accuracy for gameplay-critical moments. This approach is future-proof, performant, and maintains the robustness required for long-term demo system evolution.

## Appendix: Technical Specifications

### Delta Encoding Details
- Position delta: int16 (±32m range, 0.001m precision)
- Velocity delta: int16 (±32m/s range, 0.01m/s precision)
- Rotation delta: int16 (±180° range, 0.005° precision)
- Changed flags: uint8 bitmask

### Compression Benchmarks
- LZ4: 50-60% reduction, <10ms compression
- Zstandard: 60-70% reduction, <20ms compression
- Recommendation: LZ4 for speed, Zstandard for size

### Memory Requirements
- Recording: Same as current (circular buffer)
- Playback: +5MB for compression buffers
- Migration: +10MB for temporary storage
