# Naia Framework Analysis Report

**Date:** 2026-06-23  
**Scope:** Naia multiplayer networking library for Rust, evaluation for FPS game server migration

---

## Executive Summary

Naia is a Rust-based networking library that implements the Tribes 2 networking model with modern optimizations. It provides **built-in lag compensation** through its Historian system, TickBuffered channels for client-side prediction, and ECS-agnostic entity replication. For FPS games requiring "instant shoot, instant hit" feel regardless of ping, Naia offers the most complete out-of-the-box solution among evaluated frameworks.

**Recommendation:** Strong candidate for FPS games requiring client-side hit registration and lag compensation. Requires Rust adoption but provides critical networking primitives that would need custom implementation in TypeScript frameworks.

---

## What is Naia?

Naia is a cross-platform networking library built in Rust that enables:
- Server-authoritative entity replication
- Typed message passing
- UDP (native) and WebRTC (browser) transport
- ECS-agnostic design (works with Bevy, macroquad, or custom ECS)

**Key Design Philosophy:** Define a shared Protocol (compile-time list of replicated components, messages, channels) that both server and client agree on. Naia handles the networking synchronization automatically.

---

## Core Architecture

### 1. Shared Protocol

Both server and client build from the same Protocol definition:

```rust
Protocol::builder()
    .add_component::<Position>()
    .add_component::<Velocity>()
    .add_component::<Health>()
    .add_message::<PlayerInput>()
    .add_message::<ShotEvent>()
    .add_channel::<InputChannel>(ChannelMode::TickBuffered(Default::default()))
    .tick_interval(Duration::from_millis(50)) // 20 Hz
    .build()
```

**Benefits:**
- Compile-time type safety
- Protocol hash mismatch during handshake causes rejection
- Single source of truth for data structures

### 2. Entity Replication

- Server spawns entities, attaches replicated components
- Assigns users to rooms (coarse membership groups)
- Calls `send_all_packets` every tick
- Naia diffs changed fields and delivers to in-scope clients automatically
- Client receives spawn/update/despawn events with current server-side values

**Scope Management:**
- Room membership (coarse) - players in same match
- UserScope (fine-grained) - entities within viewport/interest area

### 3. Authority Delegation

Server can delegate authority over specific entities to clients:
- Client requests write authority
- Server grants or denies
- Server can revoke at any time
- Server retains final ownership

**Use Case:** Vehicle control, physics objects, temporary client-side prediction

### 4. Channel Types

| Mode | Ordering | Reliability | Typical Use |
|------|----------|-------------|-------------|
| UnorderedUnreliable | None | None | Fire-and-forget telemetry |
| SequencedUnreliable | Newest-wins | None | Position updates (drop stale) |
| UnorderedReliable | None | Guaranteed | One-off notifications |
| OrderedReliable | FIFO | Guaranteed | Chat, game events |
| TickBuffered | Per tick | Guaranteed | Client input (tick-stamped) |
| Bidirectional + Reliable | FIFO | Guaranteed | Requests and responses |

---

## Critical Feature: Lag Compensation (Historian)

### The Problem

In server-authoritative games, clients render the world in the past (RTT/2 + interpolation_buffer). When a client fires, the server has advanced by RTT/2 ticks. Testing against current server state causes shots to miss even though visually accurate on client.

### Naia's Solution: Historian

**Rolling per-tick snapshot buffer** that enables server rewinding:

```rust
// Enable historian at startup
server.enable_historian(64); // 64 ticks of history

// Record snapshots each tick (after game state mutation)
server.record_historian_tick(&world, current_tick);

// When client fires, rewind to their view
fn handle_fire(server: &Server<E>, shooter: GlobalEntity, fire_tick: Tick) {
    let world_at_fire = server.historian().snapshot_at_tick(fire_tick);
    // Perform hit detection against world_at_fire
    // This is exactly what client saw when they fired
}
```

### Configuration Options

**Component Filtering:**
```rust
// Only snapshot components needed for hit detection
server.enable_historian_filtered(
    64,
    [ComponentKind::of::<Position>(), ComponentKind::of::<Health>()],
);
```

**Choosing max_ticks:**
| Tick Rate | Target Max Lag | max_ticks |
|-----------|---------------|------------|
| 20 Hz     | 500 ms        | 10         |
| 20 Hz     | 3 s (generous) | 64       |
| 60 Hz     | 200 ms        | 12         |
| 60 Hz     | 500 ms        | 30         |

**Memory Cost:** `max_ticks × entity_count × component_count × avg_component_size`

### This Solves the FPS Requirement

- Client fires at tick X
- Server rewinds to tick X
- Hit detection performed against state client actually saw
- "If you hit on your screen, you hit them" - regardless of ping
- Works with 200ms+ lag as long as within max_ticks buffer

---

## Critical Feature: TickBuffered Channels

### Purpose

TickBuffered channels deliver client input at the correct server tick for prediction and rollback.

### How It Works

1. Client inputs are tick-stamped when sent
2. Server buffers them
3. Delivers via `receive_tick_buffer_messages(tick)` when server tick matches
4. Enables tick-accurate input replay

### Prediction and Rollback

```rust
// Client maintains input history
CommandHistory<M> stores input history

// Server replay:
// 1. Apply server's authoritative update
// 2. Replay buffered client inputs on top
// 3. Result is predicted state
```

**Documentation:** Complete step-by-step prediction loop in `docs/PREDICTION.md`

---

## Platform Support

| Target | Transport | Notes |
|--------|-----------|-------|
| Linux / macOS / Windows | UDP | `naia-socket-native` |
| Browser (wasm32) | WebRTC data channel | Enable `wbindgen` feature |
| iOS / Android (native) | — | Not yet supported |
| iOS / Android (WebView) | WebRTC data channel | Same build as browser |

**Important:** Server always runs natively. Only client needs WebRTC for browser targets.

---

## Comparison with Current Implementation

### Current TypeScript Server

**Strengths:**
- Custom binary protocol with delta compression
- Lag compensation (500ms rewind buffer)
- Position validation (three-tier: accept/nudge/snap)
- Modular server architecture
- uWebSockets for performance

**Critical Gaps:**
- Server-authoritative input processing is incomplete (stub)
- Client-side prediction snaps without input replay
- Lag compensation limited (500ms buffer, 100ms tolerance)
- No built-in Historian system
- Manual implementation required for all prediction/rollback

### Naia's Advantages

**Built-in Features:**
- Historian for lag compensation (production-ready)
- TickBuffered channels for prediction
- Entity replication with automatic delta compression
- Authority delegation system
- Type-safe protocol definition

**Performance:**
- Rust performance (zero-cost abstractions)
- Efficient binary serialization
- ECS-agnostic (works with any entity system)
- WebRTC support for browser clients

**Developer Experience:**
- Compile-time type safety
- Single protocol definition
- Automatic state synchronization
- Comprehensive documentation

### Migration Complexity

**High:**
- Language change (TypeScript → Rust)
- ECS integration required (Bevy, macroquad, or custom)
- Client SDK integration (Rust client or WASM)
- Different architectural patterns

**Medium:**
- Protocol concepts similar (rooms, state sync)
- Networking principles transferable
- Game logic can be ported

---

## Comparison with Other Frameworks

### vs Colyseus (TypeScript/Node.js)

**Colyseus Advantages:**
- TypeScript (no language change)
- Built-in state synchronization
- Authentication module (@colyseus/auth)
- Matchmaking included
- Multi-platform SDKs

**Colyseus Gaps:**
- Lag compensation must be implemented manually
- Client-side prediction must be implemented manually
- Server-authoritative input processing must be implemented manually
- No built-in Historian system

**Naia Advantages:**
- Built-in lag compensation (Historian)
- TickBuffered channels for prediction
- Better performance (Rust vs Node.js)
- More sophisticated networking model

### vs GoWorld (Go)

**GoWorld Advantages:**
- Hot-swappable game logic
- Entity framework with AOI support
- Distributed architecture
- KCP protocol for low latency

**GoWorld Gaps:**
- No built-in lag compensation
- No built-in prediction system
- Hot-reload doesn't work on Windows
- Less mature documentation

**Naia Advantages:**
- Production-ready lag compensation
- Better browser support (WebRTC)
- More comprehensive documentation
- ECS-agnostic design

---

## Implementation Considerations

### Server Architecture

**Required Components:**
1. Protocol definition (shared between server/client)
2. ECS integration (Bevy recommended for Rust)
3. Room management (or use Naia's built-in rooms)
4. Game loop with tick-based updates
5. Historian enablement for lag compensation
6. Input handling via TickBuffered channels

**Example Server Structure:**
```rust
// main.rs
let mut server = Server::new(&socket, &protocol);
server.enable_historian(64);

loop {
    // Receive messages
    for (user, message) in server.receive_all(&mut world) {
        handle_message(&mut server, &mut world, user, message);
    }
    
    // Game simulation
    game_tick(&mut world);
    
    // Record historian snapshot
    server.record_historian_tick(&world, current_tick);
    
    // Send state updates
    server.send_all_packets(&world);
    
    // Advance tick
    server.take_tick_events();
}
```

### Client Architecture

**Options:**
1. **Rust Native Client** - Full Rust client with naia-client
2. **WASM Client** - Compile to WebAssembly for browser
3. **Hybrid** - Rust server + TypeScript client (requires custom protocol bridge)

**WASM Client Example:**
```rust
// Build with wasm-pack
// Uses WebRTC data channel for transport
let mut client = Client::new(&socket, &protocol);
client.connect("server_address");

// Receive entity updates
for (entity_type, entity) in client.receive_entity_updates(&mut world) {
    // Handle spawn/update/despawn
}

// Send input via TickBuffered channel
client.send_message::<InputChannel>(&player_input);
```

### ECS Integration

**Recommended: Bevy Engine**
- Mature ECS for Rust
- Naia has official Bevy adapter (`naia-bevy-server`, `naia-bevy-client`)
- Good documentation and community
- Performance-oriented

**Alternative: Custom ECS**
- Naia is ECS-agnostic
- Works with any entity type that is `Copy + Eq + Hash + Send + Sync`
- More flexibility but more work

---

## Pros and Cons

### Pros

**For FPS Games:**
- Built-in lag compensation (Historian) - critical for "instant hit" feel
- TickBuffered channels for client-side prediction
- Works regardless of ping (within max_ticks buffer)
- Authority delegation for temporary client control

**Technical:**
- Rust performance and safety
- Compile-time type safety
- Automatic delta compression
- ECS-agnostic design
- WebRTC support for browser clients
- Comprehensive documentation

**Architecture:**
- Single protocol definition
- Automatic state synchronization
- Room-based scalability
- Per-entity priority and bandwidth control

### Cons

**Migration:**
- Language change (TypeScript → Rust)
- Learning curve for Rust
- ECS integration required
- Different architectural patterns

**Limitations:**
- Client-side prediction must be implemented by user (Naia provides data, not logic)
- Snapshot interpolation not built-in
- iOS/Android native support not yet available
- Smaller community compared to Node.js frameworks

**Operational:**
- Rust ecosystem smaller than Node.js
- Fewer hosting options optimized for Rust game servers
- Debugging can be more complex

---

## Specific FPS Game Requirements Analysis

### Requirement: "Instant Shoot, Instant Hit"

**Naia Solution:**
- Historian rewinds server to client's view when they fire
- Hit detection performed against historical state
- Works with high ping (200ms+) as long as within max_ticks
- **Status:** ✅ Built-in, production-ready

### Requirement: Client-Side Prediction

**Naia Solution:**
- TickBuffered channels deliver input at correct server tick
- CommandHistory stores input for replay
- Rollback-and-replay foundation provided
- **Status:** ✅ Data structures provided, game logic implementation required

### Requirement: Bandwidth Efficiency

**Naia Solution:**
- Automatic delta compression (Property<> wrapper)
- Per-entity priority and bandwidth control
- Configurable tick rate
- SequencedUnreliable for position updates (drop stale)
- **Status:** ✅ Built-in

### Requirement: Anti-Cheat

**Naia Solution:**
- Server-authoritative by default
- Authority delegation controlled by server
- Type-safe protocol prevents protocol abuse
- **Status:** ✅ Architecture supports, game-specific validation required

### Requirement: Browser Support

**Naia Solution:**
- WebRTC data channel for WASM clients
- Same build for browser and mobile WebView
- **Status:** ✅ Built-in

---

## Recommendations

### For Current Project

**Option 1: Migrate to Naia (Recommended for FPS Focus)**
- **Best if:** FPS gameplay is core priority, lag compensation critical
- **Effort:** High (4-8 weeks for full migration)
- **Benefits:** Production-ready lag compensation, excellent performance
- **Risks:** Rust learning curve, ECS integration complexity

**Option 2: Enhance Current TypeScript Server**
- **Best if:** TypeScript expertise exists, gradual improvement preferred
- **Effort:** Medium (2-4 weeks for critical fixes)
- **Benefits:** No language change, incremental improvement
- **Risks:** Must implement lag compensation from scratch

**Option 3: Use Colyseus**
- **Best if:** TypeScript preference, want framework with more features
- **Effort:** Medium (3-5 weeks for migration)
- **Benefits:** TypeScript, built-in state sync, authentication
- **Risks:** Must implement lag compensation from scratch

### Migration Path to Naia

**Phase 1: Prototype (1-2 weeks)**
- Set up Naia server with Bevy
- Implement basic room with entity replication
- Test Historian with simple hit detection
- Evaluate performance

**Phase 2: Core Game Logic (2-3 weeks)**
- Port player movement and physics
- Implement TickBuffered input handling
- Add client-side prediction
- Integrate Historian for lag compensation

**Phase 3: Client Integration (2-3 weeks)**
- Set up WASM client or maintain TypeScript client with protocol bridge
- Implement entity replication on client
- Add interpolation and prediction
- Test hit registration with various ping levels

**Phase 4: Polish (1-2 weeks)**
- Optimize bandwidth usage
- Add rate limiting
- Implement anti-cheat validation
- Performance testing

**Total Estimated Effort:** 6-10 weeks

---

## Conclusion

Naia is the strongest candidate among evaluated frameworks for FPS games requiring client-side hit registration and lag compensation. Its built-in Historian system and TickBuffered channels provide the exact networking primitives needed for "instant shoot, instant hit" gameplay regardless of ping.

The primary tradeoff is the requirement to adopt Rust and an ECS architecture. For teams willing to make this investment, Naia provides production-ready solutions to the most challenging FPS networking problems that would require significant custom implementation in TypeScript frameworks.

**Key Decision Factor:** If lag compensation and client-side prediction are critical requirements, Naia's built-in solutions may justify the migration effort. If these can be implemented incrementally in the current TypeScript codebase, staying with TypeScript may be more pragmatic.

---

## Resources

- **GitHub:** https://github.com/naia-rs/naia
- **Concepts Guide:** https://github.com/naia-rs/naia/blob/main/docs/CONCEPTS.md
- **Prediction Guide:** https://github.com/naia-rs/naia/blob/main/client/docs/PREDICTION.md
- **API Docs:** https://docs.rs/naia-server
- **Tribes 2 Networking Model:** https://www.gamedevs.org/uploads/tribes-networking-model.pdf
