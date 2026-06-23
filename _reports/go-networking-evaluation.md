# Go Networking Libraries Evaluation for Future Consideration
## Multiplayer FPS Game Server Options

**Date**: 2026-06-23  
**Purpose**: Document Go networking libraries for potential future migration or new projects

---

## Executive Summary

After researching Go networking libraries for multiplayer FPS games, I found several options but **none provide the Tribes 2-style networking features** (state masks, bit-packing, partial updates, scoping) out of the box. While Go offers excellent performance and concurrency, the available game networking frameworks either:

1. Lack the specific features we need
2. Require incompatible client stacks (C#/Unity instead of TypeScript/Three.js)
3. Would require significant custom implementation regardless

**Current recommendation**: Stick with TypeScript for this project, but keep Go in mind for future projects where a fresh start is feasible.

---

## Libraries Evaluated

### 1. nano
**Repository**: https://github.com/lonng/nano  
**Type**: Lightweight game server framework

**Features:**
- Component-based architecture
- WebSocket support
- Distributed system support
- Handler-based message processing
- Session management
- Built-in asynchronous task execution

**Pros:**
- Lightweight and fast
- Good documentation
- Active community
- Suitable for real-time games
- Easy to use

**Cons:**
- No state mask system
- No bit-packing for bandwidth optimization
- No partial state updates
- No scoping/prioritization
- No client prediction built-in
- Would require implementing Tribes 2 features from scratch

**Suitability for FPS**: Moderate - good foundation but missing key features

---

### 2. gogs
**Repository**: https://github.com/metagogs/gogs  
**Type**: Protobuf-based game server framework

**Features:**
- Code generation from protobuf files
- WebSocket + WebRTC DataChannel support
- Three encoding types (JSON, JSON with header, Protobuf)
- Protocol header system (8 bytes)
- Rate limiting
- Snowflake ID generation

**Pros:**
- Supports both WebSocket and WebRTC
- Protobuf for efficient serialization
- Code generation reduces boilerplate
- WebRTC support for low-latency unreliable transport
- Modern and actively maintained

**Cons:**
- Requires learning their framework
- No state mask system
- No bit-packing (relies on Protobuf)
- No partial state updates
- No scoping/prioritization
- No client prediction
- Protocol tied to their framework

**Suitability for FPS**: Moderate - WebRTC support is good, but framework lock-in

---

### 3. BoomNetwork
**Repository**: https://github.com/boomlulu/BoomNetwork  
**Type**: Frame synchronization framework

**Features:**
- Frame sync at 20fps
- Frame-embedded events (PlayerJoined/Left/Offline/Online/HostChanged)
- Automatic host management with failover
- Two-level reconnection (fast catchup + snapshot recovery)
- Entity authority synchronization with Dead Reckoning
- Lightweight state synchronization (KV Store)
- Frame hash validation for desync detection
- Dual transport protocols (TCP stable / KCP low-latency)
- Admin tools (HTTP + WebSocket for monitoring)
- Zero-allocation hot paths

**Pros:**
- **Best feature set for FPS games**
- Frame synchronization proven in production
- Comprehensive reconnection handling
- Entity authority system
- Frame hash validation prevents desyncs
- Zero-allocation for performance
- Multiple demo projects (Minecraft, Vampire Survivors, Tower Defense)
- 20-minute stability tests pass

**Cons:**
- **C# client + Go server** (not TypeScript!)
- Requires Unity UPM package
- Would require complete client rewrite
- No rollback (uses frame sync instead)
- Tied to their specific architecture

**Suitability for FPS**: Excellent - but wrong client stack

**Demo Projects:**
- HelloWorld: Basic connection + frame sync
- RoomLobby: Room management
- ChatRoom: Lightweight state sync
- StateSyncMove: KV state synchronization
- Reconnect: Two-level reconnection
- EntitySync: Entity authority + Dead Reckoning
- AuthorityTransfer: Authority transfer protocol
- MinecraftDemo: Hybrid sync (frame + entity + snapshot)
- VampireSurvivors: Pure frame sync (512 entities)
- TowerDefense: Multiplayer frame sync tower defense

---

### 4. necs
**Repository**: https://github.com/sparsereproce/necs  
**Type**: Networked Entity Component System

**Features:**
- Automatic ECS world synchronization
- Entity filtering for clients
- Type-safe network event handling
- Works in WASM
- Built on Donburi ECS

**Pros:**
- ECS-based (modern game architecture)
- Automatic synchronization
- Type-safe
- WASM support

**Cons:**
- Requires Donburi ECS (Go game engine)
- Not compatible with Three.js
- No state mask system
- No bit-packing
- No Tribes 2 features

**Suitability for FPS**: Poor - requires Go game engine, not Three.js

---

### 5. gorilla/websocket
**Repository**: https://github.com/gorilla/websocket  
**Type**: Basic WebSocket library

**Features:**
- Pure WebSocket implementation
- Passes Autobahn test suite
- Well-documented
- Widely used

**Pros:**
- Simple and reliable
- Good performance
- Extensive documentation
- Large community

**Cons:**
- **Archived** (no longer maintained)
- No game-specific features
- Would need to build everything from scratch
- coder/websocket recommended for new projects

**Suitability for FPS**: Poor - just WebSocket, no game features

---

### 6. coder/websocket
**Repository**: https://github.com/coder/websocket  
**Type**: Modern WebSocket library

**Features:**
- Context.Context support for cancellation
- Safe concurrent writes
- Actively maintained
- Passes Autobahn test suite

**Pros:**
- Modern and maintained
- Good performance
- Context support
- Safe concurrency

**Cons:**
- No game-specific features
- Would need to build everything from scratch

**Suitability for FPS**: Poor - just WebSocket, no game features

---

## Performance Comparison

Based on research and benchmarks:

**WebSocket Libraries:**
- coder/websocket: Best performance for new projects
- gorilla/websocket: Good but archived
- Both handle high concurrency well

**Go vs Node.js:**
- Go can match or exceed Node.js for WebSocket handling
- Go's goroutine-per-connection model is natural for game servers
- Lower memory footprint than Node.js
- Better CPU utilization

**WebRTC Performance:**
- WebRTC has higher latency than raw UDP due to protocol stack complexity
- WebTransport outperforms WebRTC and WebSockets
- Go WebRTC libraries (pion/webrtc) are mature but complex

---

## Tribes 2 Feature Gap Analysis

| Feature | nano | gogs | BoomNetwork | necs | gorilla | coder |
|---------|------|------|-------------|------|---------|-------|
| State Masks | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Bit-packing | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Partial Updates | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Scoping | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Prioritization | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Client Prediction | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Frame Sync | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| WebRTC | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Protobuf | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Entity Authority | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Reconnection | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |

**Conclusion**: No library provides Tribes 2 features out of the box. BoomNetwork has the best game features but requires C#/Unity client.

---

## Implementation Effort Comparison

### TypeScript (Current Approach)
**Existing Infrastructure:**
- ✅ uWebSockets.js server
- ✅ BinaryProtocol with msgpack
- ✅ MessageTypes
- ✅ BitStream (just implemented)
- ✅ WebSocketConnection (just implemented)
- ✅ Client and server share TypeScript code

**Remaining Work:**
- Event Manager (guaranteed/non-guaranteed)
- Sequence numbering and ACK system
- Ghost Manager with state masks
- Scoping system
- Client prediction
- Testing

**Estimated Effort**: 2-3 days

### Go with Existing Library
**Required Work:**
- Learn Go (if not already known)
- Learn framework (nano/gogs)
- Implement state masks (custom)
- Implement bit-packing (custom)
- Implement partial updates (custom)
- Implement scoping (custom)
- Implement client prediction (custom)
- Rewrite client protocol code (no code sharing)
- Set up Go build system
- Set up deployment

**Estimated Effort**: 1-2 weeks

### Go with BoomNetwork
**Required Work:**
- Learn Go (if not already known)
- **Rewrite entire client to C#/Unity**
- Abandon Three.js
- Abandon TypeScript
- Learn BoomNetwork framework
- Integrate Unity UPM package
- Port all game logic to Unity

**Estimated Effort**: 1-2 months (complete rewrite)

---

## When to Consider Go for Future Projects

### Good Candidates for Go:

1. **New Project with Clean Slate**
   - Starting from scratch
   - No existing client code
   - Can choose Unity/C# or Go game engine

2. **High-Performance Requirements**
   - 100+ players per server
   - Complex physics simulation
   - Need maximum CPU efficiency

3. **Team Expertise**
   - Team already knows Go
   - Comfortable with microservices
   - Want to use Go ecosystem

4. **BoomNetwork Use Case**
   - Frame synchronization fits game design
   - Willing to use Unity/C# client
   - Need proven production framework

### Poor Candidates for Go:

1. **Existing TypeScript/Three.js Project**
   - Would require complete rewrite
   - Can't share code between client/server
   - Significant context switching

2. **Rapid Prototyping**
   - TypeScript faster to iterate
   - Shared code reduces duplication
   - Hot reload in development

3. **Small Team**
   - Learning curve for Go
   - Learning curve for framework
   - Less community support for game-specific issues

---

## Recommended Go Stack for Future FPS Project

If starting a new FPS project with Go, I recommend:

### Option 1: Custom Implementation
**Stack:**
- **Server**: Go + coder/websocket
- **Client**: Go + Ebiten (2D) or custom engine
- **Protocol**: Custom Tribes 2-style implementation
- **Serialization**: Protobuf or custom bit-packing

**Pros:**
- Full control over networking
- Can implement Tribes 2 features exactly
- Go performance benefits
- Single language across client/server

**Cons:**
- Must implement everything from scratch
- No game engine for 3D
- Significant development time

### Option 2: BoomNetwork
**Stack:**
- **Server**: Go + BoomNetwork
- **Client**: C# + Unity
- **Protocol**: BoomNetwork frame sync
- **Networking**: TCP/KCP dual transport

**Pros:**
- Proven production framework
- Comprehensive features
- Unity ecosystem for 3D
- Multiple demo projects

**Cons:**
- C#/Unity lock-in
- Different languages for client/server
- No rollback (frame sync only)
- Learning curve for framework

### Option 3: gogs with Custom Features
**Stack:**
- **Server**: Go + gogs
- **Client**: TypeScript + Three.js (WebSocket)
- **Protocol**: gogs protobuf + custom Tribes 2 layer
- **Networking**: WebSocket + WebRTC DataChannel

**Pros:**
- WebRTC support for low latency
- Protobuf efficiency
- Can keep TypeScript client
- Framework handles basic networking

**Cons:**
- Must implement Tribes 2 features on top
- Framework lock-in
- Limited documentation for advanced features

---

## Performance Benchmarks

### WebSocket Performance
Based on available benchmarks:

- **coder/websocket**: Best performance for new Go projects
- **gorilla/websocket**: Good but archived
- **uWebSockets.js (TypeScript)**: Competitive with Go WebSocket libraries

### Game Server Performance
- Go's goroutine model excels at concurrent connections
- Lower memory footprint than Node.js
- Better CPU utilization for compute-heavy workloads
- uWebSockets.js (C++ based) matches Go performance for WebSocket

### For 32-64 Player FPS
- TypeScript + uWebSockets.js: Sufficient
- Go + coder/websocket: Better performance margin
- Go + BoomNetwork: Best performance but wrong client stack

---

## Conclusion

### For Current Project (TypeScript/Three.js)
**Recommendation**: Stick with TypeScript

**Reasons:**
1. No Go library provides Tribes 2 features out-of-the-box
2. Would still need to implement state masks, bit-packing, etc. in Go
3. Can't share code between client/server with Go
4. BoomNetwork requires C#/Unity client (complete rewrite)
5. Existing TypeScript infrastructure is functional
6. uWebSockets.js performance is sufficient for 32-64 players
7. Faster to complete with shared TypeScript code

### For Future Projects
**Consider Go if:**
- Starting from scratch
- Can choose client stack freely
- Team has Go expertise
- Need maximum performance (100+ players)
- Willing to use Unity/C# (for BoomNetwork)

**Recommended Future Stack:**
- **Go + BoomNetwork** if using Unity/C# client
- **Go + custom implementation** if using Go client engine
- **Go + gogs** if need WebRTC and willing to implement custom features

### Key Takeaway
Go is excellent for game servers, but the available libraries don't provide the specific Tribes 2-style networking features we need without significant custom implementation. For this project, TypeScript remains the pragmatic choice. For future projects where a fresh start is feasible, Go + BoomNetwork or Go + custom implementation would be strong contenders.

---

## References

1. **nano**: https://github.com/lonng/nano
2. **gogs**: https://github.com/metagogs/gogs
3. **BoomNetwork**: https://github.com/boomlulu/BoomNetwork
4. **necs**: https://github.com/sparsereproce/necs
5. **gorilla/websocket**: https://github.com/gorilla/websocket
6. **coder/websocket**: https://github.com/coder/websocket
7. **WebSocket Performance Comparison**: https://matttomasetti.medium.com/websocket-performance-comparison-10dc89367055
8. **WebRTC vs WebSockets**: https://developers.rune.ai/blog/webrtc-vs-websockets-for-multiplayer-games
9. **Evaluating Browser-Based Networking**: https://aaron.gember-jacobson.com/docs/nsdi2025browser-networking.pdf
