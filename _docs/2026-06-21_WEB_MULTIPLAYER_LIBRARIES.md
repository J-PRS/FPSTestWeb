# Web Multiplayer Libraries for FPS Games

## Overview

This document compares multiplayer networking libraries and frameworks suitable for fast-paced web FPS games like Krunker.io. Focus is on low-latency, real-time synchronization, and tight gameplay feel.

## What Krunker.io Uses

**Technology Stack:**
- **Transport**: Custom WebSocket implementation
- **Serialization**: MessagePack (binary, smaller/faster than JSON)
- **Game Logic**: Custom KrunkScript language (client + server scripts)
- **Architecture**: Client-server with rate limiting
- **Infrastructure**: Cloudflare CDN/DNS
- **Social Features**: Separate WebSocket endpoint (`wss://social.krunker.io/ws`)

**Key Techniques:**
- Binary protocol for efficiency
- Rate-limited network messages
- Origin checks for security
- Separate social vs game networking

## FishNet (Unity)

**Best for: Unity games requiring professional-grade networking**

**Pros:**
- Built from ground up for Unity by professional game designer
- More features than any other free Unity networking solution
- No CCU caps or paywalls
- Server-authoritative by design with dedicated server support
- Advanced AOI (Area of Interest) system with multiple conditions
- Single method can handle both reliable and unreliable calls
- Complete XML documentation coverage
- Active development (191 releases, last 2026)
- 1888 GitHub stars, strong community
- Supports all topologies through Transport system
- Built-in scene management (single, additive, stacked)
- Performance optimizations (distance-based throttling, bandwidth reduction)

**Cons:**
- Unity-only (not for web/JavaScript)
- More complex than simpler solutions
- Requires Unity knowledge

**Performance:**
- Highly optimized for production games
- Prediction reconciliation for bandwidth reduction
- Threaded tick smoothers (beta)
- NetworkTransform performance improvements
- Profiler markers for optimization

**Use Case:** If using Unity, FishNet is considered superior to Photon, Mirror, Fusion, and Unity Netcode for most use cases. It's used by MMOs, shooters, battle-royale, fighting games, and more.

**Comparison to Photon:**
- No CCU/paywall restrictions
- More flexible architecture
- Better documentation
- More active development
- Cleaner API design

## Performance-Obsessed Web Frameworks

### Rhubarb
**Best for: JavaScript games requiring zero-GC, WebWorker-based networking**

**Philosophy:** "Javascript is slow, therefore we want to have as much main-process-power as we can"

**Pros:**
- WebWorkers handle networking off main thread (more time for rendering)
- Transferables between main thread and worker (zero copy, no GC)
- Float32Arrays for protocols instead of JSON
- Objects allocated only on init, reused to prevent GC
- Works on browsers and Node.js
- Shared protocol definitions between server/client
- High-level protocol definitions with automatic bitwise operations

**Cons:**
- 203 GitHub stars (smaller community)
- Single maintainer
- Less feature-rich than full frameworks
- Requires understanding of WebWorker patterns

**Performance:**
- Zero-copy data transfer
- No GC activity from networking
- Much less bandwidth than JSON.stringify
- Designed specifically for 60 FPS multiplayer games

**Use Case:** When you need maximum performance and understand browser threading well. Similar "performance-obsessed nerd" energy to FishNet.

### PaindaProtocol
**Best for: Binary-native, high-throughput real-time apps**

**Pros:**
- 70-90% smaller payloads than JSON
- Pure WebSocket from start (no HTTP polling)
- 16-byte custom header for lightning-fast routing
- Delta engine - state sync via binary diffs at 60 FPS
- Zero-copy DataView framing
- Socket.io-like API (easy migration)
- Beats Socket.io, uWS, Bun in benchmarks
- Full replay support
- Plugin system with lifecycle hooks

**Cons:**
- Newer project (less battle-tested)
- Smaller community
- Documentation still evolving

**Performance:**
- Extremely high (<20ms latency)
- 10× higher throughput than Socket.io
- 70% less wire overhead
- Delta sync at 60 FPS

**Use Case:** When you need Socket.io's ease of use but with binary performance. Good alternative to commercial solutions.

### Rivalis
**Best for: Type-safe, security-conscious real-time apps**

**Pros:**
- Binary wire protocol with strict types end-to-end
- Origin allow-lists for CSWSH protection on by default
- 64 KiB frame cap, 30/s token-bucket rate limit
- Exponential-backoff reconnect built-in
- Two concepts only: Rooms + Actors (simple mental model)
- TypeScript-native, zero hidden runtime dependencies
- Topic-based messaging (no manual switch statements)
- Ships single-file skill manifest for AI assistants
- Free for commercial use, forever
- Works with Phaser, PixiJS, Three.js, Babylon.js

**Cons:**
- Newer framework (less ecosystem)
- Smaller community than Colyseus
- Less opinionated than full frameworks

**Performance:**
- Binary payloads
- Rate limiting built-in
- Heartbeats with backpressure handling
- Optimized for game tick rates

**Use Case:** When you want type safety and security built-in from the start. "Everything considered" approach similar to FishNet's professional touches.

**Comparison to Colyseus:**
- Rivalis gives raw binary frames (full control)
- Colyseus auto-syncs state via Schema (framework owns state)
- Rivalis: zero schema decorators, drops into any http.Server
- Both MIT, both Node.js

## FPS-Specific Networking Libraries

### snapshot-interpolation
**Best for: Entity interpolation and lag compensation**

**Pros:**
- Snapshot interpolation for smooth entity movement
- Client-side prediction support
- Server reconciliation
- Lag compensation
- TypeScript support
- Works with any networking layer
- Lightweight, focused library

**Cons:**
- Only handles interpolation/prediction (not full networking)
- You still need to implement the transport layer
- Smaller project

**Use Case:** Add smooth entity interpolation to any multiplayer game. Pair with a networking library like Rhubarb or PaindaProtocol.

### rollback-netcode
**Best for: P2P rollback netcode (GGPO-style) in browser**

**Pros:**
- Rollback netcode like GGPO
- 4+ player support (not limited to 2)
- P2P networking via WebRTC DataChannels
- Dynamic join/leave during gameplay
- Desync detection with automatic recovery
- Transport-agnostic (WebRTC included)
- TypeScript

**Cons:**
- P2P only (no dedicated server mode)
- Requires deterministic game logic
- Need signaling server for WebRTC setup
- Game state must be serializable

**Use Case:** Fighting games, local multiplayer ported to web, or when you want serverless P2P multiplayer.

### netplayjs
**Best for: Rapid P2P multiplayer prototyping with rollback**

**Pros:**
- No server hosting required
- Rollback netcode + WebRTC
- Client-side prediction and rewind
- Lockstep netcode option for non-rewindable games
- Prototyping framework for quick development
- Public matchmaking server available
- Local wrapper for testing without network

**Cons:**
- P2P only (not server-authoritative)
- Game state must be serializable
- Framework can be restrictive for complex games
- Less control than raw rollback-netcode

**Use Case:** Quick prototyping of P2P multiplayer games, or when you don't want to host servers.

### Telegraph
**Best for: GGPO-style rollback netcode in TypeScript**

**Pros:**
- Direct port of GGPO to TypeScript
- Lockstep with rollback
- Only sends inputs over wire (not state)
- Uses PeerJS for WebRTC connections
- Battle-tested GGPO algorithm
- Good for fighting games

**Cons:**
- Requires deterministic game logic
- No dynamic join/leave (all players must connect before start)
- You must bring your own PeerJS connections
- No built-in lobby server

**Use Case:** Fighting games or games requiring GGPO-style rollback netcode.

### GarageServer.IO
**Best for: Simple authoritative server with FPS features**

**Pros:**
- Authoritative Node.js game server
- Client-side prediction
- Client-side smoothing
- Entity interpolation
- Server state history
- Simple and lightweight
- JavaScript client included

**Cons:**
- Smaller project (less battle-tested)
- Less feature-rich than full frameworks
- Basic implementation

**Use Case:** When you want a simple authoritative server with FPS networking features built-in, without the complexity of Colyseus.

## Lightweight Web 3D Engines

### nanothree
**Best for: Maximum performance with minimal bundle size**

**Philosophy:** High-performance subset of Three.js, WebGPU-only

**Pros:**
- WebGPU-native renderer (no WebGL fallback)
- Very small bundle size (always small, unlike Three.js's 198KB+)
- Three.js-compatible scene graph and naming conventions
- Shadow mapping and frustum culling
- GLTF/GLB loading with Draco + KTX2/Basis support (decoders bundled)
- Skeletal animation support
- Instancing for thousands of objects
- Raycasting with Moller-Trumbore algorithm
- BVH-accelerated raycasts

**Cons:**
- WebGPU only (no WebGL fallback - browser support limited)
- Lambert materials only (no PBR)
- No point lights, only ambient + directional
- No post-processing
- No orbit controls included
- Not a drop-in replacement for Three.js

**Performance:**
- Designed specifically for performance
- Smaller bundle than Three.js
- WebGPU-native for modern GPU features

**Use Case:** When you want Three.js-like API but with WebGPU performance and minimal bundle. Good for games that don't need PBR or complex lighting.

### Zephyr3D
**Best for: Unified WebGL/WebGPU with TypeScript-first approach**

**Philosophy:** Lightweight · Modular · Developer-friendly · Visual creation empowered by code

**Pros:**
- Unified WebGL/WebGPU backends (switch without rewriting code)
- Code-generated shader system (JS/TS → GLSL/WGSL)
- Full web-based visual editor
- Build shaders in TypeScript/JavaScript (no raw GLSL/WGSL strings)
- Generates backend-specific code automatically
- Modular architecture (install only what you need)
- Browser-native editor
- Actively developed by maintainer

**Cons:**
- Smaller community (130 GitHub stars)
- Newer project (APIs may change)
- Less ecosystem than Three.js/Babylon
- Requires TypeScript for best experience

**Performance:**
- WebGPU backend for modern performance
- WebGL fallback for compatibility
- Code-generated shaders for optimization

**Use Case:** When you want modern WebGPU with WebGL fallback, TypeScript-first development, and a visual editor. Good balance of performance and developer experience.

### Orillusion
**Best for: Production WebGPU engine with desktop-level rendering**

**Pros:**
- Pure Web3D rendering engine based on WebGPU
- 5166 GitHub stars (legitimate, active community)
- TypeScript-based
- Desktop-level rendering effects
- Complex scene support
- Vite/Webpack recommended
- Multiple import methods (ESM, CDN, native)
- Active development (17 releases, latest 2024)

**Cons:**
- WebGPU only (browser support limited)
- Larger than nanothree/Zephyr3D
- Less lightweight than the minimal options
- WebGPU must be enabled in browser flags

**Performance:**
- WebGPU-native for maximum performance
- Designed for complex scenes
- Desktop-level rendering quality

**Use Case:** When you want a legitimate, production-ready WebGPU engine with good community and features. More feature-rich than nanothree/Zephyr3D but still WebGPU-focused.

## Comparison Summary

| Engine | Backend | Bundle | Community | Best For |
|--------|---------|--------|-----------|----------|
| nanothree | WebGPU only | Smallest | Small | Maximum performance, minimal features |
| Zephyr3D | WebGL + WebGPU | Modular | Small | TypeScript-first, visual editor, flexibility |
| Orillusion | WebGPU only | Medium | Large (5166★) | Production WebGPU, complex scenes |
| PlayCanvas | WebGL + WebGPU | 1-2MB | Large | Teams, production, full engine |
| Babylon.js | WebGL + WebGPU | Large | Very Large | Prototypes, full-featured |
| Three.js | WebGL + WebGPU | 198KB+ | Huge | Ecosystem, compatibility |

## Binary Serialization Libraries

### binary-packet
**Best for: Ultra-fast WebSocket communication with type-safe messages**

**Philosophy:** Lightweight and hyper-fast, zero-dependencies, TypeScript-first

**Pros:**
- Hyper-fast serialization
- Zero dependencies
- TypeScript-first, schema-based
- Supports DataView, ArrayBuffer, Buffer
- Sequential serializer for iterables (no temporary arrays)
- Smallest bytes usage possible
- Designed specifically for WebSocket communication

**Cons:**
- Very new library (not battle-tested)
- May crash with complex structures
- Less features than msgpackr
- Not production-ready for sensitive data

**Performance:**
- Faster than msgpackr and restructure
- More type-safe than msgpackr
- Sequential serializer avoids allocations

**Use Case:** When you need maximum performance for WebSocket messages and both client/server are TypeScript.

### typescript-binary
**Best for: Real-time HTML5 and Node.js applications**

**Pros:**
- Smaller than FlatBuffers or Protocol Buffers
- 16-bit floats support
- Boolean-packing
- Property mangling
- Compatible with geckos.io, socket.io, peer.js
- Based on lightning-fast sitegui/js-binary
- Native TypeScript schema definition
- No external tooling dependencies

**Cons:**
- Cross-language support only via JavaScript (not Java/C++/Python)
- Not suitable for web APIs (better for real-time data)
- Less mature than FlatBuffers/Protobuf

**Performance:**
- 34 bytes vs 68 bytes (FlatBuffers) vs 72 bytes (Protobuf) for reference data
- Fast and efficient
- Suitable for real-time data

**Use Case:** Real-time games/apps where both client and server use JavaScript/TypeScript and you want smaller payloads than FlatBuffers/Protobuf.

### packcat
**Best for: Networked games/apps with schema-based binary packing**

**Pros:**
- Generates efficient pack/unpack functions from schemas
- TypeScript type inference from schemas
- Pack into existing buffers (packInto)
- Validation built-in
- Great for minimizing bandwidth
- Share schema definitions between client/server

**Cons:**
- No formal specification for packed data format
- No guarantees about format stability between versions
- Assumes little-endian machines
- Not recommended for persistent data storage

**Performance:**
- Efficient function generation
- Compact buffers
- Validation overhead minimal

**Use Case:** Networked games where both client/server use JavaScript and you want to minimize bandwidth with schema-based packing.

### ts-jsbt
**Best for: Complex JavaScript object graphs with circular references**

**Philosophy:** JavaScript Binary Transfer - designed for JavaScript → JavaScript communication

**Pros:**
- Serializes real JavaScript object graphs (not just JSON-like data)
- Handles circular references and shared objects
- Supports Dates, BigInts, TypedArrays, Maps, Sets, Symbols
- Class instance reconstruction
- Aggressive size deduplication
- Stream decoding (parse before full payload received)
- 0.43kb minified size
- ~60.5kb for 1,000,000 objects (vs 1,029ms for JSON)

**Cons:**
- JavaScript/TypeScript only (not cross-language)
- Not suitable for web APIs
- Requires both sides to be JavaScript
- Overkill for simple JSON-like data

**Performance:**
- Encodes ~1,029 ms/op, decodes ~43 ms/op (heavy test)
- Handles circular refs where JSON/Protobuf/MsgPack/CBOR fail
- Stream decoding for efficiency

**Use Case:** Node ↔ Node, Node ↔ Browser, worker threads, IPC, complex data structures with circular references.

### tinybuf
**Best for: Fast, compressed binary serializers**

**Pros:**
- Blazing fast serialization
- ^50% smaller than FlatBuffers
- ~4.4kb minzipped
- Zero dependencies
- Strong inferred types
- Built-in validation/transforms
- Property mangling (Terser)
- Compression support
- Parser for registered formats

**Cons:**
- Newer library
- Less ecosystem than FlatBuffers/Protobuf
- TypeScript-focused

**Performance:**
- Very fast serialization
- 50% smaller than FlatBuffers
- Small bundle size

**Use Case:** When you want fast, compressed binary serialization with strong TypeScript types and small bundle size.

## Physics Engines

### cannon.js
**Best for: Lightweight 3D physics for the web**

**Philosophy:** Inspired by three.js and ammo.js, driven by the fact that the web lacks a physics engine

**Pros:**
- Lightweight 3D physics engine
- Rigid body dynamics
- Discrete collision detection
- Contacts, friction, restitution
- Constraints (PointToPoint, Distance, Hinge, Lock, ConeTwist)
- Gauss-Seidel constraint solver
- Collision filters
- Body sleeping
- Various shapes (Sphere, Plane, Box, Cylinder, Convex, Particle, Heightfield, Trimesh)
- SI units (metre, kilogram, second)
- Well-documented examples

**Cons:**
- Older project (less active development)
- Less feature-rich than ammo.js/Havok
- No WASM acceleration

**Performance:**
- Lightweight and fast
- Good for web games
- Island split algorithm for optimization

**Use Case:** When you need a lightweight 3D physics engine for web games without the complexity of ammo.js or Havok.

### ammo.js
**Best for: Bullet physics engine ported to JavaScript**

**Philosophy:** "Avoided Making My Own js physics engine by compiling bullet from C++"

**Pros:**
- Direct port of Bullet physics engine
- Functionality identical to original Bullet
- Battle-tested physics engine
- Autogenerated API from Bullet source
- WebGL demo included
- Zlib licensed

**Cons:**
- Large download (Emscripten compiled)
- More complex than cannon.js
- Requires Emscripten and cmake to build yourself
- Better suited for C++ → JavaScript workflow

**Performance:**
- Full Bullet physics performance
- WASM acceleration possible

**Use Case:** When you need full Bullet physics engine features and are okay with larger bundle size.

### Havok (via Babylon.js)
**Best for: Production-grade physics with WebAssembly**

**Pros:**
- WebAssembly version of Havok physics
- Free to use under MIT license
- Fully integrated in Babylon.js
- Production-grade physics engine
- WASM acceleration
- Available via npm and CDN
- Babylon team support

**Cons:**
- Babylon.js integration (not engine-agnostic)
- Requires async initialization
- Larger than cannon.js
- WebAssembly support required

**Performance:**
- WASM acceleration for maximum performance
- Production-grade physics calculations

**Use Case:** When using Babylon.js and need production-grade physics with WASM acceleration.

## ECS Frameworks

### Quantum Engine
**Best for: Bevy-style ECS architecture for the browser**

**Philosophy:** A minimal, modular Entity Component System (ECS) game engine in TypeScript. Browser-first, plugin-driven.

**Pros:**
- Bevy-style architecture
- Type-safe components (SoA and AoS storage)
- Archetype-based queries with caching
- BitSet component checks
- Topological system ordering
- Entity lifecycle with ID reuse
- Plugin-driven architecture (20 packages)
- Three.js integration plugin
- Rapier3D physics plugin
- Scene editor plugin
- Bun monorepo with Turborepo
- Browser-first build pipeline

**Cons:**
- Newer project
- Requires Bun for monorepo
- More complex than simpler ECS frameworks
- TypeScript required

**Performance:**
- Cache-friendly Structure-of-Arrays component storage
- Archetype-based queries with caching
- Schedule-based system executor

**Use Case:** When you want a modern, Bevy-style ECS with plugins for rendering, physics, and editing.

### esengine
**Best for: Engine-agnostic high-performance TypeScript ECS**

**Philosophy:** ESEngine is a collection of engine-agnostic game development modules for TypeScript

**Pros:**
- 884 GitHub stars (legitimate community)
- Engine-agnostic (works with Cocos, Laya, Phaser, PixiJS)
- High-performance ECS with reactive queries
- Optional modules: Behavior Tree, Blueprint (visual scripting), FSM, Timer, Spatial, Pathfinding, Procgen
- Spatial indexing (QuadTree, Grid)
- A* and navigation mesh pathfinding
- Procedural generation (noise, random, sampling)
- Visual editor support for behavior trees
- TypeScript-first

**Cons:**
- ECS only (no rendering built-in)
- Need to pair with rendering engine
- More modules = more complexity

**Performance:**
- High-performance ECS
- Reactive queries
- Spatial indexing for performance

**Use Case:** When you want engine-agnostic ECS with optional AI, pathfinding, and procgen modules.

### kernelplay
**Best for: Unity-like Entity-Component-Script architecture in browser**

**Philosophy:** A 2D/3D JavaScript game engine that feels like Unity — but lives in your browser

**Pros:**
- Entity-Component-Script architecture (like Unity)
- 3 renderer backends (Canvas 2D, Pixi.js, Three.js) - swap with one line
- 10,000+ objects at 60 FPS on 7th gen i3
- Full animation state machine
- Zero config object pooling
- Spatial grid
- Frustum culling
- Script lifecycle (onAttach → onStart → update → lateUpdate → onDestroy)
- Physics system
- Camera system
- Unity-like API

**Cons:**
- Smaller community
- Newer project
- JavaScript-focused (less TypeScript)
- Less mature than Unity

**Performance:**
- 10,000+ objects at 60 FPS
- Object pooling
- Spatial grid for performance
- Frustum culling

**Use Case:** When you want Unity-like development experience in the browser with multiple renderer backends.

## Svelte-Like Game Engines

### Bloom Engine
**Best for: Compile-time TypeScript to native games (Svelte philosophy: no runtime)**

**Philosophy:** Write TypeScript. Ship native games. No browser, no C++. Bloom compiles your game ahead-of-time.

**Pros:**
- Compiles TypeScript ahead-of-time (no runtime overhead)
- Runs on Metal, DirectX 12, Vulkan, WebGPU (one codebase, six targets)
- Rust core for performance
- API fits on a cheatsheet (no classes, no inheritance, no magic)
- Real PBR rendering and physics out of the box
- macOS, Windows, Linux, iOS, tvOS, Web from one codebase
- Steam, App Store, itch.io ready
- WASM bundle for web
- Single wgpu-backed renderer

**Cons:**
- Not web-first (native-first with web as target)
- Requires Perry compiler
- Newer project
- Less ecosystem than web engines

**Performance:**
- Ahead-of-time compilation
- Native performance
- No browser runtime overhead

**Use Case:** When you want Svelte-like compile-time optimizations but for native games, with web as one target.

### Glyft
**Best for: GPU-First declarative 2D framework (Svelte philosophy: less code, more output)**

**Philosophy:** Faster to write. Faster to run. Less code. More sprites. Define rules instead of writing callbacks.

**Pros:**
- Declarative rules instead of callbacks and state machines
- Velocity-driven animation (GPU picks direction, plays frames)
- 5,000 sprites at 60 FPS (one draw call per atlas)
- Animation, HP bars, labels, particles computed in GPU shaders
- Zero per-frame allocations
- 10K+ sprites still playable
- Zero dependencies
- Full TypeScript
- Pure WebGL2
- Clean game loop (no animation updates, collision checks, sound triggers)

**Cons:**
- 2D only (WebGL2)
- Different paradigm (rules vs callbacks)
- Newer project
- Less ecosystem

**Performance:**
- One draw call per atlas
- GPU computes animation frames
- CPU just uploads positions
- 60 FPS @ 5K sprites, 30+ FPS @ 10K sprites

**Use Case:** When you want Svelte-like "less code" philosophy for 2D games with GPU-first performance.

### Cubeforge
**Best for: React-first declarative 2D engine (Svelte philosophy: declarative, component-based)**

**Philosophy:** Build browser games with React. Your game is a React component tree.

**Pros:**
- Declarative (describe your world, not frame loop)
- Composable (game entities are React components)
- Lightweight (purpose-built ECS, physics, renderer, input)
- TypeScript-first
- Embeddable (drop into any React app)
- Debug-ready (collider wireframes, FPS, entity counts)
- Time-travel DevTools (frame scrubber, entity inspector)
- Deterministic mode for replays
- WebGL2 renderer with instanced GPU rendering
- Multiplayer package (@cubeforge/net) with rollback
- No heavy runtime deps

**Cons:**
- React dependency
- 2D only
- Newer project
- Requires React knowledge

**Performance:**
- Instanced GPU rendering
- Lightweight runtime
- Deterministic physics

**Use Case:** When you want Svelte-like declarative, component-based development but with React instead of Svelte.

### Estella
**Best for: WebAssembly-powered 2D engine with visual editor**

**Philosophy:** Fast 2D game engine powered by WebAssembly and ECS

**Pros:**
- C++ rendering pipeline compiled to WebAssembly (not interpreted JS)
- Type-safe TypeScript SDK
- ECS architecture (defineComponent, defineSystem, Query)
- Visual editor (scene hierarchy, inspector, asset browser)
- Cross-platform (web browsers + WeChat MiniGames)
- Built-in Spine animation and physics
- WebGL rendering in WebAssembly
- Single codebase, multiple targets

**Cons:**
- 2D only
- WebAssembly requirement
- Newer project
- Smaller community

**Performance:**
- C++/WebAssembly backend
- Fast rendering pipeline
- ECS for scalable game logic

**Use Case:** When you want WebAssembly performance with TypeScript DX and visual editor.

### KAPLAY.js
**Best for: Fast TypeScript game library for teaching and rapid prototyping**

**Pros:**
- JavaScript and TypeScript support
- Easy to create games for the web
- Good for teaching programming
- Fast and furious game development
- One of the best TypeScript libraries tried

**Cons:**
- Less feature-rich than full engines
- Smaller ecosystem
- Focused on 2D

**Performance:**
- Fast development
- Small bundle

**Use Case:** When you want Svelte-like fast development for simple 2D games.

## 3D Svelte-Like Engines

### Sprunk Engine
**Best for: Small, modular TypeScript 3D engine (Svelte philosophy: simple, small, extensible)**

**Philosophy:** A TypeScript game engine designed to be simple and small (50kb minified) but modular and extensible

**Pros:**
- Only 50kb once minified
- WebGPU 3D rendering engine
- 2D polygon physics engine
- Audio engine
- Input system (gamepads, keyboard, mouse)
- Dependency injection system
- Debugging tools
- Modular and extensible
- TypeScript throughout
- Vite build support

**Cons:**
- WebGPU only (browser support limited)
- Newer project
- Smaller community
- Less feature-rich than full engines

**Performance:**
- WebGPU-native rendering
- Small bundle (50kb)
- Modular (use only what you need)

**Use Case:** When you want a small, modular 3D engine with WebGPU and good TypeScript DX for a web shooter.

### Web Engine Dev
**Best for: Composable TypeScript engine ecosystem (Svelte philosophy: use what you need, swap what you want)**

**Philosophy:** A composable TypeScript engine ecosystem with 92+ packages. Use what you need, swap what you want.

**Pros:**
- 92+ independently usable packages
- Archetype-based ECS with SoA columnar storage
- Typed queries, dependency-based scheduling
- Parallel Web Worker execution
- TypeScript-native (branded types, discriminated unions)
- Zero-dependency core packages
- Interface-first design (swap subsystems without changing gameplay code)
- Data-oriented performance (cache-friendly, zero-allocation hot paths)
- GPU-driven rendering with instanced draw calls
- Full categories: Core (12), Rendering (12), Systems (17), Gameplay (5), Infrastructure (16), Meta (14)
- Swap from built-in physics to Rapier WASM by changing one import

**Cons:**
- Complex ecosystem (92+ packages to understand)
- More setup than monolithic engines
- Steeper learning curve
- Newer project

**Performance:**
- Archetype-based SoA columnar storage
- Cache-friendly iteration
- Zero-allocation hot paths
- Object pooling
- Batch math operations on typed arrays
- Parallel Web Worker execution

**Use Case:** When you want maximum flexibility and performance with TypeScript-native ECS, willing to learn a composable ecosystem for a 3D shooter.

### Apex Engine
**Best for: Multi-platform TypeScript 3D engine with low barrier to entry**

**Philosophy:** Lowering or removing the entry barrier for web developers who want to get into game development

**Pros:**
- Multi-platform (browser, desktop, NodeJS)
- TypeScript throughout
- Multithreading (renderer and physics in separate threads)
- Actor-Component framework
- Rapier physics integration
- Cross-platform compilation
- CLI scaffolder (npm create apex-game)
- AI in development
- Multiplayer planned

**Cons:**
- Alpha stage (APIs can change drastically)
- Not production-ready
- Smaller community
- Some features planned (audio, multiplayer)

**Performance:**
- Multithreaded renderer and physics
- Rapier physics engine
- Separate threads for performance

**Use Case:** When you want a TypeScript 3D engine with multithreading and are okay with alpha-stage software for a web shooter.

## Reddit Community Feedback & Pain Points

### Sprunk Engine
**Reddit Presence:** None found
**Pain Points:**
- No community discussion or feedback
- WebGPU-only (limited browser support, requires flags)
- Very new project with unknown stability
- No battle-tested examples

### Web Engine Dev
**Reddit Presence:** None found
**Pain Points:**
- No community discussion or feedback
- Complex ecosystem (92+ packages) = steep learning curve
- New project with unknown stability
- Overkill for simple projects
- Setup complexity

### Apex Engine (TypeScript)
**Reddit Presence:** Confusion with commercial Apex Engine (TGS.Tech)
**Pain Points:**
- **Alpha stage** - explicitly not production-ready
- APIs can change drastically or be removed
- Very small community
- Audio and multiplayer planned but not implemented
- AI in development
- High risk for production use

### Zephyr3D
**Reddit Presence:** Positive discussions on r/gameenginedevs (22 votes) and r/webgl (9 votes)
**Feedback:**
- "Easy to use and highly extensible"
- Active development with releases (v0.4.0)
- Command buffer reuse for WebGPU performance
- Shader builder for WebGL2/WebGPU praised on r/GraphicsProgramming
**Pain Points:**
- Smaller community than Three.js/Babylon
- Newer project (less battle-tested)
- Single maintainer

### Modu Engine (New Discovery)
**Reddit Presence:** None found (1 GitHub star)
**Features:**
- TypeScript-first multiplayer engine
- Three.js rendering
- Rapier 2D + 3D physics (WASM)
- Sandboxed JS scripting
- Client-side prediction
- Interest management (200 CCU)
- Delta compression (msgpack)
- Security hardened
**Pain Points:**
- No community feedback
- Very new (1 star)
- Unknown stability

### General Reddit Consensus
**Most Recommended for Web 3D:**
- **Three.js** - Most recommended, huge ecosystem, battle-tested
- **PlayCanvas** - Well-regarded for browser games, WebGPU support
- **Babylon.js** - Recommended for complex scenes, full-featured

**Pain Points with Newer Engines:**
- Lack of community support and documentation
- Unknown stability and longevity
- WebGPU browser support issues
- Over-engineering for simple use cases
- Alpha-stage software risks

**Recommendation for Your FPS (Pure IDE Development, No Editor Required):**
Given Reddit feedback and your requirement for pure IDE-based development (no editor), the production-ready options are:

**Code-First Full Game Engines (Production-Ready):**
1. **PlayCanvas** - You're already using it, can be used purely via code, full game engine features (physics, audio, networking), well-regarded, large community
2. **Babylon.js** - Full game engine, code-first approach, physics, audio, UI, well-regarded, large community

**Code-First Rendering + Ecosystem (Build Your Own Stack):**
3. **Three.js + ecosystem** - Most recommended on Reddit, largest community, combine with:
   - **Cannon.js/Rapier** for physics
   - **tinybuf/packcat** for serialization
   - **Rivalis/Rhubarb** for networking
   - **snapshot-interpolation** for FPS networking

**Experimental/Not Production-Ready:**
- **rundot-3d-engine** - Full game engine with ECS, but very small community, high risk
- **Zephyr3D** - TypeScript-first rendering engine with positive Reddit feedback, but not a full game engine
- **WesUnwin/three-game-engine** - Lightweight with Rapier, but 92 stars = not production-ready
- **make3d** - Minimal framework, tiny community
- **Threeverse** - Virtual experience engine, tiny community
- **Sprunk** - WebGPU-only, no community feedback, limited browser support
- **Web Engine Dev** - Complex 92+ package ecosystem, steep learning curve
- **Apex** - Alpha stage, not production-ready
- **Modu Engine** - Very new (1 star), no community feedback

**Bottom Line:** For a production FPS with pure IDE development, stick with PlayCanvas (already invested), Babylon.js, or Three.js + ecosystem. Everything else is too experimental or has too small a community.

## Three.js + Game Engine Frameworks (Game Engine Without Rendering)

### rundot-3d-engine
**Best for: Three.js-based game engine with ECS and full game systems**

**Pros:**
- Three.js-based with ECS architecture
- Rapier3D physics integration
- Dynamic navigation with A* pathfinding
- Advanced animation system with blending and retargeting
- 2D/3D audio system with music management
- Comprehensive UI system
- Camera systems (follow, free camera with smooth transitions)
- Asset loading (FBX, GLB, OBJ with skeleton caching)
- Flexible particle system
- Cross-platform input with mobile support
- TypeScript

**Cons:**
- Smaller community
- Newer project
- Less documentation than React Three Fiber ecosystem

**Use Case:** When you want a full game engine built on Three.js with ECS, physics, and comprehensive game systems.

### elixr
**Best for: WebXR framework with Three.js + Rapier + ECS**

**Pros:**
- Three.js + Rapier physics integration
- Powerful ECS architecture
- Easy-to-use WebXR scene setup
- Pre-built interaction systems (snap-turn, teleportation)
- Compatible with three.js plugins
- Lightweight and flexible
- GameObjects extend THREE.Object3D
- Customizable interaction systems

**Cons:**
- WebXR-focused (may be overkill for non-VR)
- Smaller community
- Newer project

**Use Case:** When building WebXR/VR experiences with Three.js and need physics + ECS.

### houseki
**Best for: Modular ECS framework combining web libraries**

**Philosophy:** Lightweight framework for combining independent libraries together via ECS

**Pros:**
- Modular architecture (pick and choose systems)
- ECS with multi-threading via WebWorkers
- WASM where available
- Packages: core, csm (shadows), gltf, input, orbit, physics (Rapier), player, portal, postprocessing, render (Three.js), scene, text
- Lightweight wrapper around underlying technologies
- Extendable (add your own systems)
- High performance from ECS + WebWorkers

**Cons:**
- Need to assemble the stack yourself
- More setup than monolithic engines
- Smaller community

**Use Case:** When you want to build your own stack with modular ECS components and Three.js rendering.

### awe (@oncyberio/awe)
**Best for: Three.js game engine with visual editor and full game systems**

**Pros:**
- Component-based scene architecture
- Rapier3D physics with high-level APIs
- VRM avatar support with springbone physics
- Composable player controls (FPS, TPS, platformer, top-down)
- Particle effects (three.quarks-based)
- Visual editor (gizmos, selection, transform controls)
- CLI tools (create-oncyber-app)
- TypeScript
- Next.js integration
- Asset pipeline (Draco, meshoptimizer, KTX2)

**Cons:**
- React/Next.js dependency
- More complex than pure Three.js
- Heavier than minimal stacks

**Use Case:** When you want a full game engine on Three.js with visual editor and React integration.

### react-three-fiber ecosystem
**Best for: React declarative Three.js with physics and game systems**

**Core: react-three-fiber**
- React renderer for Three.js
- Declarative scene building with JSX
- Reusable, self-contained components
- React ecosystem integration
- No overhead (renders outside React)
- Outperforms Three.js at scale

**Physics: @react-three/rapier**
- Rapier WASM physics wrapper
- Minimal friction API
- Automatic colliders
- Collision events
- Physics hooks for filtering

**Physics: @react-three/cannon**
- Cannon-es physics hooks
- Simple API (useBox, usePlane, etc.)
- Good for basic physics

**Game Engine: react-three-game**
- Batteries included game engine for R3F
- Prefab system (JSON-first, serializable)
- Prefab editor (visual editing)
- GameObject + component composition
- Direct runtime access to Three.js objects
- R3F native components
- GLB/GLTF import with collision meshes

**Cons:**
- React dependency
- JSX learning curve if not using React
- More abstraction than pure Three.js

**Use Case:** When you want React declarative development with Three.js and full game systems (physics, prefabs, editor).

### What People Do (Common Stacks)

**Stack 1: Three.js + Cannon.js/Rapier + Custom ECS**
- Three.js for rendering
- Cannon.js or Rapier for physics
- Custom ECS or simple component system
- Build your own game systems

**Stack 2: React Three Fiber + @react-three/rapier**
- React Three Fiber for declarative rendering
- @react-three/rapier for physics
- React ecosystem for state management
- Use existing R3F components (@react-three/drei)

**Stack 3: Modular ECS (Houseki) + Three.js**
- Houseki ECS for game logic
- Houseki physics (Rapier) for physics
- Houseki render (Three.js) for rendering
- Pick only the packages you need

**Stack 4: Full Game Engine (rundot/awe)**
- rundot-3d-engine or awe
- Everything included (ECS, physics, audio, UI, etc.)
- Three.js rendering under the hood
- Less setup, more opinionated

### WesUnwin/three-game-engine
**Best for: Lightweight Three.js game engine with Rapier physics and UI (No React)**

**Philosophy:** Simple, lightweight game engine tying together Three.js, Rapier, and three-mesh-ui

**Pros:**
- Actively maintained with releases
- Three.js + Rapier physics integration
- three-mesh-ui for 3D UI
- TypeScript/JavaScript support
- Webpack integration
- Highly readable source code
- 100% free and open-source
- VR support
- Lightweight and simple
- Rapid prototyping focus
- No React dependency

**Cons:**
- **Very small community (92 stars)** - Not production-ready for serious projects
- Less documentation than Three.js/Babylon
- No ECS architecture (component-based but not full ECS)
- Fewer features than full engines
- High risk for production use

**Performance:**
- Rapier WASM physics
- Three.js rendering
- Minimal overhead

**Use Case:** For learning/prototyping only. Not recommended for production due to tiny community.

### make3d
**Best for: Lightweight Three.js framework with game-oriented primitives (No React)**

**Philosophy:** Lightweight framework for 3D WebGL games, built on Three.js, providing game-oriented primitives

**Pros:**
- Lightweight framework
- Built on Three.js
- Game-oriented primitives (Level, Player, NPC)
- Simple physics integration (check2d)
- Input, camera, rendering utilities
- Debug utilities included
- Minimal structure, low abstraction overhead
- Efficient, mobile-friendly rendering
- No React dependency
- Scene graph managed by Three.js (no separate entity system)

**Cons:**
- Smaller project
- Less feature-rich than full engines
- Simple physics (check2d, not Rapier/Cannon)
- No ECS architecture
- Limited documentation

**Performance:**
- Efficient mobile-friendly rendering
- Simple collision detection
- Low abstraction overhead

**Use Case:** When you want minimal Three.js framework with game primitives and no overhead.

### Threeverse
**Best for: Lightweight Three.js virtual experience engine with asset loading (No React)**

**Philosophy:** Three.js-based virtual experience engine for loading and interacting with GLTF/GLB/FBX assets

**Pros:**
- Lightweight Three.js-based engine
- GLTF/GLB/FBX asset loading
- FPS-style navigation
- Physics-enabled objects
- Immersive open-world scenes
- Interactive virtual spaces
- No React dependency
- Browser-based
- Simple API

**Cons:**
- Smaller project
- Focused on virtual experiences (not general game engine)
- Limited documentation
- Physics via Cannon (not Rapier)
- No ECS architecture

**Performance:**
- Three.js rendering
- Cannon physics
- Efficient asset loading

**Use Case:** When you want to load 3D assets and create interactive virtual spaces with FPS navigation.

## Rust/WebAssembly Game Engines

### ThreeRust
**Best for: Commercial WebGPU engine with browser-native editor**

**Philosophy:** Browser-native 3D engine and editor combining WebGPU & WASM with full web platform

**Pros:**
- WebGPU renderer with PBR materials, HDRI, shadows, post-processing
- ECS architecture in Rust (cache-friendly, deterministic updates)
- Rapier3D physics integration
- GLTF skeletal and transform-track animation
- RHAI scripting (fast embedded language with Rust semantics)
- Full in-browser editor
- Web platform integration (Stripe payments, WebRTC, Web Workers, localStorage)
- Zero friction between creation and delivery
- Production-grade engine

**Cons:**
- WebGPU-only (limited browser support)
- Commercial product (not open source)
- Newer project
- Requires Chrome/Edge
- Pricing not disclosed

**Performance:**
- WebGPU rendering
- Rust/WASM core
- ECS data-oriented design

**Use Case:** When you want a commercial-grade WebGPU engine with in-browser editor and full web platform integration.

### nightshade
**Best for: Data-oriented Rust engine with WebGPU and browser editor**

**Philosophy:** Data-oriented 3D game engine in Rust, targeting native and web via WebGPU

**Pros:**
- Data-oriented design (freecs-backed ECS)
- WebGPU rendering (DX12/Metal/Vulkan/WebGPU)
- glTF-first PBR renderer with full KHR extension set
- Rapier3D physics
- Retained-mode UI
- Browser-playable scene editor
- Modular features (audio, physics, gamepad, navmesh, shell, gizmos, etc.)
- Cross-platform (Windows, macOS, Linux, Web)
- Dual-licensed (MIT/Apache-2.0)

**Cons:**
- WebGPU-only (limited browser support)
- Steeper learning curve (data-oriented design)
- Rust required
- Smaller community than JS engines

**Performance:**
- Data-oriented ECS (cache-friendly)
- WebGPU rendering
- WASM for web

**Use Case:** When you want a data-oriented Rust engine with WebGPU and browser editor.

### Galeon
**Best for: Rust ECS with Three.js rendering and WASM bridge**

**Philosophy:** Rust game engine with Three.js renderer - Rust owns engine logic, TypeScript only for browser APIs

**Pros:**
- Rust ECS core
- Three.js rendering (leverages Three.js ecosystem)
- WASM bridge (ECS snapshots → Three.js)
- Generational entity safety
- Fallback geometry for missing assets
- Desktop (Tauri/Electrobun) and web support
- React Three Fiber adapter available
- Shell-agnostic

**Cons:**
- Complex architecture (Rust + TypeScript bridge)
- Requires Rust knowledge
- Steeper learning curve
- Smaller community

**Performance:**
- Rust ECS (fast game logic)
- Three.js rendering (proven)
- WASM bridge (efficient data transfer)

**Use Case:** When you want Rust ECS performance with Three.js rendering flexibility.

### Fyrox
**Best for: Production-ready Rust engine with WebAssembly support**

**Philosophy:** Feature-rich, production-ready 2D/3D game engine in Rust with scene editor

**Pros:**
- Production-ready with comprehensive documentation
- PC (Windows, Linux, macOS) and Web (WebAssembly) support
- Modern 3D rendering pipeline
- Scene editor
- Rapier physics (advanced physics)
- 2D support
- Fast iterative compilation
- Classic object-oriented design
- Lots of examples
- Guide book available

**Cons:**
- Object-oriented design (not data-oriented)
- Rust required
- Steeper learning curve
- Smaller community than Unity/Godot

**Performance:**
- Rapier physics
- Modern rendering pipeline
- WebAssembly for web

**Use Case:** When you want a production-ready Rust engine with editor and web support.

### NovaEngine
**Best for: Simple Rust WebGPU engine (Learning/Prototyping)**

**Pros:**
- WebGPU rendering
- Rapier3D physics
- egui immediate mode UI
- Skeletal animation
- Simple API

**Cons:**
- **1 GitHub star** - Not production-ready
- Very new project
- Limited features
- No documentation

**Use Case:** For learning/prototyping only. Not recommended for production.

### Perigee
**Best for: Headless WASM 3D engine for cross-platform logic**

**Philosophy:** Headless realtime 3D engine focused on web - core logic in single WASM binary

**Pros:**
- Single portable WASM file for game logic
- Platform-agnostic (desktop, web, mobile, console)
- Same behavior across platforms
- No recompilation needed for new platforms
- Blender addon integration

**Cons:**
- **4 GitHub stars** - Not production-ready
- Headless (no rendering included)
- Requires WASM glue code
- Steeper learning curve

**Use Case:** When you want portable game logic in WASM and handle rendering separately. Not production-ready.

## Performance Benchmarks

### WebGPU vs WebGL

**Findings:**
- **WebGL is still better in many cases** - Babylon.js forum reports WebGL outperforming WebGPU in current implementations
- **WebGPU advantages** - Calculation shaders, compute capabilities, modern API
- **WebGPU limitations** - Browser support (Chrome/Edge only), immature implementations
- **Godot benchmarks** - Academic paper comparing WebGPU vs WebGL in Godot engine

**Recommendation:** For production, WebGL is safer. WebGPU is promising but not yet mature enough for production use.

### Binary Serialization Performance

**Browser Benchmarks (340MB NYC Citibike dataset):**
- **JSON** - Baseline, but native JSON.parse is fast
- **Bebop** - Outperforms JSON, designed for browsers
- **Avro** - Outperforms JSON (latest master branch with Uint8Array)
- **Protobuf.js** - Outperforms JSON after string decoding fix
- **MessagePack/CBOR** - Slower than JSON in browsers
- **JSBT** - 48-73x smaller than JSON for repetitive data, but slower for simple objects

**Node.js Benchmarks:**
- **JSON** - Still performs well (native implementation)
- **Protobuf.js** - 4.12s for 1M operations (faster than JSON's 9.17s)
- **Bebop** - Slower than JSON in Node.js
- **Pbf** - Order of magnitude faster than Protobuf.js, 88% smaller

**Recommendation:**
- For browsers: Bebop, Avro, or Protobuf.js for performance
- For repetitive data: JSBT for size (48-73x smaller)
- For simplicity: JSON is still competitive, especially with native implementations

### Physics Engine Performance

**Rapier vs Cannon vs Ammo:**
- **Rapier** - Faster than Cannon/Ammo due to WASM implementation
- **Rapier advantages** - Multithreaded, data-oriented, less incremental compilation
- **Cannon.js** - Pure JavaScript, slower than WASM engines
- **Ammo.js** - Port of Bullet Physics, WASM but older codebase

**Recommendation:** Rapier is the best choice for web physics performance.

## Deep Dive Recommendations

**For Production FPS:**
1. **PlayCanvas** - Already using, proven, large community, WebGL (safe)
2. **Babylon.js** - Proven, large community, WebGL (safe)
3. **Three.js + Rapier** - Largest community, best physics, build your own stack

**For Experimental/WebGPU:**
1. **ThreeRust** - Commercial WebGPU engine with editor (if budget allows)
2. **nightshade** - Data-oriented Rust engine with WebGPU (if you know Rust)
3. **Galeon** - Rust ECS + Three.js (if you want Rust performance with Three.js flexibility)

**For Maximum Performance (WASM):**
1. **Rapier physics** - Best physics performance
2. **Bebop/Avro/Protobuf.js** - Best serialization performance
3. **Rust engines** - Best overall performance but steep learning curve

**Bottom Line:** For a production FPS, stick with proven WebGL engines (PlayCanvas, Babylon.js, Three.js). Rust/WebGPU engines are promising but require Rust knowledge and have limited browser support.

## FPS Template Availability

### PlayCanvas - Excellent FPS Templates
**Official FPS Templates:**
- **FPS Project Starter Pack** - Official PlayCanvas project template
- **Multiplayer FPS Game Template** - Official multiplayer FPS template
- **Starter Kit: FPS** - Official starter kit (project #1117)
- **First Person Shooter Starter Kit** - Official tutorial with full guide

**Pros:**
- Multiple official FPS templates
- Official tutorials and documentation
- Multiplayer FPS template available
- Proven to work for FPS games
- Fastest prototyping (just clone and modify)

**Cons:**
- Requires PlayCanvas ecosystem

### Three.js - Good Community FPS Templates
**Community FPS Templates:**
- **ThreeJS_FPS_2.0** (Footprintarts) - Modular FPS with movement, shooting, physics, sound, animations
- **three-boilerplate** (n1md7) - FPS boilerplate with WASD, shooting animations, multiple weapons, flashlight
- **three-fps** (mohsenheydari) - FPS with ammo.js, pathfinding, ECS, NPC AI
- **threejs-first-person-shooter** (sugidaffection) - 13 stars, TypeScript FPS game
- **Threejs First Person Shooter Game Starter** (gist) - Single-file starter

**Pros:**
- Multiple community templates
- Modular architectures
- Various approaches (physics, ECS, etc.)
- TypeScript options available

**Cons:**
- No official Three.js FPS template
- Quality varies by author
- Need to evaluate each template

### Babylon.js - No Official FPS Template
**Status:**
- No official FPS template found
- Community demos exist but no official starter kit
- Reddit threads asking how to create FPS (indicates lack of official resources)

**Pros:**
- Full game engine capable of FPS
- Large community

**Cons:**
- No official FPS template
- Slower prototyping (build from scratch)

### rundot-3d-engine - No FPS Template
**Status:**
- No FPS template found
- General game engine only

**Cons:**
- No FPS-specific starter
- Slower prototyping

### nightshade - No FPS Template
**Status:**
- nightshade-template exists (general game template)
- No specific FPS template

**Cons:**
- No FPS-specific starter
- Requires Rust knowledge

### Rust/WebAssembly Engines - No FPS Templates
**Status:**
- ThreeRust, Galeon, Fyrox - No FPS templates found
- General game engines only

**Cons:**
- No FPS-specific starters
- Steeper learning curve

## FPS Template Recommendations

**For Fastest Prototyping:**
1. **PlayCanvas** - Multiple official FPS templates, multiplayer template available, official tutorials
2. **Three.js** - Multiple community templates, modular architectures, various approaches

**For Slower Prototyping:**
3. **Babylon.js** - No official FPS template, build from scratch
4. **rundot-3d-engine** - No FPS template, general engine only
5. **Rust engines** - No FPS templates, steep learning curve

**Recommendation:** PlayCanvas is the clear winner for FPS prototyping with official templates and multiplayer support. Three.js is second with good community templates.

## PlayCanvas Negative Opinions & Limitations

### Server Stability Issues
- **Frequent outages** - Server disconnects, AWS outages causing downtime (June 2025, June 2026)
- **Engine bugs** - pc.app = null errors breaking projects, import map issues recurring
- **500 errors** - Internal server errors when publishing projects
- **Editor disconnects** - VSCode extension and editor disconnecting every minute during outages

### Free Tier Limitations
- **No private projects** - Free tier only supports public projects (all code/assets hosted openly)
- **$15/month paywall** - Private projects require paid Personal plan
- **Community criticism** - Called "extreme greed" for requiring payment to secure projects
- **Piracy concerns** - Anyone can fork/copy projects on free tier, discouraging serious development

### Technical Limitations
- **Scene size limit** - 16MB JSON limit (Mongo limit), hard limit on scene hierarchy
- **No workaround** - Must split into multiple scenes for large projects
- **Corrupted entities** - Can cause inability to save/delete entities
- **WebGPU not mature** - WebGL2-first, WebGPU path still maturing (not production-ready for compute shaders)

### Editor & Workflow Issues
- **Cloud-only editor** - No offline editor, requires account and internet
- **Not ideal for Git workflow** - Optimized for cloud collaboration, not version control
- **Strange design choices** - Dev-exp headaches when getting into nitty gritty
- **ES6/TypeScript support delayed** - ES6 modules and TypeScript support was delayed (in progress as of 2024)
- **Documentation issues** - API docs tricky for beginners, not great logical order

### Community & Ecosystem
- **Smaller than Three.js** - 25K GitHub stars vs Three.js 110K (4x smaller)
- **Less ecosystem** - Fewer third-party tools and libraries
- **No games made** - Despite capabilities, very few actual games released
- **Editor not as powerful as Unity** - Less robust tools than Unity/Unreal

### Commercial Nature
- **Editor is commercial** - Engine is MIT, but hosted editor is paid product
- **Snap Inc ownership** - Acquired by Snap in 2017, corporate ownership concerns
- **Pricing model** - Free/Personal/Organization tiers, not fully open source workflow

### Developer Experience
- **JavaScript vs C#** - Some prefer C# (Unity) over JavaScript
- **Browser-based editor** - Some find Unity/Unreal-style editing in browser exhausting
- **Learning curve** - Entity-component system in cloud editor different from other engines
- **No React integration** - Doesn't integrate with React/Vue like Three.js does

### Summary of Complaints
- **Server reliability** - Occasional outages and bugs
- **Free tier restrictions** - No private projects without payment
- **Scene size limits** - Hard 16MB limit forces scene splitting
- **Cloud dependency** - No offline editor, requires internet
- **Smaller ecosystem** - Less community than Three.js
- **Commercial editor** - Paid product despite open source engine
- **WebGPU immature** - Not ready for production compute shaders

**Bottom Line:** PlayCanvas is excellent for FPS prototyping with official templates, but has real limitations: server stability issues, free tier restrictions (no private projects), scene size limits, cloud-only editor, and smaller ecosystem than Three.js. For production, consider whether these limitations are acceptable or if Three.js/Babylon.js might be better for long-term maintainability.

## Comparison: 3D Svelte-Like Approaches

| Engine | Philosophy | Bundle | Runtime | Best For |
|--------|-------------|--------|---------|----------|
| Sprunk | Simple, small, modular | 50kb | WebGPU | Small 3D games with WebGPU |
| Web Engine Dev | Composable ecosystem | Variable (use what you need) | Minimal | Maximum flexibility with ECS |
| Apex | Low barrier, multi-platform | Medium | Multithreaded | Cross-platform TypeScript 3D |
| Zephyr3D | TypeScript-first, modular | Modular | WebGL/WebGPU | Visual editor + flexibility |

## Comparison: Svelte-Like Approaches

| Engine | Philosophy | Runtime | Bundle | Best For |
|--------|-------------|---------|--------|----------|
| Bloom | Compile-time to native | None (native) | Small | Native games with web target |
| Glyft | Declarative GPU-first | Minimal WebGL2 | Zero deps | 2D games with GPU performance |
| Cubeforge | Declarative React components | React + lightweight | Small | React projects with games |
| Estella | WebAssembly + ECS | WebAssembly | Medium | Fast 2D with visual editor |
| KAPLAY.js | Fast TypeScript library | Minimal | Small | Teaching/prototyping 2D |

## Framework Comparison

### Server-Authoritative Frameworks

#### Colyseus
**Best for: Server-authoritative games with automatic state sync**

**Pros:**
- Automatic state synchronization via Schema classes
- Binary delta compression (only changes sent)
- Built-in matchmaking and room management
- Scales from 10 to 10,000+ CCU
- Battle-tested with commercial games
- Multi-platform clients (JS, Unity, Godot, Haxe, etc.)
- MIT licensed, free forever

**Cons:**
- Framework owns state (less control)
- Learning curve for Schema decorators
- Opinionated architecture

**Performance:**
- Tick rate: Configurable (typically 20-60Hz)
- Protocol: Binary delta compression
- Latency: Good for most games, not optimized for competitive FPS

**Use Case:** Good for your current Haxe project - has Haxe client support and would replace custom WebSocket server.

#### Rivalis
**Best for: Full control over wire protocol with minimal framework overhead**

**Pros:**
- Raw binary frames (you control everything)
- Simple model: Rooms + Actors
- Built-in rate limiting, backpressure, reconnection
- Origin allow-lists for security
- TypeScript-native, zero hidden dependencies
- MIT licensed, free forever
- Drops into any http.Server

**Cons:**
- No automatic state sync (you implement it)
- More manual work than Colyseus
- Newer, smaller community

**Performance:**
- Tick rate: Configurable
- Protocol: Typed binary {topic, payload}
- Latency: Excellent (minimal overhead)
- Rate limiting: 64KiB frame cap, 30/s token-bucket

**Use Case:** If you want maximum control and are comfortable implementing state sync yourself.

#### Nakama
**Best for: Games needing social features + multiplayer**

**Pros:**
- Rich feature set (chat, social, leaderboards built-in)
- Commercial company with enterprise support
- Multiple language SDKs (Go, C#, Java, JS)
- Scalable and battle-tested

**Cons:**
- More complex setup
- Commercial (free tier but paid for production)
- Heavier than needed for pure FPS

**Performance:**
- Tick rate: Configurable
- Protocol: WebSocket + custom binary
- Latency: Good, but not optimized for competitive FPS

**Use Case:** If your game needs social features beyond pure multiplayer.

### P2P / Rollback Netcode

#### CarverJS
**Best for: React + Three.js games with P2P multiplayer**

**Pros:**
- React-based (modern stack)
- P2P via WebRTC (no dedicated server)
- Three sync modes: events, snapshots, client prediction with rollback
- Free MQTT signaling (zero-config)
- Serverless architecture

**Cons:**
- React-only (not for vanilla JS)
- P2P limitations (NAT traversal, host migration)
- Newer, less battle-tested

**Performance:**
- Transport: WebRTC DataChannels
- Latency: Excellent (direct peer connections)
- Sync: Delta compression, client prediction with rollback

**Use Case:** If you want serverless architecture and are using React.

#### p2play-js
**Best for: TypeScript P2P games with sophisticated networking**

**Pros:**
- Dual DataChannels (fast unreliable + reliable)
- Global shared state management
- Delta updates + full snapshots
- Automatic host migration
- Per-peer latency monitoring
- Network simulation tools

**Cons:**
- P2P limitations (NAT, host migration complexity)
- Requires signaling server
- Smaller community

**Performance:**
- Transport: WebRTC DataChannels
- Channels: Separate unreliable (movement) and reliable (inventory)
- Latency: Excellent (direct connections)
- Sync: Hybrid (deltas + occasional full snapshots)

**Use Case:** If you want sophisticated P2P with TypeScript.

#### rollback-netcode
**Best for: Fighting games or competitive shooters needing frame-perfect sync**

**Pros:**
- True rollback netcode (GGPO-style)
- 4+ player support
- P2P via WebRTC
- Desync detection and recovery
- Transport-agnostic

**Cons:**
- Complex (rollback is hard to implement correctly)
- P2P limitations
- Requires deterministic game logic
- Fighting game focused

**Performance:**
- Sync: Frame-perfect rollback
- Latency: Near-zero with rollback
- Determinism required: Yes

**Use Case:** If you need fighting-game level synchronization (probably overkill for typical FPS).

### Modern Game Engines with Networking

#### Murow
**Best for: High-performance TypeScript games with WebGPU**

**Pros:**
- TypeScript throughout
- ECS architecture (data-oriented)
- WebGPU rendering (GPU compute, zero-copy)
- Built-in netcode (snapshot sync, prediction, rollback)
- GPU-native rendering
- Modern, cutting-edge

**Cons:**
- WebGPU support (not all browsers yet)
- Newer, less documentation
- Complex architecture

**Performance:**
- Tick rate: Configurable
- Rendering: WebGPU (GPU compute)
- Netcode: Snapshot sync, prediction, rollback
- Latency: Excellent (modern architecture)

**Use Case:** If you want cutting-edge performance and are okay with WebGPU requirements.

#### Lagless
**Best for: Deterministic multiplayer with rollback**

**Pros:**
- Deterministic ECS framework
- Rollback netcode built-in
- WASM-based deterministic math
- Relay multiplayer (server relays inputs only)
- TypeScript + Bun for performance

**Cons:**
- Complex (determinism is hard)
- Newer, smaller community
- Requires deterministic game logic

**Performance:**
- Tick rate: 60Hz (configurable)
- Determinism: Yes (required)
- Netcode: Rollback with relay server
- Latency: Excellent with rollback

**Use Case:** If you need deterministic simulation and rollback.

#### Modu Engine
**Best for: TypeScript games with client-side prediction**

**Pros:**
- TypeScript throughout
- Three.js rendering
- Rapier physics (WASM-based)
- Client-side prediction + reconciliation
- Interest management
- Single-player development mode
- Security hardened (rate limiting, input validation)

**Cons:**
- Newer, less battle-tested
- Opinionated architecture
- Smaller community

**Performance:**
- Tick rate: Configurable
- Prediction: Client-side with reconciliation
- Interpolation: Entity interpolation
- Latency: ~0ms for local player, ~50-100ms for others

**Use Case:** If you want a complete engine with prediction built-in.

#### Javelin
**Best for: ECS-based games needing networking toolkit**

**Pros:**
- ECS architecture
- Efficient networking protocol
- High-precision game loop
- Modular (bring your own transport)
- TypeScript

**Cons:**
- You bring your own transport (WebSockets, WebRTC, etc.)
- More assembly required
- No built-in server

**Performance:**
- Architecture: ECS
- Protocol: Efficient binary
- Tick rate: High-precision loop
- Latency: Depends on transport you choose

**Use Case:** If you want ECS and efficient networking but don't need a full framework.

### DIY: Socket.io + Custom

**Best for: Maximum control with minimal dependencies**

**Pros:**
- Maximum control over everything
- No framework opinions
- You know exactly what's happening
- Can optimize for your specific needs

**Cons:**
- You implement everything (state sync, prediction, interpolation)
- More development time
- More potential for bugs
- What you're currently doing

**Performance:**
- Depends entirely on your implementation
- Can be excellent if done well
- Can be terrible if done poorly

**Use Case:** If you have the expertise and time to implement everything yourself.

## Performance Comparison

| Framework | Tick Rate | Prediction | Rollback | Protocol | Latency |
|-----------|-----------|-------------|----------|----------|---------|
| Colyseus | 20-60Hz | No | No | Binary delta | Good |
| Rivalis | Configurable | No | No | Binary | Excellent |
| CarverJS | Configurable | Yes | Yes | WebRTC | Excellent |
| p2play-js | Configurable | No | No | WebRTC | Excellent |
| rollback-netcode | 60Hz | Yes | Yes | WebRTC | Near-zero |
| Murow | Configurable | Yes | Yes | Custom | Excellent |
| Lagless | 60Hz | Yes | Yes | Custom | Excellent |
| Modu Engine | Configurable | Yes | No | Custom | Good |
| Javelin | High-precision | You implement | You implement | Efficient | Depends |
| DIY | You choose | You implement | You implement | You choose | Depends |

## Recommendations for FPS Games

### For Competitive FPS (Krunker-like)

**Top Pick: Rivalis or DIY with MessagePack**

**Why:**
- Minimal overhead for lowest latency
- Full control over protocol (can optimize like Krunker)
- Binary protocol (like Krunker's MessagePack)
- Built-in rate limiting and security
- No framework overhead

**Alternative: Colyseus**
- If you want automatic state sync
- Faster development
- Good enough for most FPS games
- Has Haxe client support

### For Casual FPS

**Top Pick: Colyseus or Modu Engine**

**Why:**
- Faster development
- Built-in features (matchmaking, state sync)
- Good performance for casual play
- Less complexity

### For Experimental/Cutting-Edge

**Top Pick: Murow or Lagless**

**Why:**
- Modern architecture (ECS, WebGPU)
- Built-in advanced netcode
- Future-proof
- Excellent performance

## Key Techniques for Tight FPS Gameplay

### 1. Binary Serialization
Use MessagePack or custom binary protocol instead of JSON:
- Smaller packets (less bandwidth)
- Faster serialization/deserialization
- Krunker uses MessagePack

### 2. Client-Side Prediction
Apply inputs immediately on client:
- Eliminates input latency feel
- Reconcile with server state
- Critical for responsive FPS

### 3. Interpolation
Smooth remote player movement:
- Render between received snapshots
- 50-100ms delay for smoothness
- Essential for good feel

### 4. Delta Compression
Only send changes, not full state:
- Reduces bandwidth
- Colyseus does this automatically
- Implement manually in DIY

### 5. Rate Limiting
Don't send too fast:
- Krunker rate limits network messages
- Typical: 20-60Hz for position updates
- Batch updates if needed

### 6. Lag Compensation
Server rewinds time for hit detection:
- "Favor the shooter"
- Critical for fair hit registration
- Complex to implement correctly

## Migration Path from Current Haxe Project

### Option 1: Keep Haxe, Switch to Colyseus Server
- Replace custom WebSocket server with Colyseus
- Use Colyseus Haxe client
- Minimal client changes
- Automatic state sync

### Option 2: Migrate to TypeScript + Rivalis
- Rewrite client in TypeScript (Three.js)
- Use Rivalis for server
- More work but modern stack
- Better long-term maintainability

### Option 3: Keep Current, Optimize
- Switch to MessagePack from JSON
- Implement client-side prediction
- Add interpolation
- Optimize update rates

## Conclusion

For a Krunker-like FPS game:

**Best Overall: Rivalis**
- Minimal overhead
- Full control
- Binary protocol
- Built-in security
- MIT licensed

**Best for Speed: Colyseus**
- Faster development
- Automatic state sync
- Haxe client support
- Battle-tested

**Best for Learning: DIY + MessagePack**
- Understand everything
- Optimize specifically for your game
- What you're already doing (just optimize)

**Avoid for FPS:**
- Nakama (too heavy, focused on social)
- Photon (Unity-focused, overkill)
- Firebase (not designed for fast-paced games)

The key is low latency and tight control - frameworks that add overhead or opinionated state management may not be ideal for competitive FPS where every millisecond matters.
