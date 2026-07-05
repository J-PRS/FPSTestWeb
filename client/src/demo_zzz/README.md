# Demo Recording and Replay System

A robust, backwards-compatible demo system for recording and replaying gameplay in TypeScript/JavaScript web applications.

## Features

- **Hybrid Event-Driven Recording**: Continuous frame recording + sparse keyframe events
- **Interface-Based Integration**: Minimal coupling to game systems
- **Circular Buffer**: Efficient continuous recording (~30 seconds at 60 FPS)
- **Binary Serialization**: ~70% smaller file size than JSON
- **Version-Aware Migration**: Backwards compatible with automatic schema evolution
- **Keyframe Interpolation**: Linear, parabolic, and spline interpolation for smooth replay
- **Ghost Object System**: Visualization during replay
- **Cool Hit Detection**: Automatic highlight clip extraction
- **CRC32 Checksums**: File integrity verification
- **IndexedDB Storage**: Browser-native file management

## Architecture

```
demo/
├── core/              # Recording engine
│   ├── CircularBuffer.ts
│   └── DemoRecorder.ts
├── types/             # Data structures
│   ├── DemoFrame.ts
│   ├── ProjectileEvent.ts
│   ├── TargetEvent.ts
│   ├── DemoHeader.ts
│   ├── DemoFile.ts
│   └── DemoClip.ts
├── interfaces/        # Integration interfaces
│   ├── IPlayerDataProvider.ts
│   ├── IInputProvider.ts
│   ├── IProjectileEventSource.ts
│   └── ITargetEventSource.ts
├── serialization/     # Binary encoding & versioning
│   ├── DemoSerializer.ts
│   ├── CRC32.ts
│   ├── DemoValidator.ts
│   ├── SchemaRegistry.ts
│   └── VersionManager.ts
├── playback/          # Replay system
│   ├── Interpolator.ts
│   ├── GhostManager.ts
│   └── DemoPlayer.ts
├── management/        # File operations & cool hits
│   ├── DemoManager.ts
│   └── CoolHitDetector.ts
├── migrations/        # Version migrations
│   └── MigrationV1.ts
└── config.ts          # Configuration constants
```

## Quick Start

### 1. Implement Interfaces

```typescript
import { IPlayerDataProvider, IInputProvider } from './demo/index.js';

class Player implements IPlayerDataProvider {
  get position() { return this.mesh.position; }
  get velocity() { return this.velocity; }
  get rotation() { return this.mesh.quaternion; }
}

class InputHandler implements IInputProvider {
  get inputFlags() { return this.inputFlags; }
  get mouseDeltaX() { return this.mouseDeltaX; }
  get mouseDeltaY() { return this.mouseDeltaY; }
  get jetpackFlags() { return this.jetpackFlags; }
  get jetpackFuel() { return this.jetpackFuel; }
}
```

### 2. Initialize Recorder

```typescript
import { DemoRecorder } from './demo/index.js';

const demoRecorder = new DemoRecorder();
demoRecorder.initialize(player, inputHandler);
```

### 3. Update Every Frame

```typescript
function gameLoop(deltaTime: number) {
  demoRecorder.update(deltaTime);
  // ... other game logic
}
```

### 4. Record Events

```typescript
// Projectile fired
demoRecorder.recordProjectileFired(position, velocity, weaponType);

// Projectile bounced
demoRecorder.recordProjectileBounce(projectileId, position, velocity, normal);

// Projectile hit
demoRecorder.recordProjectileHit(projectileId, position, targetId);
```

### 5. Extract Demo

```typescript
const demoFile = demoRecorder.extractDemoFile();
await demoManager.saveDemo(demoFile, 'my_cool_shot.demo');
```

### 6. Playback

```typescript
import { DemoPlayer } from './demo/index.js';

const demoPlayer = new DemoPlayer(scene, camera);
const demoFile = await demoManager.loadDemo('my_cool_shot.demo');
demoPlayer.loadDemo(demoFile);
demoPlayer.play();

function gameLoop(deltaTime: number) {
  demoPlayer.update(deltaTime);
  // ... other game logic
}
```

## Configuration

All configuration is centralized in `config.ts`:

```typescript
import { DEMO_CONFIG } from './demo/config.js';

// Customize recording
DEMO_CONFIG.RECORDING.BUFFER_DURATION = 60; // 60 seconds
DEMO_CONFIG.RECORDING.RECORDING_TICK_RATE = 30; // 30 Hz

// Customize cool hit detection
DEMO_CONFIG.COOL_HIT.LONG_RANGE_DISTANCE = 150; // meters
DEMO_CONFIG.COOL_HIT.MIN_BOUNCES_FOR_COOL = 3;
```

## Data Sizes

- **DemoFrame**: ~32 bytes per frame
- **ProjectileEvent**: ~48 bytes per event
- **TargetEvent**: ~40 bytes per event
- **30-second clip**: ~10 KB
- **5-minute demo**: ~100 KB

## Backwards Compatibility

The system uses version-aware migration:

1. Each demo file has a `formatVersion` in the header
2. `SchemaRegistry` defines supported versions
3. `VersionManager` automatically migrates old demos to current version
4. Non-breaking changes use `hasFlag` pattern for compatibility

### Adding a New Version

```typescript
// 1. Register new schema
schemaRegistry.registerSchema({
  version: '2.0.0',
  formatVersion: 2,
  minReaderVersion: 1,
  description: 'Added mapName field',
  deprecated: false,
});

// 2. Create migration
const migration = {
  fromVersion: 1,
  toVersion: 2,
  migrate: (demo: DemoFile) => {
    demo.header.mapName = 'Unknown';
    demo.header.formatVersion = 2;
    return demo;
  },
};

// 3. Register migration
versionManager.registerMigration(migration);
```

## Cool Hit Detection

Automatic detection of impressive shots:

```typescript
const coolHitDetector = new CoolHitDetector({
  longRangeDistance: 100,      // meters
  highVelocityThreshold: 50,   // m/s
  minBouncesForCool: 2,         // bounces
  clipBeforeHit: 2,            // seconds
  clipAfterHit: 2,             // seconds
});

// Track bounces
demoRecorder.onProjectileEvent((event) => {
  if (event.eventType === ProjectileEventType.Bounce) {
    coolHitDetector.trackBounce(event.projectileId);
  }
});

// Evaluate hits
demoRecorder.onProjectileEvent((event) => {
  if (event.eventType === ProjectileEventType.Hit) {
    const fireEvent = findFireEvent(event.projectileId);
    coolHitDetector.evaluateHit(event, fireEvent);
  }
});
```

## Interpolation Modes

Three interpolation modes for replay:

- **Linear**: Fast, simple interpolation
- **Parabolic**: Accounts for gravity (best for projectiles)
- **Spline**: Catmull-Rom spline for smooth curves

```typescript
demoPlayer.setInterpolationMode(InterpolationMode.Parabolic);
demoPlayer.setGravity(-20.0);
```

## File Validation

Validate demo files for integrity:

```typescript
import { DemoValidator } from './demo/index.js';

const result = DemoValidator.validate(demoFile);
if (!result.isValid) {
  console.error('Validation errors:', result.errors);
}
console.warn('Validation warnings:', result.warnings);
```

## Performance Targets

- **Recording overhead**: < 5% CPU
- **Playback performance**: > 60 FPS
- **Memory usage**: < 50 MB for 30-second buffer
- **File size**: ~10 KB for 30-second clip

## Browser Compatibility

- Uses IndexedDB for file storage
- Uses Blob API for file download
- Uses DataView for binary encoding
- Requires ES6+ (async/await, classes)

## Security Considerations

- All deserialized data is validated (NaN/Infinity checks)
- CRC32 checksums verify file integrity
- Rate limiting prevents event spam
- Buffer size limits prevent memory exhaustion
- File size limits prevent DoS attacks

## Troubleshooting

### Recording Not Working

- Ensure `IPlayerDataProvider` and `IInputProvider` are implemented
- Call `demoRecorder.initialize()` after game systems are loaded
- Call `demoRecorder.update(deltaTime)` every frame
- Check console for "missing provider" warnings

### Playback Issues

- Ensure demo file format version is supported
- Check if migration is needed (see console logs)
- Verify frame timestamps are monotonic
- Check ghost objects are visible in scene

### File Corruption

- Check CRC32 checksum mismatch warnings
- Validate demo file with `DemoValidator`
- Ensure IndexedDB is not corrupted
- Try re-saving the demo

## License

Part of the VORTEX FPS project.
