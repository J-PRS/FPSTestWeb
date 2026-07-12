---
title: "Demo System Implementation Plan"
category: "implementation"
status: "active"
date: "2026-06-28"
version: "1.0"
related: ["../_DEMO/docs/INTEGRATION.md", "../_DEMO/docs/_doc.md"]
tags: ["demo", "recording", "replay", "backwards-compatibility", "versioning"]
---

# Demo System Implementation Plan

## Executive Summary

This plan details the implementation of an elastic, efficient, backwards-compatible demo recording and replay system for the VORTEX FPS game. The system is based on the existing Unity C# demo code in `_DEMO/`, adapted for the TypeScript/Node.js web architecture.

**Time Estimate:** 2-4 weeks for production-ready system
**Approach:** Leverage existing 70% complete code, add version migration and interpolation logic
**Key Goals:** Minimal coupling, zero overhead when disabled, automatic compatibility

## Background

The existing `_DEMO` directory contains a well-designed Unity C# demo recording system with:
- Hybrid event-driven recording (continuous frames + sparse keyframes)
- Interface-based integration for minimal coupling
- Circular buffer for recent gameplay (~30 seconds)
- Cool hit detection for automatic clip extraction
- Binary serialization for efficient file I/O

**Gap Analysis:**
- Missing version migration layer for backwards compatibility
- Missing interpolation logic for keyframe replay
- Needs adaptation from Unity C# to TypeScript/Node.js
- Needs integration with existing WebSocket networking

## Architecture Overview

### Design Principles

1. **Elastic:** Configurable buffer sizes, tick rates, and event limits
2. **Efficient:** Binary protocol, delta compression, sparse keyframe recording
3. **Backwards Compatible:** Version-aware serializer, migration pipeline, schema evolution
4. **Non-Blocking:** Zero overhead when disabled, minimal overhead when active
5. **Interface-Based:** Minimal coupling to game systems

### System Components

```
Demo Recording System
├── Core Recording
│   ├── DemoRecorder (main recording engine)
│   ├── CircularBuffer (frame storage)
│   └── EventTracker (projectile/target events)
├── Serialization
│   ├── DemoSerializer (binary encoding/decoding)
│   ├── VersionManager (schema migration)
│   └── SchemaRegistry (version definitions)
├── Playback
│   ├── DemoPlayer (replay engine)
│   ├── Interpolator (keyframe interpolation)
│   └── GhostManager (replay objects)
├── Management
│   ├── DemoManager (file operations)
│   ├── CoolHitDetector (clip extraction)
│   └── DemoUI (playback controls)
└── Integration
    ├── IPlayerDataProvider (player state interface)
    ├── IInputProvider (input state interface)
    ├── IProjectileEventSource (projectile events)
    └── ITargetEventSource (target events)
```

## Implementation Phases

### Phase 1: Core Architecture (3-5 days)

**Objective:** Design versioning strategy and extensible event system

**Tasks:**

1. **Version Management System**
   - Define version schema (major.minor.patch)
   - Create `SchemaRegistry` for version definitions
   - Implement `VersionManager` for migration pipeline
   - Add migration chain logic (v1 → v2 → v3)

2. **Extensible Event System**
   - Design event payload structure with version field
   - Implement event type registry
   - Add event validation layer
   - Create event factory for deserialization

3. **Binary Format Design**
   - Define file header structure
   - Design chunk-based storage (header, frames, events, metadata)
   - Add CRC32 checksums for integrity
   - Implement compression layer (optional)

**Deliverables:**
- `src/demo/VersionManager.ts`
- `src/demo/SchemaRegistry.ts`
- `src/demo/events/EventFactory.ts`
- Binary format specification document

**Success Criteria:**
- Version migration pipeline functional
- Event system extensible without breaking changes
- Binary format supports future additions

### Phase 2: Recording Engine (5-7 days)

**Objective:** Implement continuous frame recording and sparse keyframe system

**Tasks:**

1. **Circular Buffer Implementation**
   - Port `CircularBuffer<T>` from C# to TypeScript
   - Add timestamp-based extraction
   - Implement range extraction for clips
   - Add buffer overflow protection

2. **Frame Recording**
   - Implement `DemoRecorder` class
   - Add player state capture (position, velocity, rotation)
   - Add input state capture (flags, mouse delta, jetpack)
   - Implement configurable tick rate (variable/fixed)

3. **Keyframe Event Recording**
   - Implement projectile event tracking (fire, bounce, hit, destroy)
   - Implement target event tracking (spawn, bounce, hit, destroy, state change)
   - Add event rate limiting (max events/sec, max total)
   - Implement peak position recording (optional precision)

4. **Integration Hooks**
   - Implement `IPlayerDataProvider` interface
   - Implement `IInputProvider` interface
   - Add event source interfaces for projectiles/targets
   - Create adapter for existing game systems

**Deliverables:**
- `src/demo/CircularBuffer.ts`
- `src/demo/DemoRecorder.ts`
- `src/demo/interfaces/IPlayerDataProvider.ts`
- `src/demo/interfaces/IInputProvider.ts`
- `src/demo/interfaces/IProjectileEventSource.ts`
- `src/demo/interfaces/ITargetEventSource.ts`

**Success Criteria:**
- Circular buffer stores 30 seconds at 60 FPS
- Event rate limiting prevents spam
- Integration with existing game systems functional
- Zero overhead when recording disabled

### Phase 3: Serialization & Compatibility (3-4 days)

**Objective:** Implement version-aware serializer with migration layer

**Tasks:**

1. **Binary Serializer**
   - Port `DemoSerializer` from C# to TypeScript
   - Implement binary encoding for all data types
   - Add header writing/reading
   - Implement frame/event serialization

2. **Version Migration**
   - Create migration functions for each version
   - Implement automatic migration on load
   - Add fallback for unknown versions
   - Implement migration testing utilities

3. **Schema Evolution**
   - Define non-breaking change patterns (optional fields, hasFlag)
   - Implement field addition strategy
   - Add field deprecation warnings
   - Document version compatibility matrix

4. **File Management**
   - Implement demo file naming (timestamp-based)
   - Add file validation (checksum, format version)
   - Create file metadata cache
   - Implement file cleanup policies

**Deliverables:**
- `src/demo/DemoSerializer.ts`
- `src/demo/migrations/MigrationV1.ts`
- `src/demo/migrations/MigrationV2.ts`
- Version compatibility matrix document

**Success Criteria:**
- v1 demos load in v2 system with migration
- v2 demos load in v1 system with graceful degradation
- File validation rejects corrupted files
- Migration pipeline handles all historical versions

### Phase 4: Playback Engine (4-5 days)

**Objective:** Implement interpolation and ghost object system

**Tasks:**

1. **Keyframe Interpolation**
   - Implement linear interpolation for position
   - Implement parabolic interpolation for gravity-affected objects
   - Add spline interpolation for smooth curves
   - Implement extrapolation for high-latency scenarios

2. **Ghost Object System**
   - Create ghost object factory
   - Implement ghost state management
   - Add ghost pooling for performance
   - Implement ghost cleanup

3. **Replay Engine**
   - Port `DemoPlayer` from C# to TypeScript
   - Implement playback controls (play, pause, stop, seek)
   - Add playback speed adjustment
   - Implement loop playback

4. **Free Camera**
   - Implement free camera controls
   - Add camera smoothing
   - Implement camera following (optional)
   - Add camera preset positions

**Deliverables:**
- `src/demo/Interpolator.ts`
- `src/demo/GhostManager.ts`
- `src/demo/DemoPlayer.ts`
- `src/demo/FreeCamera.ts`

**Success Criteria:**
- Interpolation produces smooth motion
- Ghost objects render correctly
- Playback controls responsive
- Free camera navigable

### Phase 5: Management & UI (3-4 days)

**Objective:** Implement file management and playback controls

**Tasks:**

1. **Demo Manager**
   - Port `DemoManager` from C# to TypeScript
   - Implement demo file browser
   - Add demo metadata caching
   - Implement auto-cleanup policies

2. **Cool Hit Detection**
   - Port `CoolHitDetector` from C# to TypeScript
   - Implement hit evaluation criteria
   - Add clip extraction logic
   - Implement clip description generation

3. **UI System**
   - Port `DemoUI` from C# to TypeScript
   - Adapt from UIToolkit to HTML/CSS (web-native)
   - Implement recording controls
   - Add playback controls
   - Implement demo browser UI

4. **Integration with Game UI**
   - Add demo controls to existing HUD
   - Implement keyboard shortcuts
   - Add demo overlay during playback
   - Implement demo indicator during recording

**Deliverables:**
- `src/demo/DemoManager.ts`
- `src/demo/CoolHitDetector.ts`
- `src/demo/DemoUI.ts`
- HTML/CSS UI components

**Success Criteria:**
- Demo browser functional
- Cool hit detection extracts clips
- UI controls responsive
- Keyboard shortcuts work

### Phase 6: Integration & Testing (3-5 days)

**Objective:** Integrate with game systems and test thoroughly

**Tasks:**

1. **Game System Integration**
   - Implement `IPlayerDataProvider` on Player.ts
   - Implement `IInputProvider` on input handler
   - Add projectile event calls to Rocket.ts
   - Add target event calls to balls.ts

2. **Performance Profiling**
   - Measure recording overhead
   - Measure playback performance
   - Profile memory usage
   - Optimize hot paths

3. **Compatibility Testing**
   - Test v1 → v2 migration
   - Test v2 → v1 degradation
   - Test corrupted file handling
   - Test edge cases (empty demos, large demos)

4. **Integration Testing**
   - Test recording during gameplay
   - Test playback with multiple players
   - Test reconnection during recording
   - Test clip extraction

**Deliverables:**
- Integration adapters for game systems
- Performance benchmark report
- Compatibility test results
- Integration test report

**Success Criteria:**
- Recording overhead < 5% CPU
- Playback performance > 60 FPS
- All compatibility tests pass
- Integration tests pass

## Technical Specifications

### Data Structures

**DemoFrame (~32 bytes)**
```typescript
interface DemoFrame {
  frameNumber: number;      // uint16
  timestamp: number;       // float32
  position: Vector3;       // 3 * float32
  velocity: Vector3;       // 3 * float32
  rotation: Quaternion;    // 4 * float32
  inputFlags: number;      // uint8
  mouseDeltaX: number;     // int16
  mouseDeltaY: number;     // int16
  jetpackFlags: number;    // uint8
  jetpackFuel: number;     // float32
}
```

**ProjectileEvent (~48 bytes)**
```typescript
interface ProjectileEvent {
  eventType: ProjectileEventType;  // uint8
  timestamp: number;               // float32
  position: Vector3;               // 3 * float32
  velocity: Vector3;               // 3 * float32
  projectileId: number;            // uint16
  weaponType: number;             // uint8
  surfaceNormal: Vector3;          // 3 * float32
  targetId: number;               // uint16
  hasPeakPosition: boolean;       // uint8
  peakPosition: Vector3;          // 3 * float32 (optional)
}
```

**TargetEvent (~40 bytes)**
```typescript
interface TargetEvent {
  eventType: TargetEventType;      // uint8
  timestamp: number;              // float32
  position: Vector3;              // 3 * float32
  velocity: Vector3;              // 3 * float32
  targetId: number;               // uint16
  targetType: number;             // uint8
  health: number;                 // float32
  hasPeakPosition: boolean;       // uint8
  peakPosition: Vector3;          // 3 * float32 (optional)
}
```

### Binary Format

**File Header (64 bytes)**
```
Magic Number:      1 byte  (0x44 'D')
Format Version:    4 bytes (int32)
Game Version:      variable (string)
Timestamp:         8 bytes (int64)
Description:       variable (string)
Total Frames:      4 bytes (uint32)
Projectile Events: 4 bytes (uint32)
Target Events:     4 bytes (uint32)
Duration:          4 bytes (float32)
Checksum:          4 bytes (uint32)
Player Start Pos: 12 bytes (3 * float32)
Player Start Rot: 16 bytes (4 * float32)
Player Start Vel: 12 bytes (3 * float32)
```

**Frame Data**
```
Frame Count: 2 bytes (uint16)
Frames:      N * 32 bytes
```

**Event Data**
```
Projectile Event Count: 2 bytes (uint16)
Projectile Events:       N * 48 bytes
Target Event Count:      2 bytes (uint16)
Target Events:           N * 40 bytes
```

### Version Migration Strategy

**Non-Breaking Changes:**
- Add new fields with `hasFlag` pattern
- Old readers ignore unknown fields
- New readers provide defaults for missing fields

**Breaking Changes:**
- Increment major version
- Provide migration function
- Support reading old format for N versions

**Migration Pipeline:**
```typescript
interface Migration {
  fromVersion: number;
  toVersion: number;
  migrate(data: DemoFile): DemoFile;
}

class VersionManager {
  private migrations: Migration[] = [];

  migrate(demo: DemoFile, targetVersion: number): DemoFile {
    let current = demo;
    while (current.header.formatVersion < targetVersion) {
      const migration = this.findMigration(current.header.formatVersion);
      current = migration.migrate(current);
    }
    return current;
  }
}
```

### Interpolation Algorithms

**Linear Interpolation:**
```typescript
function lerp(a: Vector3, b: Vector3, t: number): Vector3 {
  return a.clone().lerp(b, t);
}
```

**Parabolic Interpolation (Gravity):**
```typescript
function parabolicInterpolate(
  start: Vector3,
  end: Vector3,
  duration: number,
  t: number,
  gravity: number
): Vector3 {
  const linear = lerp(start, end, t);
  const height = (gravity * duration * duration) / 4;
  const arc = 4 * t * (1 - t);
  linear.y += height * arc;
  return linear;
}
```

**Spline Interpolation (Smooth):**
```typescript
function splineInterpolate(
  points: Vector3[],
  t: number
): Vector3 {
  // Catmull-Rom spline implementation
  // ...
}
```

## Performance Targets

### Recording Performance
- **CPU Overhead:** < 5% when recording
- **Memory Usage:** < 50 MB for 30-second buffer
- **Frame Rate:** No impact on game FPS
- **Event Rate:** < 1000 events/sec

### Playback Performance
- **CPU Usage:** < 10% during playback
- **Memory Usage:** < 100 MB for full demo
- **Frame Rate:** > 60 FPS playback
- **Load Time:** < 1 second for 5-minute demo

### File Size
- **30-Second Clip:** ~10 KB
- **5-Minute Demo:** ~100 KB
- **Full Session (30 min):** ~600 KB

## Security Considerations

### Input Validation
- Validate all deserialized data
- Check for NaN/Infinity in floats
- Validate array bounds
- Reject malformed files

### Resource Limits
- Max buffer size: 100 MB
- Max events per second: 1000
- Max total events: 10,000
- Max demo file size: 10 MB

### File System
- Validate file paths
- Sanitize demo names
- Prevent directory traversal
- Limit disk usage

## Testing Strategy

### Unit Tests
- CircularBuffer operations
- Serialization/deserialization
- Version migrations
- Interpolation algorithms
- Event validation

### Integration Tests
- Recording during gameplay
- Playback with game state
- File save/load
- UI interactions
- Cool hit detection

### Performance Tests
- Recording overhead measurement
- Playback performance profiling
- Memory usage tracking
- File size benchmarking

### Compatibility Tests
- v1 → v2 migration
- v2 → v1 degradation
- Corrupted file handling
- Edge case testing

## Risks & Mitigations

### Risk 1: Performance Impact
**Mitigation:**
- Profile recording overhead
- Optimize hot paths
- Add enable/disable flag
- Use web workers for serialization

### Risk 2: Compatibility Issues
**Mitigation:**
- Comprehensive migration testing
- Version compatibility matrix
- Graceful degradation
- Fallback to JSON if needed

### Risk 3: File Corruption
**Mitigation:**
- CRC32 checksums
- Atomic file writes
- Validation on load
- Backup/restore mechanism

### Risk 4: Integration Complexity
**Mitigation:**
- Interface-based design
- Minimal coupling
- Adapter pattern
- Incremental integration

## Success Criteria

### Functional Requirements
- ✅ Record 30 seconds of gameplay
- ✅ Save/load demo files
- ✅ Playback with interpolation
- ✅ Extract cool hit clips
- ✅ UI controls functional

### Non-Functional Requirements
- ✅ Recording overhead < 5% CPU
- ✅ Playback > 60 FPS
- ✅ Backwards compatible with v1
- ✅ Zero overhead when disabled
- ✅ File size < 1 MB for 5-minute demo

### Integration Requirements
- ✅ Interfaces implemented on game systems
- ✅ No breaking changes to existing code
- ✅ Reconnection works during recording
- ✅ Multiplayer recording functional

## Future Enhancements

### Short Term (Post-MVP)
- Add video export from demos
- Implement demo sharing
- Add demo editing tools
- Implement spectator mode

### Long Term
- Machine learning for cool hit detection
- Cloud demo storage
- Demo analytics
- Community demo browser

## References

### Existing Code
- `_DEMO/docs/INTEGRATION.md` - Integration guide
- `_DEMO/docs/_doc.md` - Design notes
- `_DEMO/DemoRecorder.cs` - Recording engine
- `_DEMO/DemoPlayer.cs` - Playback engine
- `_DEMO/DemoSerializer.cs` - Serialization

### External Resources
- Tribes 2 Networking Model - Data classification principles
- Source Engine Demo System - Interpolation techniques
- Quake 3 Demo Format - Binary format design

## Appendix

### Glossary
- **Circular Buffer:** Fixed-size buffer that overwrites oldest data
- **Keyframe:** Critical moment in time (fire, hit, bounce)
- **Interpolation:** Estimating values between known points
- **Migration:** Converting data from one version to another
- **Ghost Object:** Visual representation during replay
- **Cool Hit:** Impressive shot worthy of clip extraction

### File Structure
```
src/demo/
├── core/
│   ├── CircularBuffer.ts
│   ├── DemoRecorder.ts
│   └── EventTracker.ts
├── serialization/
│   ├── DemoSerializer.ts
│   ├── VersionManager.ts
│   └── SchemaRegistry.ts
├── playback/
│   ├── DemoPlayer.ts
│   ├── Interpolator.ts
│   └── GhostManager.ts
├── management/
│   ├── DemoManager.ts
│   ├── CoolHitDetector.ts
│   └── DemoUI.ts
├── interfaces/
│   ├── IPlayerDataProvider.ts
│   ├── IInputProvider.ts
│   ├── IProjectileEventSource.ts
│   └── ITargetEventSource.ts
├── events/
│   ├── EventFactory.ts
│   ├── ProjectileEvent.ts
│   └── TargetEvent.ts
├── migrations/
│   ├── MigrationV1.ts
│   └── MigrationV2.ts
└── types/
    ├── DemoFrame.ts
    ├── DemoHeader.ts
    └── DemoFile.ts
```
