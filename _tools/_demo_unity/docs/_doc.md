# Demo Recording System - Design Notes

## Overview
Hybrid event-driven demo recording system for Unity 6000, optimized for highlight clip extraction with minimal runtime overhead and small file sizes.

## Recording Strategy

### Continuous Frame Recording (Circular Buffer)
- Duration: ~30 seconds of recent gameplay
- Frame rate: 60 FPS (configurable)
- Purpose: Player state reconstruction
- Data per frame: ~32 bytes
  - frameNumber (ushort)
  - timestamp (float)
  - position (Vector3)
  - velocity (Vector3)
  - rotation (Quaternion)
  - inputFlags (byte bitmask)
  - mouseDeltaX/Y (short)
  - jetpackFlags (byte)
  - jetpackFuel (float)

### Keyframe Event Recording (Sparse)
Records only critical moments for projectiles and targets:

**Projectile Events (~48 bytes each):**
- Fired: Initial position, velocity, weapon type
- Bounce: Position, velocity, surface normal
- Hit: Position, target ID
- Destroyed: Final position

**Target Events (~40 bytes each):**
- Spawned: Initial position, velocity, type
- Bounce: Position, velocity
- Hit: Position, health
- Destroyed: Final position
- StateChanged: State transition

## Replay Approaches Considered

### 1. Full Event Recording (Current Implementation)
- Records all projectile/target events
- Ghost objects positioned at recorded locations
- Zero error at all keyframes
- File size: Moderate (events for every bounce)

### 2. Input-Only Replay (Simulation)
- Records initial state only
- Simulates physics during replay
- Error accumulation: 1-5 meters for long shots
- File size: Minimal
- Verdict: Too inaccurate for highlight clips

### 3. Keyframe Interpolation (Recommended)
- Records start (fire) and end (hit) keyframes
- Interpolates using physics-based curves
- Accounts for gravity, initial velocity
- 100% accurate at fire and hit moments
- Deterministic - no simulation needed
- File size: Minimal (2 keyframes per shot)
- For bank shots: Add bounce keyframes as needed

## Why Interpolation is Optimal

**Advantages:**
- Perfect accuracy at critical moments (fire, hit)
- Deterministic playback (same result every time)
- Minimal data storage (just keyframes)
- Fast replay (simple math, no physics)
- Smooth, natural-looking arcs
- No error accumulation

**Implementation:**
```csharp
// Replay time t (0 to 1)
float t = (currentTime - fireTime) / (hitTime - fireTime);

// Linear interpolation
Vector3 position = Vector3.Lerp(firePos, hitPos, t);

// Add gravity arc (parabolic)
float height = Physics.gravity.magnitude * duration * duration / 4;
position.y += height * 4 * t * (1 - t);
```

## Data Size Estimates

**Circular Buffer (30 seconds @ 60 FPS):**
- 32 bytes/frame × 1800 frames = ~57 KB

**Event Recording (per shot):**
- Direct shot: 2 events (fire + hit) = ~88 bytes
- Bank shot: 3+ events (fire + bounces + hit) = ~130+ bytes

**Typical highlight clip (5 seconds):**
- Frames: 32 × 300 = ~9.6 KB
- Events: ~500 bytes (10-15 shots)
- Total: ~10 KB per clip

## Cool Hit Detection

Automatically detects impressive shots based on:
- Long range (>100m)
- High velocity impact (>50 m/s)
- Prediction accuracy (lead distance)
- Multiple bounces (≥2)
- Moving targets

Triggers automatic clip extraction around the hit event.

## Unity 6000 Compatibility

**APIs Used:**
- UIToolkit (not OnGUI)
- New Input System (not legacy Input)
- Rigidbody.linearVelocity (not velocity)
- FindAnyObjectByType (not FindObjectOfType)
- InputActionMap (not InputActionAsset.AddAction)

## File Storage

**Location:** Application.persistentDataPath/DEMO/
**Structure:**
- Binary serialization for efficiency
- Demo header with metadata
- Compressed frame data
- Sparse event list

## Future Optimizations

1. **Adaptive frame rate** - Lower FPS for slow sections
2. **Delta compression** - Store only changes between frames
3. **Event filtering** - Skip non-critical bounces
4. **Position quantization** - Reduced precision for distant objects
