# Demo System Integration Examples

This document provides detailed examples for integrating the demo system into your game.

## Basic Integration

### Step 1: Extend Player Class

```typescript
// Player.ts
import * as THREE from 'three';
import { IPlayerDataProvider } from './demo/index.js';

export class Player implements IPlayerDataProvider {
  private mesh: THREE.Object3D;
  private velocity: THREE.Vector3;

  // IPlayerDataProvider implementation
  get position(): THREE.Vector3 {
    return this.mesh.position.clone();
  }

  get velocity(): THREE.Vector3 {
    return this.velocity.clone();
  }

  get rotation(): THREE.Quaternion {
    return this.mesh.quaternion.clone();
  }

  // ... existing Player code
}
```

### Step 2: Extend Input Handler

```typescript
// InputHandler.ts
import { IInputProvider } from './demo/index.js';

export class InputHandler implements IInputProvider {
  private inputFlags: number = 0;
  private mouseDeltaX: number = 0;
  private mouseDeltaY: number = 0;
  private jetpackFlags: number = 0;
  private jetpackFuel: number = 0;

  // IInputProvider implementation
  get inputFlags(): number {
    return this.inputFlags;
  }

  get mouseDeltaX(): number {
    return this.mouseDeltaX;
  }

  get mouseDeltaY(): number {
    return this.mouseDeltaY;
  }

  get jetpackFlags(): number {
    return this.jetpackFlags;
  }

  get jetpackFuel(): number {
    return this.jetpackFuel;
  }

  // ... existing InputHandler code
}
```

### Step 3: Initialize in Main

```typescript
// main.ts
import { DemoRecorder, DemoManager, DemoPlayer } from './demo/index.js';
import { Player } from './Player.js';
import { InputHandler } from './InputHandler.js';

const player = new Player();
const inputHandler = new InputHandler();

// Initialize demo system
const demoRecorder = new DemoRecorder();
const demoManager = new DemoManager();
const demoPlayer = new DemoPlayer(scene, camera);

// Initialize with data providers
demoRecorder.initialize(player, inputHandler);

// Initialize IndexedDB
await demoManager.initialize();

// Game loop
function gameLoop(deltaTime: number) {
  // Update demo recorder
  demoRecorder.update(deltaTime);

  // Update demo player (if playing)
  demoPlayer.update(deltaTime);

  // ... other game logic
}
```

## Projectile Event Recording

### Rocket.ts Integration

```typescript
// Rocket.ts
import { IProjectileEventSource, ProjectileEventType } from './demo/index.js';

export class Rocket implements IProjectileEventSource {
  private demoRecorder: IProjectileEventSource | null = null;

  setDemoRecorder(recorder: IProjectileEventSource): void {
    this.demoRecorder = recorder;
  }

  fire(position: THREE.Vector3, velocity: THREE.Vector3, weaponType: number): void {
    // Record fire event
    this.demoRecorder?.recordProjectileFired(position, velocity, weaponType);

    // ... existing fire logic
  }

  bounce(position: THREE.Vector3, velocity: THREE.Vector3, normal: THREE.Vector3): void {
    // Record bounce event
    this.demoRecorder?.recordProjectileBounce(this.id, position, velocity, normal);

    // ... existing bounce logic
  }

  hit(position: THREE.Vector3, targetId: number): void {
    // Record hit event
    this.demoRecorder?.recordProjectileHit(this.id, position, targetId);

    // ... existing hit logic
  }

  destroy(position: THREE.Vector3): void {
    // Record destroy event
    this.demoRecorder?.recordProjectileDestroyed(this.id, position);

    // ... existing destroy logic
  }
}
```

### Connecting Rocket to DemoRecorder

```typescript
// main.ts
const rocket = new Rocket();
rocket.setDemoRecorder(demoRecorder);
```

## Target Event Recording

### Balls.ts Integration

```typescript
// balls.ts
import { ITargetEventSource, TargetEventType } from './demo/index.js';

export class Ball implements ITargetEventSource {
  private demoRecorder: ITargetEventSource | null = null;

  setDemoRecorder(recorder: ITargetEventSource): void {
    this.demoRecorder = recorder;
  }

  spawn(position: THREE.Vector3, velocity: THREE.Vector3, type: number): void {
    // Record spawn event
    this.demoRecorder?.recordTargetSpawned(this.id, position, velocity, type);

    // ... existing spawn logic
  }

  bounce(position: THREE.Vector3, velocity: THREE.Vector3): void {
    // Record bounce event
    this.demoRecorder?.recordTargetBounce(this.id, position, velocity);

    // ... existing bounce logic
  }

  hit(position: THREE.Vector3, health: number): void {
    // Record hit event
    this.demoRecorder?.recordTargetHit(this.id, position, health);

    // ... existing hit logic
  }

  destroy(position: THREE.Vector3): void {
    // Record destroy event
    this.demoRecorder?.recordTargetDestroyed(this.id, position);

    // ... existing destroy logic
  }
}
```

## Saving and Loading Demos

### Save Current Recording

```typescript
// UI button handler
async function onSaveDemoClick() {
  const demoFile = demoRecorder.extractDemoFile();
  const name = `demo_${Date.now()}`;
  await demoManager.saveDemo(demoFile, name);
  console.log('Demo saved:', name);
}
```

### Load and Play Demo

```typescript
// Demo browser UI
async function onPlayDemoClick(demoId: string) {
  const demoFile = await demoManager.loadDemo(demoId);
  demoPlayer.loadDemo(demoFile);
  demoPlayer.play();
}
```

### Download Demo File

```typescript
import { DemoSerializer } from './demo/index.js';

async function onDownloadDemoClick(demoId: string) {
  const demoFile = await demoManager.loadDemo(demoId);
  const filename = `${demoId}.demo`;
  await DemoSerializer.saveToFile(demoFile, filename);
}
```

## Cool Hit Detection

### Setup Cool Hit Detector

```typescript
import { CoolHitDetector, ProjectileEventType } from './demo/index.js';

const coolHitDetector = new CoolHitDetector({
  longRangeDistance: 100,
  highVelocityThreshold: 50,
  minBouncesForCool: 2,
  clipBeforeHit: 2,
  clipAfterHit: 2,
});

// Track projectile events
demoRecorder.onProjectileEvent((event) => {
  if (event.eventType === ProjectileEventType.Bounce) {
    coolHitDetector.trackBounce(event.projectileId);
  }
});

// Extract cool hit clips
demoRecorder.onCoolHitDetected((clip) => {
  console.log('Cool hit detected:', clip.description);
  // Automatically save clip
  const demoFile = demoRecorder.extractClipAsDemoFile(clip);
  await demoManager.saveDemo(demoFile, `cool_hit_${Date.now()}`);
});
```

## UI Integration

### Simple Recording Controls

```typescript
// hud.ts
import { RecordingMode } from './demo/index.js';

class HUD {
  private recordingIndicator: HTMLElement;
  private recordingTime: HTMLElement;

  updateRecordingStatus() {
    if (demoRecorder.getIsRecording()) {
      this.recordingIndicator.style.display = 'block';
      this.recordingTime.textContent = `${demoRecorder.getRecordingTime().toFixed(1)}s`;
    } else {
      this.recordingIndicator.style.display = 'none';
    }
  }
}
```

### Playback Controls

```typescript
// hud.ts
class HUD {
  private playbackControls: HTMLElement;
  private progressSlider: HTMLInputElement;

  updatePlaybackStatus() {
    const state = demoPlayer.getPlaybackState();
    const progress = demoPlayer.getProgress();

    this.progressSlider.value = (progress * 100).toString();

    if (state === PlaybackState.Playing) {
      this.playbackControls.style.display = 'block';
    } else {
      this.playbackControls.style.display = 'none';
    }
  }

  onSeek(value: number) {
    const time = (value / 100) * demoPlayer.getDuration();
    demoPlayer.seek(time);
  }
}
```

## Advanced Configuration

### Custom Recording Settings

```typescript
demoRecorder.setBufferDuration(60); // 60 seconds
demoRecorder.setRecordingMode(RecordingMode.FixedTimestep);
demoRecorder.setRecordingTickRate(30); // 30 Hz
demoRecorder.setRecordInputs(true);
demoRecorder.setMaxEventsPerSecond(500);
```

### Custom Playback Settings

```typescript
demoPlayer.setPlaybackSpeed(0.5); // Slow motion
demoPlayer.setLoopPlayback(true);
demoPlayer.setInterpolationMode(InterpolationMode.Spline);
demoPlayer.setGravity(-15.0);
```

### Custom Cool Hit Settings

```typescript
coolHitDetector.updateConfig({
  longRangeDistance: 150,
  highVelocityThreshold: 75,
  minBouncesForCool: 3,
  clipBeforeHit: 3,
  clipAfterHit: 3,
});
```

## Error Handling

### Handle Recording Errors

```typescript
try {
  demoRecorder.initialize(player, inputHandler);
} catch (error) {
  console.error('Failed to initialize demo recorder:', error);
  // Fallback: disable demo recording
}
```

### Handle File Errors

```typescript
try {
  const demoFile = await demoManager.loadDemo(demoId);
} catch (error) {
  console.error('Failed to load demo:', error);
  // Show error to user
}
```

### Handle Validation Errors

```typescript
import { DemoValidator } from './demo/index.js';

const result = DemoValidator.validate(demoFile);
if (!result.isValid) {
  console.error('Demo validation failed:', result.errors);
  // Show error to user
  return;
}

if (result.warnings.length > 0) {
  console.warn('Demo validation warnings:', result.warnings);
  // Show warnings to user
}
```

## Performance Optimization

### Disable Recording When Not Needed

```typescript
// Only record when in game mode
if (gameState === 'playing') {
  demoRecorder.update(deltaTime);
}
```

### Reduce Recording Overhead

```typescript
// Don't record inputs if not needed
demoRecorder.setRecordInputs(false);

// Reduce tick rate
demoRecorder.setRecordingTickRate(30); // 30 Hz instead of 60 Hz

// Shorter buffer
demoRecorder.setBufferDuration(15); // 15 seconds instead of 30
```

### Lazy Loading Demos

```typescript
// Only load demo when user clicks play
async function onDemoSelected(demoId: string) {
  // Load metadata only
  const demoInfo = demoManager.getDemoInfo(demoId);
  // Don't load full demo until play is clicked
}
```

## Testing

### Unit Test Example

```typescript
import { CircularBuffer } from './demo/index.js';

describe('CircularBuffer', () => {
  it('should add and retrieve items', () => {
    const buffer = new CircularBuffer<number>(5);
    buffer.add(1);
    buffer.add(2);
    expect(buffer.get(0)).toBe(1);
    expect(buffer.get(1)).toBe(2);
  });

  it('should overwrite when full', () => {
    const buffer = new CircularBuffer<number>(3);
    buffer.add(1);
    buffer.add(2);
    buffer.add(3);
    buffer.add(4); // Overwrites 1
    expect(buffer.getCount()).toBe(3);
    expect(buffer.get(0)).toBe(2);
  });
});
```

### Integration Test Example

```typescript
describe('DemoRecorder Integration', () => {
  it('should record and extract demo', () => {
    const recorder = new DemoRecorder();
    const mockPlayer = createMockPlayer();
    const mockInput = createMockInput();

    recorder.initialize(mockPlayer, mockInput);
    recorder.startRecording();

    // Simulate 1 second of gameplay
    for (let i = 0; i < 60; i++) {
      recorder.update(1/60);
    }

    const demoFile = recorder.extractDemoFile();
    expect(demoFile.frames.length).toBeGreaterThan(0);
    expect(demoFile.header.duration).toBeGreaterThan(0);
  });
});
```
