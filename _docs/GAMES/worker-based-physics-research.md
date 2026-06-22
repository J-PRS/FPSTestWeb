# Worker-Based Physics for Browser Multiplayer Games

**Date:** 2026-06-22
**Objective:** Research worker-based physics architectures to solve alt-tab throttling issues in browser multiplayer games

## Problem Statement

Browser games suffer from tab throttling - when a user alt-tabs, the browser significantly throttles the main thread to save resources. This causes:
- Physics simulation to pause
- Players to "hang" in mid-air
- Desync between client and server
- Poor user experience

## Solution: Worker-Based Physics

Move physics simulation to a Web Worker, which continues running even when the main thread is throttled.

## Real-World Examples

### 1. Aetheris Client (High-Performance WASM Runtime)

**Architecture:** Three-worker topology
- **Game Worker** - Runs WASM simulation core at 60Hz. Owns physics tick, entity state, game logic
- **Render Worker** - Reads lock-free double-buffer via SharedArrayBuffer, drives WebGPU render pipeline
- **Main Thread** - Owns DOM, input capture, lifecycle, routes messages between workers

**Key Features:**
- Deterministic three-worker execution model
- WebGPU rendering
- WebTransport networking
- Client-side prediction
- SharedArrayBuffer for zero-copy data transfer

**Benefits:**
- Physics continues running when main thread is throttled
- Smooth 60Hz experience even during network spikes
- Parallel execution prevents frame drops

**Source:** https://github.com/garnizeh-labs/aetheris-client

### 2. kevzettler/multiplayer-voxel-browser-game-engine

**Architecture:** Multi-threaded with Web Workers
- **Main Thread** - Browser APIs: input, networking, rendering
- **Simulation Worker** - Game simulation loop, OffscreenCanvas rendering
- **Server** - Same worker simulation thread, messages over network instead of postMessage

**Key Features:**
- OffscreenCanvas API for worker-side rendering
- postMessage communication between threads
- State ECS (Entity Component System)
- AABB broad-phase collision, swept sphere narrow-phase
- Regl rendering (WebGL wrapper)

**Benefits:**
- Simulation runs at max tick rate regardless of main thread
- Main render thread maintains smooth 60 FPS
- Separation of concerns keeps simulation stable

**Source:** https://github.com/kevzettler/multiplayer-voxel-browser-game-engine

### 3. luketurnbull/threejs-offscreen-canvas

**Architecture:** Dedicated workers for physics and rendering
- **Physics Worker** - Rapier at 60Hz, writes transforms + timestamps to SharedArrayBuffer
- **Render Worker** - Reads transforms, interpolates between physics states
- **Main Thread** - Input capture, audio, debug UI, worker orchestration

**Key Features:**
- Three.js WebGLRenderer in OffscreenCanvas worker
- Rapier Physics (WASM) in dedicated worker
- SharedArrayBuffer for zero-copy transform sync
- Timestamp interpolation for smooth motion at any refresh rate
- Floating capsule controller with coyote time
- Procedural terrain with Simplex noise

**Benefits:**
- Smooth 120Hz+ visuals from 60Hz physics
- Physics continues in background
- Zero-copy memory sharing reduces overhead

**Source:** https://github.com/luketurnbull/threejs-offscreen-canvas

### 4. VOIDSTRIKE (Browser RTS)

**Architecture:** Worker-first runtime
- **Game Worker** - Authoritative ECS simulation
- **Additional Workers** - Pathfinding, vision, AI decisions, overlay timing, countdown logic
- **Main Thread** - Rendering, input

**Key Features:**
- Background-safe fixed-step simulation
- Worker-driven fixed-timestep loops preserve RTS timing when tabs lose foreground priority
- Deterministic simulation discipline (quantized math, deterministic ordering)
- Lockstep multiplayer runtime
- WebGPU-first renderer with WebGL2 fallback

**Benefits:**
- Timing preserved even when tab is backgrounded
- Deterministic simulation across all clients
- Low server costs (serverless P2P)

**Source:** https://github.com/braedonsaunders/voidstrike

### 5. WeedJS (2D Game Engine)

**Architecture:** Specialized workers for each subsystem
- **spatial_worker** (1..N) - Spatial hash rebuilds and neighbor lists
- **physics_worker** (1) - Verlet integration, collision solving, constraints
- **logic_worker** (1..N) - Entity tick(), lifecycle, collision callbacks
- **particle_worker** (1) - Particles, bullets, decals, navigation, visibility lists
- **pre_render_worker** (1) - Animation, Y-sorting, render queue assembly
- **pixi_worker** (1) - PixiJS rendering on OffscreenCanvas
- **AudioMixerProcessor** (1) - Real-time audio mixing on AudioWorklet thread

**Key Features:**
- SharedArrayBuffer-backed component data
- PixiJS renderer on OffscreenCanvas
- Single-writer ownership for each shared region (lock-free)
- Pooled objects, dense memory, explicit worker ownership
- Predictable frame pipelines

**Benefits:**
- Each subsystem has dedicated execution path
- Hot data contiguous, low allocation
- Busy scenes stay responsive
- Audio mixing off main thread

**Source:** https://github.com/brotochola/MultithreadedGameEngine

### 6. OpenFront (Strategy Game)

**Architecture:** Multi-threaded client
- **Main Thread** - UI, rendering (PixiJS), user input handling
- **Worker Thread** - Core simulation, pathfinding, game logic

**Key Features:**
- Intent-execution model (clients send intents, server relays turns)
- Deterministic gameplay (all clients simulate same state)
- Low server costs (server only relays messages)
- postMessage communication with transferable buffers
- Variable tick rate (200-1000ms per tick), 60 FPS rendering

**Benefits:**
- Worker prevents UI blocking
- Offline capability (singleplayer fully local)
- Server never runs game logic (stateless relay)

**Source:** https://openfrontio-openfrontio.mintlify.app/technical/client

## Common Patterns

### Pattern 1: Single Physics Worker
**Use case:** Simple to moderate complexity games
- Main thread: Input, rendering, UI
- Worker: Physics simulation, game logic
- Communication: postMessage or SharedArrayBuffer

**Pros:** Simple, effective, solves tab throttling
**Cons:** Single point of failure, can become bottleneck

### Pattern 2: Multi-Worker Architecture
**Use case:** Complex games with many subsystems
- Main thread: Input, rendering, UI
- Physics worker: Physics simulation
- Logic worker: Game logic, AI
- Render worker: Render preparation
- Communication: SharedArrayBuffer, message passing

**Pros:** Parallel execution, scalable, specialized workers
**Cons:** Complex, more overhead, harder to debug

### Pattern 3: SharedArrayBuffer Architecture
**Use case:** High-performance games requiring low latency
- Workers share memory via SharedArrayBuffer
- Zero-copy data transfer
- Lock-free with single-writer ownership

**Pros:** Minimal overhead, high performance
**Cons:** Requires COOP/COEP headers, browser support limitations

## Implementation Considerations

### Terrain Data in Workers
**Challenge:** Workers can't access main thread objects (Three.js terrain)

**Solutions:**
1. **Serialize heightmap to worker** - Send terrain data on initialization
2. **Simplified physics in worker** - Basic gravity, main thread handles collision
3. **Procedural terrain in worker** - Generate terrain independently (deterministic)

### Communication Overhead
**Challenge:** Data transfer between main thread and workers

**Solutions:**
1. **SharedArrayBuffer** - Zero-copy, but requires COOP/COEP headers
2. **Transferable objects** - Efficient transfer of large buffers
3. **Batched updates** - Send updates in batches, not per-frame

### Browser Support
**Requirements:**
- Web Workers (universal support)
- OffscreenCanvas (Chrome 69+, Firefox 105+, Safari 16.4+)
- SharedArrayBuffer (requires COOP/COEP headers)
- ES Modules in Workers (modern browsers)

## Recommendations for Our FPS Game

### Option 1: Single Physics Worker (Recommended for MVP)
**Architecture:**
- Main thread: Three.js rendering, input capture, UI
- Physics Worker: Movement simulation, terrain collision
- Networking Worker: Network communication (existing)

**Implementation:**
1. Serialize terrain heightmap to physics worker on init
2. Move MovementController to physics worker
3. Worker runs physics loop at 60Hz
4. Worker sends position updates to main thread for rendering
5. Worker sends position updates to networking worker for server sync

**Benefits:**
- Solves alt-tab throttling
- Maintains current architecture (minimal changes)
- Cost-effective (no server changes)
- Proven approach (multiple examples)

**Complexity:** Medium (terrain serialization, worker communication)

### Option 2: Combined Physics + Networking Worker
**Architecture:**
- Main thread: Three.js rendering, input capture, UI
- Combined Worker: Physics simulation + Network communication

**Implementation:**
1. Add MovementController to existing networking worker
2. Serialize terrain heightmap to worker
3. Worker runs physics loop continuously
4. Worker handles both physics and networking

**Benefits:**
- Fewer workers (simpler orchestration)
- Solves alt-tab throttling
- No additional worker overhead

**Complexity:** Medium (terrain serialization, existing worker modification)

### Option 3: Accept Limitation (Simplest)
**Architecture:**
- Keep current architecture
- Document alt-tab limitation
- Add warning message

**Benefits:**
- Zero implementation cost
- Honest about browser limitations
- Focus on gameplay

**Complexity:** None

## Cost Analysis

### Worker-Based Physics
- **Server cost:** $0 (client-side only)
- **Development cost:** Medium (2-3 days implementation)
- **Runtime cost:** Minimal (worker overhead, terrain data duplication)

### Server-Side Physics
- **Server cost:** High (4x+ CPU for 60Hz physics)
- **Development cost:** High (server-side terrain, collision, physics)
- **Runtime cost:** Significant (scales with player count)

## Conclusion

Worker-based physics is a **proven, cost-effective solution** to alt-tab throttling in browser games. Multiple successful projects use this approach:

- **Aetheris Client** - High-performance WASM with three-worker topology
- **VOIDSTRIKE** - Background-safe fixed-step simulation for RTS
- **WeedJS** - Specialized workers for each subsystem
- **OpenFront** - Worker-based simulation for strategy games

**Key insight:** Workers continue running even when the main thread is throttled, making them ideal for physics simulation that must continue in the background.

**Recommendation:** Implement Option 1 (Single Physics Worker) or Option 2 (Combined Worker) to solve the alt-tab issue without increasing server costs. This aligns with the cost-conscious approach of Narrow.one and provides a better user experience than accepting the limitation.
