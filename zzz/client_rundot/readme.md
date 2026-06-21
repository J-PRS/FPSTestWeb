# rundot-3d-engine FPS Game

A Three.js-based game engine with ECS architecture, physics, navigation, and comprehensive game systems. This project uses rundot-3d-engine to build a web-based FPS game.

## Features

- **ECS Architecture** - Component-based GameObject system for scalable game logic
- **Rapier3D Physics** - High-performance WASM physics engine integration
- **Dynamic Navigation** - A* pathfinding for AI movement
- **Advanced Animation** - Animation system with blending and retargeting
- **2D/3D Audio** - Comprehensive audio system with music management
- **UI System** - Built-in UI components and utilities
- **Camera Systems** - Follow camera, free camera with smooth transitions
- **Asset Loading** - FBX, GLB, OBJ loaders with skeleton caching
- **Particle System** - Flexible particle effects
- **Cross-platform Input** - Keyboard, mouse, gamepad with mobile support
- **TypeScript** - Full type safety throughout
- **Three.js Integration** - Leverages Three.js ecosystem

## Installation

```bash
npm install @series-inc/rundot-3d-engine
```

## Browser Requirements

rundot-3d-engine uses Three.js and supports:
- WebGL 2.0 (most modern browsers)
- WebGPU (optional, where supported)
- All major browsers (Chrome, Firefox, Safari, Edge)

## Basic Setup

```typescript
import { VenusGame, GameObject, Component } from "@series-inc/rundot-3d-engine";
import { PhysicsSystem, UISystem } from "@series-inc/rundot-3d-engine/systems";

// Create game instance
const game = new VenusGame({
  canvas: document.getElementById('game-canvas')
});

// Initialize game
await game.initialize();

// Add systems
game.addSystem(new PhysicsSystem());
game.addSystem(new UISystem());

// Start game loop
game.start();
```

## FPS Game Setup

### Player Controller with ECS

```typescript
import { GameObject, Component } from "@series-inc/rundot-3d-engine";

// Define components
class PlayerComponent extends Component {
  speed: number = 10;
  sensitivity: number = 0.002;
}

class TransformComponent extends Component {
  position: { x: number, y: number, z: number };
  rotation: { x: number, y: number, z: number };
}

// Create player GameObject
const player = new GameObject();
player.addComponent(new TransformComponent({
  position: { x: 0, y: 2, z: 5 },
  rotation: { x: 0, y: 0, z: 0 }
}));
player.addComponent(new PlayerComponent());
player.addComponent(new CameraComponent());

// Add to game
game.addGameObject(player);
```

### Physics Integration

```typescript
import { PhysicsSystem, RigidBodyComponent, ColliderComponent } from "@series-inc/rundot-3d-engine/systems";

// Add physics system
game.addSystem(new PhysicsSystem());

// Add physics to player
player.addComponent(new RigidBodyComponent({
  mass: 80,
  type: 'dynamic'
}));
player.addComponent(new ColliderComponent({
  shape: 'capsule',
  height: 2,
  radius: 0.5
}));

// Add static ground
const ground = new GameObject();
ground.addComponent(new TransformComponent({
  position: { x: 0, y: -0.5, z: 0 }
}));
ground.addComponent(new RigidBodyComponent({
  mass: 0, // Static
  type: 'static'
}));
ground.addComponent(new ColliderComponent({
  shape: 'box',
  size: [100, 1, 100]
}));
game.addGameObject(ground);
```

### Navigation and Pathfinding

```typescript
import { NavigationSystem, NavMeshComponent } from "@series-inc/rundot-3d-engine/systems";

// Add navigation system
game.addSystem(new NavigationSystem());

// Create nav mesh
const navMesh = new GameObject();
navMesh.addComponent(new NavMeshComponent({
  source: '/assets/navmesh.obj'
}));
game.addGameObject(navMesh);

// Calculate path for AI
const path = navigationSystem.findPath(startPosition, targetPosition);
```

### Animation System

```typescript
import { AnimationComponent, AnimationSystem } from "@series-inc/rundot-3d-engine/systems";

// Add animation system
game.addSystem(new AnimationSystem());

// Load animated character
const character = new GameObject();
character.addComponent(new ModelComponent({
  model: '/assets/character.glb'
}));
character.addComponent(new AnimationComponent({
  animations: {
    idle: '/assets/animations/idle.glb',
    run: '/assets/animations/run.glb',
    shoot: '/assets/animations/shoot.glb'
  },
  defaultAnimation: 'idle'
}));
game.addGameObject(character);

// Play animation
character.getComponent(AnimationComponent).play('run');
```

### Audio System

```typescript
import { AudioSystem, AudioSourceComponent, AudioListenerComponent } from "@series-inc/rundot-3d-engine/systems";

// Add audio system
game.addSystem(new AudioSystem());

// Add audio listener to player
player.addComponent(new AudioListenerComponent());

// Add 3D sound source
const gunshot = new GameObject();
gunshot.addComponent(new AudioSourceComponent({
  clip: '/sounds/gunshot.wav',
  spatial: true,
  volume: 0.5
}));
gunshot.getComponent(TransformComponent).position = { x: 0, y: 0, z: 0 };
game.addGameObject(gunshot);

// Play sound
gunshot.getComponent(AudioSourceComponent).play();
```

### Terrain with Heightmap

```typescript
import { TerrainComponent } from "@series-inc/rundot-3d-engine/systems";

// Create terrain
const terrain = new GameObject();
terrain.addComponent(new TerrainComponent({
  heightmap: '/assets/heightmap.png',
  size: 100,
  heightScale: 10,
  segments: 100
}));
game.addGameObject(terrain);

// Get height at position
const height = terrain.getComponent(TerrainComponent).getHeightAt(x, z);
```

### Input System

```typescript
import { InputSystem, InputComponent } from "@series-inc/rundot-3d-engine/systems";

// Add input system
game.addSystem(new InputSystem());

// Add input to player
player.addComponent(new InputComponent({
  lockPointer: true
}));

// Handle input in system
class PlayerInputSystem extends System {
  update(deltaTime: number) {
    const players = this.query(GameObject).with(PlayerComponent, InputComponent);
    
    for (const player of players) {
      const input = player.getComponent(InputComponent);
      const transform = player.getComponent(TransformComponent);
      
      // Mouse look
      const mouseDelta = input.getMouseDelta();
      transform.rotation.y -= mouseDelta.x * 0.002;
      transform.rotation.x -= mouseDelta.y * 0.002;
      
      // Movement
      if (input.isKeyDown('KeyW')) {
        // Move forward
      }
      if (input.isKeyDown('KeyS')) {
        // Move backward
      }
      if (input.isKeyDown('KeyA')) {
        // Move left
      }
      if (input.isKeyDown('KeyD')) {
        // Move right
      }
    }
  }
}
```

## Project Structure

```
client_rundot/
├── src/
│   ├── main.ts              # Entry point
│   ├── components/          # Custom components
│   │   ├── PlayerComponent.ts
│   │   ├── WeaponComponent.ts
│   │   └── HealthComponent.ts
│   ├── systems/             # Custom systems
│   │   ├── PlayerMovementSystem.ts
│   │   ├── WeaponSystem.ts
│   │   └── NetworkSystem.ts
│   ├── gameobjects/         # GameObject factories
│   │   ├── Player.ts
│   │   ├── Enemy.ts
│   │   └── Projectile.ts
│   └── assets/
│       ├── models/
│       ├── animations/
│       ├── sounds/
│       └── textures/
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

// Create network system
class NetworkSystem extends System {
  private client: Client;
  
  constructor() {
    super();
    this.client = new Client('ws://localhost:8080');
  }
  
  update(deltaTime: number) {
    // Send player position
    const player = this.query(GameObject).with(PlayerComponent, TransformComponent).first();
    if (player) {
      const transform = player.getComponent(TransformComponent);
      this.client.send({
        type: 'position',
        x: transform.position.x,
        y: transform.position.y,
        z: transform.position.z
      });
    }
    
    // Receive server updates
    const messages = this.client.receive();
    for (const message of messages) {
      this.handleMessage(message);
    }
  }
}
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

## Advantages

- **Full game engine** - Everything included (ECS, physics, audio, UI, navigation)
- **Three.js ecosystem** - Leverages existing Three.js community and tools
- **TypeScript** - Full type safety
- **ECS architecture** - Scalable game logic
- **Rapier3D physics** - High-performance WASM physics
- **Cross-platform** - Works on all modern browsers
- **Active development** - Regular updates and improvements

## Limitations

- **Smaller community** - Less documentation than Three.js/Babylon.js
- **Newer project** - Less battle-tested than established engines
- **Learning curve** - ECS architecture requires understanding of component-based design

## Comparison to Alternatives

| Feature | rundot-3d-engine | PlayCanvas | Babylon.js | Three.js |
|---------|-----------------|------------|------------|----------|
| Full Game Engine | ✅ | ✅ | ✅ | ❌ (rendering only) |
| ECS Architecture | ✅ | ❌ | ❌ | ❌ (add yourself) |
| Physics | ✅ (Rapier) | ✅ | ✅ | ❌ (add yourself) |
| TypeScript | ✅ | ✅ | ✅ | ✅ |
| Community | Small | Large | Large | Huge |
| Documentation | Limited | Extensive | Extensive | Extensive |

## Resources

- [rundot-3d-engine Documentation](https://www.npmjs.com/package/@series-inc/rundot-3d-engine)
- [Three.js Documentation](https://threejs.org/docs/)
- [Rapier Physics](https://rapier.rs/docs/user_guides/javascript)
- [ECS Guide](https://github.com/SanderMertens/ecs-faq)
