# Sprunk Engine FPS Game

A TypeScript web game engine designed to be simple and small (50kb minified) but modular and extensible. This project uses Sprunk Engine to build a web-based FPS game.

## Features

- **WebGPU 3D rendering** - Modern GPU-accelerated graphics
- **2D polygon physics engine** - Built-in physics for collisions
- **Audio engine** - 3D positional audio support
- **Input system** - Gamepad, keyboard, and mouse support
- **Dependency injection** - Clean architecture
- **Debugging tools** - Built-in debugging utilities
- **TypeScript throughout** - Full type safety
- **50kb minified** - Small bundle size

## Installation

```bash
npm install sprunk-engine
```

## Browser Requirements

Sprunk Engine requires WebGPU support:
- Chrome 113+
- Edge 113+
- Firefox Nightly (with flags)
- Safari Technology Preview (experimental)

**Note:** WebGPU is not supported in stable Firefox or Safari. For broader compatibility, consider WebGL-based engines like PlayCanvas, Babylon.js, or Three.js.

## Basic Setup

```typescript
import { Engine, Scene, Camera, Mesh, Material } from 'sprunk-engine';

// Create engine
const engine = new Engine({
  canvas: document.getElementById('game-canvas'),
  webgpu: true
});

// Create scene
const scene = new Scene(engine);

// Create camera
const camera = new Camera(scene);
camera.position.set(0, 2, 5);
camera.lookAt(0, 0, 0);

// Create a simple mesh
const mesh = new Mesh(scene, {
  geometry: 'box',
  material: new Material(scene, { color: 0xff0000 })
});
mesh.position.set(0, 0, 0);

// Start engine
engine.start();
```

## FPS Game Setup

### Player Controller

```typescript
import { Engine, Scene, Camera, Input } from 'sprunk-engine';

class PlayerController {
  private camera: Camera;
  private input: Input;
  private speed: number = 10;
  private sensitivity: number = 0.002;

  constructor(scene: Scene) {
    this.camera = new Camera(scene);
    this.camera.position.set(0, 2, 5);
    this.input = new Input(engine);
    
    // Lock pointer for FPS controls
    this.input.lockPointer();
  }

  update(deltaTime: number) {
    // Mouse look
    const mouseDelta = this.input.getMouseDelta();
    this.camera.rotation.y -= mouseDelta.x * this.sensitivity;
    this.camera.rotation.x -= mouseDelta.y * this.sensitivity;
    
    // Clamp vertical look
    this.camera.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, this.camera.rotation.x));

    // Movement
    const forward = this.camera.getForward();
    const right = this.camera.getRight();
    
    let moveX = 0;
    let moveZ = 0;

    if (this.input.isKeyDown('KeyW')) moveZ += 1;
    if (this.input.isKeyDown('KeyS')) moveZ -= 1;
    if (this.input.isKeyDown('KeyA')) moveX -= 1;
    if (this.input.isKeyDown('KeyD')) moveX += 1;

    const moveDir = forward.clone().multiplyScalar(moveZ).add(right.clone().multiplyScalar(moveX));
    if (moveDir.length() > 0) {
      moveDir.normalize();
      this.camera.position.add(moveDir.multiplyScalar(this.speed * deltaTime));
    }

    // Jump
    if (this.input.isKeyDown('Space')) {
      // Add jump logic with physics
    }
  }
}
```

### Physics Integration

```typescript
import { Physics, RigidBody, Collider } from 'sprunk-engine';

// Create physics world
const physics = new Physics(scene);
physics.gravity.set(0, -9.81, 0);

// Add physics body to player
const playerBody = new RigidBody(physics, {
  mass: 80,
  shape: 'capsule',
  height: 2,
  radius: 0.5
});
playerBody.position.copy(camera.position);

// Add static ground
const ground = new RigidBody(physics, {
  mass: 0, // Static
  shape: 'box',
  size: [100, 1, 100]
});
ground.position.set(0, -0.5, 0);
```

### Terrain with Heightmap

```typescript
import { Terrain, Heightmap } from 'sprunk-engine';

// Load heightmap
const heightmap = await Heightmap.load('/assets/heightmap.png');

// Create terrain
const terrain = new Terrain(scene, {
  heightmap: heightmap,
  size: 100,
  heightScale: 10,
  segments: 100
});

// Get height at position
const height = terrain.getHeightAt(x, z);
```

### Audio System

```typescript
import { Audio, Sound3D } from 'sprunk-engine';

// Initialize audio
const audio = new Audio(engine);

// Load sound
const gunshot = await audio.loadSound('/sounds/gunshot.wav');

// Play 3D sound
const sound3D = new Sound3D(audio, gunshot);
sound3D.position.copy(camera.position);
sound3D.play();

// Update audio listener
audio.setListenerPosition(camera.position);
audio.setListenerOrientation(camera.getForward(), camera.getUp());
```

## Project Structure

```
client_sprunk/
├── src/
│   ├── main.ts           # Entry point
│   ├── PlayerController.ts
│   ├── Terrain.ts
│   ├── NetworkManager.ts
│   └── assets/
│       ├── heightmaps/
│       ├── sounds/
│       └── models/
├── index.html
├── package.json
└── vite.config.ts
```

## Networking Integration

For multiplayer FPS, integrate with networking libraries:

```typescript
// Using Rivalis or Rhubarb for transport
import { Client } from 'rivalis';

const client = new Client('ws://localhost:8080');

// Using snapshot-interpolation for FPS networking
import { SnapshotInterpolation } from 'snapshot-interpolation';

const si = new SnapshotInterpolation(100); // 100ms buffer
```

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## Limitations

- **WebGPU only** - Requires modern browsers with WebGPU support
- **Newer project** - Less battle-tested than Three.js/Babylon.js
- **Smaller community** - Less documentation and community support
- **No built-in multiplayer** - Need to integrate networking separately

## Alternatives

If WebGPU support is a concern, consider:
- **PlayCanvas** - WebGL + WebGPU, full game engine, well-regarded
- **Babylon.js** - WebGL + WebGPU, full game engine, large community
- **Three.js + ecosystem** - Largest community, most flexible

## Resources

- [Sprunk Engine Documentation](https://sprunk-engine.github.io/sprunk-engine/)
- [WebGPU Browser Support](https://caniuse.com/webgpu)
- [WebGPU Guide](https://webgpu.dev/)
