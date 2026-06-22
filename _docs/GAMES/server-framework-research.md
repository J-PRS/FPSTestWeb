# Server Framework Research: Colyseus vs Custom WebSocket vs Alternatives

**Date:** 2026-06-22
**Objective:** Evaluate server framework options for browser FPS game, focusing on cost, performance, and complexity

## Current Implementation

**Current Stack:**
- Server: Node.js with `ws` (WebSocket)
- Custom implementation: PlayerManager, ProjectileManager, MessageHandler, GameLoop
- Tick rate: 15Hz
- Features: Basic room management, lag compensation, binary protocol

**Status:** Working, but custom implementation requires maintaining all networking logic

## Option 1: Colyseus Framework

### What is Colyseus?
Colyseus is an authoritative multiplayer game server framework for Node.js. It provides:
- Room-based architecture (MatchMaker, Room lifecycle)
- Schema-based state synchronization (delta compression)
- Built-in presence system
- WebSocket transport layer (ws or uWebSockets.js)
- HTTP routing integration

### Architecture
```typescript
// Colyseus room-based architecture
class GameRoom extends Room {
  onCreate(options) {
    // Initialize game state
    this.state = new GameState();
  }

  onJoin(client, options) {
    // Player joined
  }

  onLeave(client) {
    // Player left
  }

  onMessage(client, data) {
    // Handle client messages
  }

  onUpdate(dt) {
    // Game loop (configurable tick rate)
  }
}
```

### Pros
- **Room management built-in** - MatchMaker, room creation, sharding
- **Schema-based state sync** - Automatic delta compression, efficient bandwidth
- **Presence system** - Built-in player tracking
- **HTTP integration** - Easy REST API alongside WebSocket
- **TypeScript support** - Shared code between client and server
- **Battle-tested** - Used in production games (CFWK, Grapplenauts)
- **Community** - Active development, documentation, examples

### Cons
- **Framework overhead** - Additional abstraction layer
- **Learning curve** - Need to learn Colyseus-specific APIs
- **Less control** - Framework dictates architecture
- **Schema limitations** - State must fit schema structure
- **Migration cost** - Significant rewrite from current custom implementation

### Performance
- **Default transport:** `ws` library (same as current)
- **uWebSockets.js transport:** Native C++, better performance, more CCU
- **Bun runtime:** Experimental support, better performance than Node
- **Benchmark:** Can hold 8k+ WebSocket connections in "hello world" scenario

### Cost Impact
- **Server CPU:** Similar to custom (same underlying WebSocket)
- **Memory:** Slightly higher (framework overhead)
- **Development time:** +2-3 weeks (migration from custom)
- **Maintenance:** Lower (framework handles networking)

### Suitability for FPS
- **Good:** Room-based architecture fits FPS lobbies
- **Good:** Schema sync efficient for frequent position updates
- **Mixed:** Schema may not fit complex FPS state (projectiles, physics)
- **Good:** Presence system for player tracking
- **Mixed:** Tick rate configurable but may not fit custom physics needs

## Option 2: Custom WebSocket (Current Approach)

### Architecture
```typescript
// Current custom implementation
const server = new WebSocket.Server({ port: 8095 });
server.on('connection', (ws) => {
  // Custom connection handling
  // Custom message routing
  // Custom game loop
});
```

### Pros
- **Full control** - Complete control over architecture
- **No framework overhead** - Minimal CPU/memory overhead
- **Custom optimization** - Can optimize for specific needs
- **No migration cost** - Already implemented
- **Learning** - Deep understanding of networking

### Cons
- **Reinventing the wheel** - Implementing room management, presence, etc.
- **Maintenance burden** - Must maintain all networking logic
- **Bug risk** - Custom implementation may have edge cases
- **No community support** - Solve problems yourself
- **Feature development** - Must build every feature from scratch

### Performance
- **WebSocket:** `ws` library (same as Colyseus default)
- **CPU:** Minimal overhead (no framework)
- **Memory:** Minimal overhead
- **Custom optimization:** Can optimize binary protocol, delta compression

### Cost Impact
- **Server CPU:** Minimal (no framework overhead)
- **Memory:** Minimal
- **Development time:** 0 (already implemented)
- **Maintenance:** High (must maintain all networking)

### Suitability for FPS
- **Excellent:** Full control over FPS-specific needs
- **Excellent:** Custom binary protocol optimized for FPS
- **Excellent:** Custom tick rate, physics integration
- **Poor:** Must implement room management, presence, etc.

## Option 3: Socket.io

### What is Socket.io?
Real-time bidirectional event-based communication library with automatic reconnection, fallback to HTTP polling.

### Architecture
```typescript
const io = new Server(3000);
io.on('connection', (socket) => {
  socket.on('message', (data) => {
    // Handle message
  });
});
```

### Pros
- **Automatic reconnection** - Handles network issues gracefully
- **Fallback to HTTP polling** - Works when WebSocket blocked
- **Room support** - Built-in room management
- **Easy to use** - Simple API
- **Large community** - Widely used

### Cons
- **Not designed for games** - General-purpose, not game-specific
- **No authoritative server** - Client-server model, not game server
- **No state sync** - Must implement state management
- **Higher overhead** - Additional protocol layer
- **Not suitable for competitive FPS** - No lag compensation, prediction

### Performance
- **Overhead:** Higher than raw WebSocket (additional protocol)
- **Suitability:** Good for casual games, bad for competitive FPS

### Cost Impact
- **Server CPU:** Higher than raw WebSocket
- **Bandwidth:** Higher (additional protocol overhead)
- **Development time:** +1-2 weeks (learning, implementation)

### Suitability for FPS
- **Poor:** Not designed for competitive games
- **Poor:** No built-in lag compensation, prediction
- **Poor:** Higher overhead affects tick rate
- **Good:** Only for casual multiplayer, not competitive FPS

## Option 4: Nakama

### What is Nakama?
Open-source distributed game server with real-time multiplayer, social features, and storage.

### Architecture
```typescript
// Nakama server
const server = nakama.createServer({
  username: "default",
  password: "lembas",
});
```

### Pros
- **Feature-rich** - Social features, leaderboards, chat, storage
- **Distributed** - Can scale horizontally
- **Real-time multiplayer** - Designed for games
- **Authority** - Server-authoritative model
- **Cloud hosting** - Nakama Cloud available

### Cons
- **Complex** - More features than needed for simple FPS
- **Learning curve** - Different architecture
- **Overkill** - Many features not needed for FPS
- **Migration cost** - Significant rewrite
- **Cost** - Cloud hosting has cost

### Performance
- **Good:** Designed for real-time games
- **Complex:** More overhead than simple WebSocket

### Cost Impact
- **Server CPU:** Higher (additional features)
- **Development time:** +3-4 weeks (learning, migration)
- **Hosting:** Additional cost if using Nakama Cloud

### Suitability for FPS
- **Mixed:** Good for real-time, but overkill for simple FPS
- **Good:** Social features if needed
- **Poor:** Too complex for MVP

## Comparison Matrix

| Framework | Server CPU | Memory | Development Time | Maintenance | FPS Suitability | Cost |
|-----------|------------|--------|------------------|-------------|-----------------|------|
| **Custom WebSocket** | Minimal | Minimal | 0 (done) | High | Excellent | Low |
| **Colyseus** | Low | Low-Medium | +2-3 weeks | Low | Good | Low |
| **Socket.io** | Medium | Medium | +1-2 weeks | Low | Poor | Medium |
| **Nakama** | Medium-High | Medium-High | +3-4 weeks | Low | Mixed | High |

## Recommendation

### For Your Use Case (Cost-Conscious FPS on DigitalOcean)

**Recommended: Keep Custom WebSocket**

**Reasons:**
1. **Already implemented** - No migration cost
2. **Full control** - Optimize for FPS-specific needs
3. **Minimal overhead** - Lowest server CPU cost (critical for DigitalOcean)
4. **Custom binary protocol** - Already optimized for bandwidth
5. **Custom tick rate** - Already configured for 15Hz
6. **Lag compensation** - Already implemented

**When to Consider Colyseus:**
- If you need room management, matchmaking, presence
- If you want shared TypeScript code between client and server
- If you want to reduce maintenance burden
- If you're willing to invest 2-3 weeks in migration

**When to Consider Socket.io:**
- Never for competitive FPS (not designed for games)

**When to Consider Nakama:**
- If you need social features (leaderboards, chat, friends)
- If you need distributed scaling
- If you're willing to pay for cloud hosting

## Transport Layer Comparison: uWebSockets.js vs WebTransport vs UDT

### uWebSockets.js (Recommended Upgrade)

**What is it:** Native C++ WebSocket implementation for Node.js, drop-in replacement for `ws` library.

**Performance:**
- Native C++ implementation (vs JavaScript)
- Better performance (more CCU - concurrent users)
- Lower memory consumption
- Same API as `ws` (minimal code changes)

**Browser support:** 100% (standard WebSocket)

**Server support:** Excellent (Node.js, native C++)

**Suitability for FPS:** Excellent
- Same WebSocket protocol (no browser compatibility issues)
- Better performance for high player counts
- Lower memory = more players per droplet
- Easy migration (1 day)

**Cost:** +0% (better performance, same cost)

**Implementation:**
```typescript
// Replace ws with uWebSockets.js
import { uWS } from 'uWebSockets.js';

const app = uWS.App({
  key_file_name: 'key.pem',
  cert_file_name: 'cert.pem',
}).ws('/*', {
  compression: 0,
  maxPayloadLength: 16 * 1024 * 1024,
  idleTimeout: 60,
});
```

### WebTransport (Future Technology)

**What is it:** New web API for low-latency, bidirectional communication built on HTTP/3 (QUIC protocol).

**Performance:**
- Multiplexed streams (no head-of-line blocking)
- Better packet loss handling (QUIC)
- Lower latency than WebSocket
- Supports both reliable and unreliable datagrams

**Browser support:** 75% (Chrome, Edge, Firefox - Safari partial)
- Chrome: 97+
- Edge: 97+
- Firefox: 114+
- Safari: Partial support

**Server support:** Limited (experimental Node.js implementations)

**Suitability for FPS:** Mixed
- Excellent performance characteristics
- Poor browser support (25% of users can't play)
- Limited server infrastructure
- Experimental (not production-ready)

**Cost:** Unknown (new technology, untested)

**Implementation:**
```typescript
// WebTransport API (browser)
const transport = new WebTransport('https://server.example');
const stream = await transport.createBidirectionalStream();

// Server (experimental)
// Limited Node.js support, mostly custom implementations
```

**Verdict:** Not ready for production. Wait for better browser support and server infrastructure.

### UDT (Not Suitable for Games)

**What is it:** UDP-based Data Transfer Protocol designed for high-speed wide area networks and bulk data transfer.

**Performance:**
- Designed for high-speed networks (Gbit/s)
- Optimized for bulk data transfer (terabyte datasets)
- Reliable UDP with congestion control
- Used in high-performance computing, not gaming

**Browser support:** None (not a web protocol)
- Requires native application
- No browser API
- Must use WebAssembly or native bridge

**Server support:** Good (C++ library, Node.js bindings)

**Suitability for FPS:** Poor
- Not designed for real-time gaming
- No browser support
- Overkill for game data (designed for bulk transfer)
- Complex setup

**Cost:** High (requires native application, not pure web)

**Verdict:** Not suitable for browser games. Designed for high-performance computing, not real-time multiplayer.

## Comparison Matrix

| Transport | Browser Support | Server Support | Performance | Complexity | FPS Suitability | Production Ready |
|-----------|----------------|---------------|-------------|------------|-----------------|------------------|
| **uWebSockets.js** | 100% (WebSocket) | Excellent | High | Low | Excellent | Yes |
| **WebTransport** | 75% | Limited | Very High | High | Mixed | No |
| **UDT** | 0% | Good | Very High | Very High | Poor | No |
| **Current (ws)** | 100% (WebSocket) | Excellent | Medium | Low | Excellent | Yes |

## Recommendation

**For your use case (browser FPS on DigitalOcean):**

**Upgrade to uWebSockets.js** - It's a drop-in replacement that provides better performance with minimal effort.

**Why not WebTransport:**
- 25% of users can't play (Safari, older browsers)
- Limited server infrastructure
- Experimental technology
- Not production-ready

**Why not UDT:**
- No browser support (requires native app)
- Not designed for gaming
- Overkill for your use case

**uWebSockets.js benefits:**
- 100% browser compatibility (standard WebSocket)
- Better performance (more players per droplet)
- Lower memory (cost savings)
- 1-day migration
- Production-ready

## Performance Optimization for Custom WebSocket

If you keep custom WebSocket, consider these optimizations:

### 1. Upgrade to uWebSockets.js (Recommended)
```typescript
// Replace ws with uWebSockets.js for better performance
import { uWS } from 'uWebSockets.js';

const app = uWS.App({
  key_file_name: 'key.pem',
  cert_file_name: 'cert.pem',
}).ws('/*', {
  compression: 0,
  maxPayloadLength: 16 * 1024 * 1024,
  idleTimeout: 60,
});
```

**Benefits:**
- Native C++ implementation
- Better performance (more CCU)
- Lower memory consumption
- Same API (minimal code changes)

**Cost:** +0% (better performance, same cost)

### 2. Add Room Management
```typescript
// Add simple room management to custom implementation
class RoomManager {
  private rooms: Map<string, Set<string>> = new Map();
  
  createRoom(roomId: string): void {
    this.rooms.set(roomId, new Set());
  }
  
  joinRoom(roomId: string, playerId: string): void {
    this.rooms.get(roomId)?.add(playerId);
  }
  
  leaveRoom(roomId: string, playerId: string): void {
    this.rooms.get(roomId)?.delete(playerId);
  }
}
```

**Benefits:**
- Organized player groups
- Easier matchmaking
- Better scalability

**Cost:** +1 week development

### 3. Add Presence System
```typescript
// Add presence tracking
class PresenceManager {
  private onlinePlayers: Set<string> = new Set();
  
  playerJoined(playerId: string): void {
    this.onlinePlayers.add(playerId);
    broadcastPlayerList();
  }
  
  playerLeft(playerId: string): void {
    this.onlinePlayers.delete(playerId);
    broadcastPlayerList();
  }
}
```

**Benefits:**
- Track online players
- Player list for UI
- Friend system foundation

**Cost:** +3 days development

## Conclusion

**For your current situation (cost-conscious FPS on DigitalOcean):**

**Keep Custom WebSocket** - It's already working, has minimal overhead, and gives you full control for FPS-specific optimization. The migration cost to Colyseus (2-3 weeks) isn't justified by the benefits for your use case.

**Future considerations:**
- If you need room management, add it to custom implementation (1 week)
- If you need better performance, upgrade to uWebSockets.js (1 day)
- If you need social features, consider Nakama later (when needed)

**The custom WebSocket approach aligns perfectly with your cost constraints and gives you the control needed for competitive FPS networking.**
