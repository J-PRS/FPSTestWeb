# Project State Report: VORTEX FPS

**Date:** June 22, 2026  
**Project:** Multiplayer FPS Game (Three.js + Node.js)  
**Report Type:** Architecture & Current State Analysis

---

## Executive Summary

VORTEX FPS is a browser-based multiplayer first-person shooter inspired by Tribes and Quake. The project consists of a TypeScript/Node.js WebSocket server and a Three.js client with advanced movement mechanics (skiing, jetpack), projectile combat, and real-time multiplayer networking.

**Key Strengths:**
- Modular, well-organized architecture
- Binary protocol for efficient network communication (50-70% bandwidth reduction)
- Server-authoritative projectile system with lag compensation
- Worker-based networking for non-blocking UI
- Reconnection support with state restoration
- Rich visual effects and terrain system

**Current Status:** Functional multiplayer FPS with core gameplay mechanics implemented.

---

## Server Architecture

### Technology Stack
- **Runtime:** Node.js with TypeScript
- **Networking:** WebSocket (ws library v8.18.0)
- **Architecture:** Modular, event-driven
- **Port:** 8095
- **Tick Rate:** 15Hz (67ms per tick)

### Core Components

#### 1. Server.ts (Main Entry Point)
- WebSocket server initialization
- Connection lifecycle management
- Player join/reconnection handling
- Message routing to handlers
- Broadcasting to all connected clients

**Key Features:**
- Reconnection support with state restoration
- Graceful disconnect handling with delayed cleanup (10s broadcast delay, 5min timeout)
- Initial game state synchronization for new players

#### 2. PlayerManager.ts
Player state management with:
- Position, rotation, velocity tracking
- Health system (100 HP, death tracking)
- Rewind buffer for lag compensation (500ms history)
- Disconnect/reconnection state management
- WebSocket-to-player mapping

**Data Structures:**
- `players: Map<string, PlayerState>` - Active player states
- `rewindBuffer: Map<string, PositionSnapshot[]>` - Position history for lag compensation
- `wsToPlayerId: Map<WebSocket, string>` - Connection mapping

#### 3. GameLoop.ts
Fixed-tick game loop (15Hz) handling:
- Player respawn logic (2s respawn timer, random spawn points)
- Projectile simulation with gravity
- Projectile position broadcasting
- Disconnected player cleanup
- Tick-based physics updates

**Constants:**
- Gravity: -20.0 m/s²
- Projectile lifetime: 5 seconds
- Disconnect broadcast delay: 10 seconds
- Disconnect timeout: 5 minutes

#### 4. MessageHandler.ts
Incoming message processing:
- JSON and binary message handling
- Position updates with velocity calculation
- Shot processing with lag compensation
- Jump/jetpack event broadcasting
- Projectile destruction handling

**Lag Compensation:**
- Rewind buffer lookup by timestamp
- 100ms tolerance for position snapshots
- Falls back to current position if compensation fails

**Damage System:**
- Base damage: 100 HP
- Range bonus: +2 damage per meter (after 1s projectile lifetime)
- Max damage: 200 HP
- Reverse falloff rewards long-range skill shots

#### 5. ProjectileManager.ts
Server-side projectile tracking:
- Projectile creation and lifecycle management
- Position updates with gravity simulation
- Destruction on hit or timeout
- Server-authoritative projectile IDs

#### 6. BinaryProtocol.ts
Efficient binary encoding/decoding:
- Message type enumeration (1 byte)
- Binary encoder/decoder classes
- Protocol-specific encoding functions
- Little-endian byte order
- 50-70% bandwidth reduction vs JSON

**Supported Message Types:**
- JOIN, INPUT, POSITION, SHOT
- PLAYER_JOINED, PLAYER_LEFT, PLAYER_UPDATE
- GAME_STATE, HIT, KILL, PLAYER_RESPAWN

---

## Client Architecture

### Technology Stack
- **Renderer:** Three.js v0.184.0
- **Build System:** Vite v8.0.16
- **Networking:** WebSocket (ws library v8.21.0)
- **Language:** TypeScript
- **Additional:** @verseengine/three-avatar v1.0.2

### Core Components

#### 1. main.ts (Game Loop & Initialization)
Main game loop and scene setup:
- Three.js renderer with pixelated rendering option (4x pixel scale)
- Scene with fog, lighting (Tribes 2 aesthetic)
- Player, terrain, effects initialization
- Network manager setup with worker
- Remote player management
- Projectile systems (rockets, discs)
- Ball targets with spawning system
- Effects system (explosions, debris)

**Rendering Features:**
- Pixelated rendering (Doom-style)
- ACES filmic tone mapping
- PCF shadow mapping
- Exponential fog (warm haze)
- Dynamic shadow camera following player

#### 2. WorkerNetworkManager
Web Worker-based networking for performance:
- Offloads networking to separate thread
- Callback-based event system
- Network quality monitoring (ping, packet loss, jitter)
- Position/rotation interpolation
- Projectile synchronization

**Network Metrics:**
- Ping measurement (1s intervals)
- Packet loss calculation
- Jitter (standard deviation of ping)
- 20-sample ping history

#### 3. NetworkManager.ts
Core networking logic with dependency injection:
- INetworkAdapter interface for flexibility
- Binary protocol encoding
- Rate-limited position updates (15Hz)
- Delta compression for position data
- Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, 16s)
- Persistent player ID (localStorage)

**Optimizations:**
- Position send interval: 67ms (15Hz)
- Delta compression threshold: 0.001 units
- Max reconnect attempts: 5

#### 4. Player.ts
Local player controller:
- Movement system (WASD, skiing, jetpack)
- First-person camera control
- Weapon systems (rockets, discs)
- Health and energy management
- Input handling
- Event callbacks for networking

**Movement Constants:**
- Jet force up: 35.0 m/s²
- Jet force lateral: 10.0 m/s²
- Max energy: 60.0
- Jet drain: 12.0/s
- Jet charge: 8.0/s
- Fire rate: 0.8s
- Disc rate: 1.0s

#### 5. RemotePlayer.ts
Remote player representation:
- Position interpolation
- Model loading and animation
- Death animation with ragdoll physics
- Collision detection for projectiles
- Scale-based death effect (shrinks to 0)

#### 6. Movement.ts
Advanced movement controller:
- Skiing mechanics (momentum preservation)
- Jetpack physics
- Gravity and terrain collision
- Velocity-based movement
- Air control

#### 7. Terrain.ts
Heightmap-based terrain:
- Dynamic heightmap loading
- Shader-based rendering
- Fog uniform synchronization
- Collision detection
- Height queries for physics

#### 8. Projectile Systems

**Rocket.ts:**
- Server-authoritative tracking
- Collision with terrain, balls, players
- Explosion effects with knockback
- Trail particle system
- Score calculation (accuracy × distance × airtime)

**Disc.ts:**
- Pull-based explosion (implosion)
- Similar collision system to rockets
- Different scoring formula

#### 9. Effects System
- Explosion effects
- Implosion effects (disc)
- Jetpack particles
- Jump dust
- Ski dust
- Ball debris
- Player debris

#### 10. HUD.ts
On-screen display:
- Health indicator
- Energy bar
- Crosshair
- Hit marker
- Network stats (ping, packet loss, jitter)
- Kill feed

---

## Networking Protocol

### Message Flow

**Connection Sequence:**
1. Client connects via WebSocket
2. Client sends join message with persistent player ID
3. Server responds with current game state
4. Server broadcasts player joined to others
5. Client begins sending position updates (15Hz)
6. Server broadcasts position updates to others

**Position Updates:**
- Binary encoding (POSITION message type)
- Rate-limited to 15Hz
- Delta compression (skip if unchanged)
- Includes position, rotation, timestamp

**Shot Sequence:**
1. Client fires projectile locally
2. Client sends shot message with position/velocity/timestamp
3. Server creates projectile with server ID
4. Server broadcasts projectile created to all
5. Server updates projectile position each tick
6. On collision, client sends hit event with timestamp
7. Server performs lag compensation lookup
8. Server applies damage and broadcasts hit/kill

**Reconnection:**
1. Client detects disconnect
2. Client attempts reconnect with exponential backoff
3. Server recognizes player ID from previous session
4. Server restores player state (position, health, rotation)
5. Server sends current game state
6. Client resumes normal operation

### Binary Protocol Efficiency

**Position Message Size:**
- JSON: ~150 bytes
- Binary: ~45 bytes (70% reduction)

**Typical Bandwidth:**
- Position updates: 15Hz × 45 bytes = 675 bytes/s per player
- For 10 players: ~6.75 KB/s upstream

---

## Game Mechanics

### Movement System
- **Skiing:** Hold space on ground to preserve momentum
- **Jetpack:** Right mouse button for aerial propulsion
- **Air Control:** Limited lateral movement while airborne
- **Gravity:** -20 m/s² (fast fall, high skill ceiling)

### Combat System
- **Rockets:** Explosive projectiles with knockback
- **Discs:** Implosion projectiles (pull effect)
- **Scoring:** Accuracy (1-10) × Distance × Airtime
- **Damage:** 100 base + range bonus (up to 200)
- **Health:** 100 HP, 2-second respawn

### Targets
- **Balls:** Bouncing spheres with hit detection
- **Players:** Remote players with collision boxes
- **Terrain:** Heightmap-based landscape

---

## Current Limitations & Known Issues

### Server
1. **Input Handling:** `handleInput` is a stub (TODO comment) - inputs not processed
2. **Physics:** Server-side physics not fully implemented
3. **Validation:** Limited message validation
4. **Security:** No authentication or anti-cheat measures

### Client
1. **Performance:** Single-threaded rendering (no WebGPU)
2. **Mobile:** No touch controls (desktop-only)
3. **Audio:** No sound effects or music
4. **Assets:** Limited terrain heightmaps

### Networking
1. **Prediction:** No client-side prediction
2. **Reconciliation:** No server reconciliation
3. **Compression:** No general packet compression (only binary protocol)
4. **Latency:** No adaptive tick rate based on network conditions

---

## Development Status

### Completed Features
- ✅ WebSocket server with modular architecture
- ✅ Binary protocol implementation
- ✅ Player state management
- ✅ Lag compensation with rewind buffer
- ✅ Projectile tracking and updates
- ✅ Reconnection support
- ✅ Three.js rendering with terrain
- ✅ Advanced movement (skiing, jetpack)
- ✅ Projectile systems (rockets, discs)
- ✅ Effects system (explosions, particles)
- ✅ Remote player interpolation
- ✅ HUD with network stats
- ✅ Worker-based networking
- ✅ Auto-reconnect with exponential backoff

### Partially Implemented
- ⚠️ Server-side input processing (stub only)
- ⚠️ Server-side physics (basic only)
- ⚠️ Anti-cheat measures (none)

### Not Implemented
- ❌ Client-side prediction
- ❌ Server reconciliation
- ❌ Authentication system
- ❌ Matchmaking/lobby system
- ❌ Voice chat
- ❌ Spectator mode
- ❌ Recording/replay system
- ❌ Mobile controls
- ❌ Audio system

---

## Technical Debt

1. **Magic Numbers:** Many hardcoded constants (gravity, forces, rates)
2. **Error Handling:** Limited error handling in networking
3. **Logging:** Excessive console.log statements (should use proper logging)
4. **Type Safety:** Some `any` types used in message handlers
5. **Testing:** No unit tests or integration tests
6. **Documentation:** Limited inline documentation

---

## Recommendations

### High Priority
1. Implement server-side input processing and physics
2. Add client-side prediction for smoother movement
3. Implement proper authentication system
4. Add rate limiting and anti-cheat measures
5. Reduce console.log verbosity in production

### Medium Priority
1. Add server reconciliation
2. Implement adaptive tick rate based on network conditions
3. Add comprehensive error handling
4. Create unit tests for core systems
5. Add mobile touch controls

### Low Priority
1. Implement audio system
2. Add spectator mode
3. Create recording/replay system
4. Add voice chat
5. Implement matchmaking/lobby

---

## File Structure Summary

### Server (7 files)
- `Server.ts` - Main entry point
- `GameLoop.ts` - Fixed-tick game loop
- `MessageHandler.ts` - Message processing
- `PlayerManager.ts` - Player state management
- `ProjectileManager.ts` - Projectile tracking
- `BinaryProtocol.ts` - Binary encoding/decoding
- `types.ts` - Type definitions

### Client (22 files)
- `main.ts` - Game loop and initialization
- `Player.ts` - Local player controller
- `RemotePlayer.ts` - Remote player representation
- `PlayerModel.ts` - Player model and animations
- `movement.ts` - Movement controller
- `terrain.ts` - Heightmap terrain
- `rocket.ts` - Rocket projectile
- `disc.ts` - Disc projectile
- `balls.ts` - Target balls
- `effects.ts` - Visual effects manager
- `explosion.ts` - Explosion effect
- `implosion.ts` - Implosion effect
- `debris.ts` - Ball debris
- `PlayerDebris.ts` - Player debris
- `hud.ts` - On-screen display
- `sky.ts` - Sky dome
- `config.ts` - Configuration constants
- `networking/` - Networking subsystem
  - `NetworkManager.ts` - Core networking logic
  - `WSAdapter.ts` - WebSocket adapter
  - `BinaryProtocol.ts` - Binary protocol
  - `INetworkAdapter.ts` - Adapter interface
  - `networking.worker.ts` - Web worker

---

## Conclusion

VORTEX FPS is a well-architected multiplayer FPS with solid foundations. The modular design, binary protocol, and lag compensation demonstrate good engineering practices. The core gameplay loop is functional and enjoyable.

The project is ready for the next phase of development focused on:
1. Completing server-side physics and input processing
2. Adding client-side prediction for better network feel
3. Implementing authentication and security measures
4. Expanding content (maps, weapons, game modes)

The codebase is maintainable and extensible, with clear separation of concerns between server and client components.
