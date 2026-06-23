# Server-Side Architecture for Browser FPS Games

## Overview

This document covers server-side architecture considerations for browser-based FPS games, including technology choices, architecture patterns, performance optimization, and scaling strategies based on industry analysis of successful browser FPS titles.

## Industry Server Technology Landscape

### What Major Browser FPS Games Use

**Shell Shockers**:
- **Technology**: Node.js (reverse-engineered servers confirm)
- **Protocol**: WebSocket
- **Architecture**: Room-based game servers
- **Scale**: 10,000+ simultaneous players, 300K-350K DAU
- **Revenue**: $1M-$3M/year

**Krunker.io**:
- **Technology**: Node.js/Express (website), likely Socket.IO (game server)
- **Protocol**: WebSocket
- **Architecture**: CloudFlare for matchmaking, multiple game server instances
- **Scale**: 200M total players, 50K peak concurrent
- **Revenue**: $200K-$500K/year pre-acquisition

**War Brokers**:
- **Technology**: TypeScript monorepo (69.9% TypeScript)
- **Protocol**: WebSocket
- **Architecture**: Shared TypeScript types between client/server
- **Scale**: 16-player limit per match
- **Team**: Small team (sustainable indie)

**Other Examples**:
- **open-browser-fps**: Node.js + Socket.IO + Three.js
- **Defense of the Artifacts**: Node.js + Socket.IO + Babylon.js
- **game-sync**: Node.js + Express + Socket.IO

**Go Examples**:
- **gowog**: Golang server + Node.js/Phaser client (hybrid)
- Uses protobuf for serialization
- Demonstrates Go's concurrency advantages

### Pattern Analysis

**Node.js Dominance**: 90%+ of browser FPS games use Node.js for game servers

**Why Node.js Wins**:
- **Code sharing**: JavaScript/TypeScript can be shared between client and server
- **Ecosystem**: Mature WebSocket libraries (ws, Socket.IO)
- **Development speed**: No compilation step, faster iteration
- **Sufficient performance**: Handles most browser game scales (<10K concurrent)
- **Talent pool**: Easier to find JavaScript/TypeScript developers

**Go Use Cases**:
- **Hybrid architectures**: Go for CPU-intensive tasks, Node.js for I/O
- **Massive scale**: 10,000+ concurrent players per server
- **Performance-critical**: When Node.js event loop becomes bottleneck
- **Learning curve**: Only if team already knows Go

## Technology Comparison

### Node.js vs Go for Game Servers

| Aspect | Node.js | Go |
|--------|---------|-----|
| **Concurrency Model** | Event loop (single-threaded) | Goroutines (multi-threaded) |
| **Parallelism** | Limited (one core per process) | True multi-core utilization |
| **Memory per Connection** | Higher (~100KB) | Lower (~2KB) |
| **CPU Performance** | Good for I/O, limited for CPU | Excellent for CPU-bound tasks |
| **Development Speed** | Fast (no compilation) | Slower (compilation step) |
| **Ecosystem** | Mature (ws, Socket.IO) | Growing (gorilla/websocket) |
| **Code Sharing** | Full with client (TypeScript) | None (different language) |
| **Deployment** | node_modules, multiple files | Single binary |
| **Learning Curve** | Low (JavaScript/TypeScript) | Medium (Go syntax) |
| **Debugging** | Easier (dynamic, hot reload) | Harder (compiled) |

### Performance Benchmarks

**Node.js**:
- **Concurrent connections**: 1,000-5,000 per instance (typical)
- **Max connections**: 10,000+ with optimization
- **CPU utilization**: Single-core bound
- **Memory**: ~100KB per WebSocket connection
- **Latency**: 10-50ms for typical game operations

**Go**:
- **Concurrent connections**: 10,000-50,000 per instance
- **Max connections**: 100,000+ with optimization
- **CPU utilization**: Multi-core scalable
- **Memory**: ~2KB per goroutine
- **Latency**: 5-30ms for typical game operations

### When to Use Each

**Use Node.js if**:
- Player count < 1,000 concurrent per server
- Team knows JavaScript/TypeScript
- Want to share code between client/server
- Development speed is priority
- I/O-bound operations (WebSocket, database)

**Use Go if**:
- Player count > 10,000 concurrent per server
- CPU-intensive operations (physics, hit detection)
- Team knows Go or willing to learn
- Want maximum performance per server
- Memory efficiency is critical

**Hybrid Approach**:
- Node.js for WebSocket handling (I/O bound)
- Go for CPU-intensive tasks (physics, hit detection)
- Communicate via gRPC or shared memory
- Best of both worlds

## Architecture Patterns

### Room-Based Architecture

**Description**: Players are grouped into rooms/instances, each with its own game state

**Benefits**:
- **Scalability**: Add more rooms = more players
- **Isolation**: Room failures don't affect other rooms
- **Simplicity**: Easier to implement and debug
- **Load balancing**: Distribute rooms across servers

**Drawbacks**:
- **Fragmentation**: Players can't interact across rooms
- **Matchmaking**: Need matchmaking system
- **State sync**: Can't share state between rooms

**Implementation**:
```typescript
// Room manager
class RoomManager {
  private rooms: Map<string, GameRoom> = new Map();
  
  createRoom(): string {
    const roomId = generateId();
    const room = new GameRoom(roomId);
    this.rooms.set(roomId, room);
    return roomId;
  }
  
  joinRoom(roomId: string, playerId: string): boolean {
    const room = this.rooms.get(roomId);
    if (room && !room.isFull()) {
      room.addPlayer(playerId);
      return true;
    }
    return false;
  }
  
  removeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && room.isEmpty()) {
      room.dispose();
      this.rooms.delete(roomId);
    }
  }
}
```

**Used by**: Shell Shockers, Krunker.io, most browser FPS games

### Shared World Architecture

**Description**: All players exist in a single persistent world

**Benefits**:
- **Seamless**: No room boundaries
- **Social**: All players can interact
- **Immersive**: More realistic MMO feel

**Drawbacks**:
- **Complexity**: Much harder to implement
- **Scalability**: Limited by single world capacity
- **Performance**: More players = more CPU/memory

**Implementation**:
```typescript
// Shared world manager
class WorldManager {
  private players: Map<string, Player> = new Map();
  private spatialIndex: SpatialHash;
  
  update(dt: number): void {
    // Update all players
    this.players.forEach(player => player.update(dt));
    
    // Spatial queries for collision
    const nearbyPlayers = this.spatialIndex.query(position, radius);
    
    // Broadcast to relevant players only
    nearbyPlayers.forEach(player => {
      player.sendUpdate(position, rotation);
    });
  }
}
```

**Used by**: War Brokers (vehicle + infantry, larger maps)

### Hybrid Architecture

**Description**: Room-based for gameplay, shared world for social features

**Benefits**:
- **Best of both**: Scalable gameplay + social features
- **Flexibility**: Can adjust room size based on player count
- **Social**: Lobby, chat, leaderboards shared across rooms

**Drawbacks**:
- **Complexity**: Two systems to maintain
- **State sync**: Need to sync state between systems

**Used by**: Krunker.io (room-based gameplay, shared social features)

## Server-Side Components

### Core Components

**WebSocket Server**:
- Handles real-time communication
- Manages connections and disconnections
- Routes messages to appropriate handlers
- Implements rate limiting and anti-cheat

**Tribes2Networking**:
- Per-connection Tribes2-style networking management
- Coordinates StreamManager, EventManager, GhostManager, MoveManager
- Handles binary packet routing
- Converts Tribes2 events to MessageHandler format

**StreamManager**:
- Coordinates all Tribes2 networking managers
- Packs bit-packed packets with priority ordering
- Manages packet transmission rate (30 packets/sec, 1400 bytes max)
- Handles connection lifecycle

**EventManager**:
- Event queuing and guaranteed delivery
- Event packing/unpacking with BitStream
- Sliding window ACK for guaranteed events
- Factory for event instantiation (PositionEvent, ShotEvent)

**GhostManager**:
- State synchronization for remote entities
- Delta compression for bandwidth efficiency
- Scope-based updates (only send relevant entities)
- Interpolation smoothing

**MoveManager**:
- Input/movement handling
- Client-side prediction support
- Server-authoritative movement validation
- Input sequence tracking

**MessageHandler**:
- JSON message processing (join, joinAck, etc.)
- Converts Tribes2 events to game logic
- Handles state reconciliation
- Rate limiting for critical messages

**Game State Manager**:
- Maintains authoritative game state
- Handles player positions, rotations, health
- Manages projectiles, explosions, effects
- Implements game rules and logic

**Physics Engine**:
- Server-side collision detection
- Hit detection for projectiles
- Movement validation (anti-cheat)
- Terrain collision

**Matchmaking System**:
- Groups players into rooms
- Balances teams
- Handles region selection
- Manages room lifecycle

**Database**:
- Player accounts and authentication
- Persistent data (stats, inventory)
- Leaderboards and rankings
- Match history

### Component Communication

```
Client ↔ WebSocket Server ↔ Tribes2Networking ↔ StreamManager
                                        ↓
                                   EventManager
                                   GhostManager
                                   MoveManager
                                        ↓
                                   MessageHandler
                                        ↓
                                   Game State Manager
                                        ↓
                                   Physics Engine
                                        ↓
                                   Database
```

**Message Flow**:
1. Client sends JSON join message to WebSocket Server
2. Server responds with joinAck
3. Client starts Tribes2 StreamManager
4. Client sends Tribes2 binary packets (bit-packed events)
5. Tribes2Networking routes to StreamManager
6. StreamManager unpacks events via EventManager factory
7. Events converted to MessageHandler format
8. MessageHandler updates Game State Manager
9. Game State Manager broadcasts updates via Tribes2Networking
10. Database stores persistent data asynchronously

### Tribes2 Event System

**Event Types**:
- PositionEvent (type 1): Player position/rotation updates (non-guaranteed)
- ShotEvent (type 2): Shot events with target tracking (guaranteed)

**Event Properties**:
- `type`: Event type identifier
- `guaranteed`: Whether delivery is guaranteed
- `pack()`: Serialize to BitStream
- `unpack()`: Deserialize from BitStream
- `process()`: Handle event on receiver

**Bit-Packing Benefits**:
- 50-70% bandwidth reduction vs JSON
- 32-bit integer support with relative timestamps
- State masks for delta compression
- Fixed-size fields for predictable packet sizes

## Performance Optimization

### WebSocket Optimization

**Connection Pooling**:
```typescript
// Reuse connections where possible
class ConnectionPool {
  private connections: Map<string, WebSocket> = new Map();
  
  getConnection(playerId: string): WebSocket {
    return this.connections.get(playerId);
  }
  
  addConnection(playerId: string, ws: WebSocket): void {
    this.connections.set(playerId, ws);
  }
  
  removeConnection(playerId: string): void {
    const ws = this.connections.get(playerId);
    if (ws) {
      ws.close();
      this.connections.delete(playerId);
    }
  }
}
```

**Message Batching**:
```typescript
// Batch multiple updates into single message
class MessageBatcher {
  private buffer: any[] = [];
  private timer: NodeJS.Timeout | null = null;
  
  add(message: any): void {
    this.buffer.push(message);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 16); // 60 FPS
    }
  }
  
  flush(): void {
    if (this.buffer.length > 0) {
      const batch = { type: 'batch', messages: this.buffer };
      this.send(batch);
      this.buffer = [];
    }
    this.timer = null;
  }
}
```

**Binary Protocol**:
```typescript
// Use binary instead of JSON for performance
class BinaryProtocol {
  encode(state: GameState): ArrayBuffer {
    // Pack state into binary format
    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    // ... pack data
    return buffer;
  }
  
  decode(buffer: ArrayBuffer): GameState {
    // Unpack binary format
    const view = new DataView(buffer);
    // ... unpack data
    return state;
  }
}
```

### Physics Optimization

**Spatial Partitioning**:
```typescript
// Spatial hash for efficient collision detection
class SpatialHash {
  private cells: Map<string, Entity[]> = new Map();
  private cellSize: number;
  
  insert(entity: Entity): void {
    const cellKey = this.getCellKey(entity.position);
    if (!this.cells.has(cellKey)) {
      this.cells.set(cellKey, []);
    }
    this.cells.get(cellKey)!.push(entity);
  }
  
  query(position: Vector3, radius: number): Entity[] {
    const results: Entity[] = [];
    const cellKeys = this.getAffectedCellKeys(position, radius);
    cellKeys.forEach(key => {
      const cell = this.cells.get(key);
      if (cell) {
        results.push(...cell);
      }
    });
    return results;
  }
}
```

**Fixed Timestep**:
```typescript
// Fixed timestep for deterministic physics
const PHYSICS_TICK = 1 / 60; // 60 Hz
let accumulator = 0;

function updatePhysics(dt: number): void {
  accumulator += dt;
  while (accumulator >= PHYSICS_TICK) {
    stepPhysics(PHYSICS_TICK);
    accumulator -= PHYSICS_TICK;
  }
}
```

**Broad Phase / Narrow Phase**:
```typescript
// Two-phase collision detection
function checkCollisions(entities: Entity[]): void {
  // Broad phase: quick rejection
  const pairs = broadPhase(entities);
  
  // Narrow phase: precise collision
  pairs.forEach(pair => {
    if (narrowPhase(pair.a, pair.b)) {
      handleCollision(pair.a, pair.b);
    }
  });
}
```

### Memory Optimization

**Object Pooling**:
```typescript
// Reuse objects instead of creating/destroying
class ObjectPool<T> {
  private pool: T[] = [];
  private factory: () => T;
  
  constructor(factory: () => T, initialSize: number = 100) {
    this.factory = factory;
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(factory());
    }
  }
  
  acquire(): T {
    return this.pool.pop() || this.factory();
  }
  
  release(obj: T): void {
    this.pool.push(obj);
  }
}
```

**Typed Arrays**:
```typescript
// Use typed arrays for numerical data
class PlayerState {
  position: Float32Array; // instead of number[]
  rotation: Float32Array;
  velocity: Float32Array;
  
  constructor() {
    this.position = new Float32Array(3);
    this.rotation = new Float32Array(2);
    this.velocity = new Float32Array(3);
  }
}
```

## Scaling Strategies

### Vertical Scaling

**Description**: Increase resources on single server

**Benefits**:
- **Simplicity**: No architectural changes
- **Consistency**: Single source of truth
- **Latency**: No network hops between servers

**Drawbacks**:
- **Limits**: Hardware has maximum capacity
- **Cost**: High-end servers expensive
- **Single point of failure**: Server down = all players down

**Optimizations**:
- Use multi-core (Node.js cluster module)
- Optimize code (profiling, bottlenecks)
- Increase memory, CPU, network bandwidth

**Suitable for**: <1,000 concurrent players

### Horizontal Scaling

**Description**: Add more server instances

**Benefits**:
- **Unlimited**: Theoretically infinite capacity
- **Redundancy**: Server failures don't affect all players
- **Cost**: Cheaper to scale with commodity hardware

**Drawbacks**:
- **Complexity**: Need load balancing, state sync
- **Consistency**: Harder to maintain consistent state
- **Latency**: Network hops between servers

**Approaches**:
- **Room-based**: Each room on different server
- **Sharding**: Split world across servers
- **Load balancing**: Distribute players across servers

**Suitable for**: >1,000 concurrent players

### Load Balancing

**Round Robin**:
```typescript
// Simple round-robin load balancing
class LoadBalancer {
  private servers: Server[] = [];
  private currentIndex = 0;
  
  getNextServer(): Server {
    const server = this.servers[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.servers.length;
    return server;
  }
}
```

**Least Connections**:
```typescript
// Route to server with fewest connections
class LeastConnectionsBalancer {
  private servers: Server[] = [];
  
  getNextServer(): Server {
    return this.servers.reduce((min, server) => 
      server.connections < min.connections ? server : min
    );
  }
}
```

**Geographic**:
```typescript
// Route to server closest to player
class GeographicBalancer {
  private servers: Map<string, Server> = new Map(); // region -> server
  
  getServerForPlayer(playerRegion: string): Server {
    return this.servers.get(playerRegion) || this.servers.get('default')!;
  }
}
```

## Anti-Cheat Measures

### Server-Side Validation

**Movement Validation**:
```typescript
// Validate player movement is physically possible
function validateMovement(
  oldPos: Vector3,
  newPos: Vector3,
  dt: number
): boolean {
  const maxSpeed = 10; // m/s
  const distance = oldPos.distanceTo(newPos);
  const maxDistance = maxSpeed * dt;
  
  return distance <= maxDistance;
}
```

**Hit Validation**:
```typescript
// Server-side hit detection (authoritative)
function validateHit(
  shooterPos: Vector3,
  targetPos: Vector3,
  timestamp: number
): boolean {
  // Rewind to timestamp (lag compensation)
  const rewoundTargetPos = rewindPosition(targetPos, timestamp);
  
  // Check line of sight
  if (!hasLineOfSight(shooterPos, rewoundTargetPos)) {
    return false;
  }
  
  // Check weapon range
  const distance = shooterPos.distanceTo(rewoundTargetPos);
  return distance <= WEAPON_RANGE;
}
```

**Rate Limiting**:
```typescript
// Prevent spam and DoS
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private maxRequests: number;
  private window: number;
  
  constructor(maxRequests: number, window: number) {
    this.maxRequests = maxRequests;
    this.window = window;
  }
  
  check(playerId: string): boolean {
    const now = Date.now();
    const requests = this.requests.get(playerId) || [];
    
    // Remove old requests
    const validRequests = requests.filter(t => now - t < this.window);
    
    if (validRequests.length >= this.maxRequests) {
      return false;
    }
    
    validRequests.push(now);
    this.requests.set(playerId, validRequests);
    return true;
  }
}
```

### Client-Side Detection

**Anomaly Detection**:
```typescript
// Detect suspicious behavior
class AnomalyDetector {
  private playerStats: Map<string, PlayerStats> = new Map();
  
  check(playerId: string): boolean {
    const stats = this.playerStats.get(playerId);
    if (!stats) return false;
    
    // Check for suspicious patterns
    if (stats.hitRate > 0.95) return true; // Too accurate
    if (stats.headshotRate > 0.8) return true; // Too many headshots
    if (stats.reactionTime < 100) return true; // Superhuman reaction
    
    return false;
  }
}
```

## Deployment Strategies

### Single Server Deployment

**Description**: All components on single server

**Benefits**:
- **Simplicity**: Easy to deploy and manage
- **Low cost**: Single server cost
- **Low latency**: No network hops

**Drawbacks**:
- **Limited capacity**: Single server limits
- **Single point of failure**: Server down = game down
- **Harder to scale**: Need to rearchitect to scale

**Suitable for**: Development, small player counts (<100)

### Multi-Server Deployment

**Description**: Components distributed across servers

**Benefits**:
- **Scalability**: Can scale individual components
- **Redundancy**: Component failures don't take down everything
- **Performance**: Can optimize each component

**Drawbacks**:
- **Complexity**: Harder to deploy and manage
- **Higher cost**: Multiple servers
- **Network latency**: Network hops between components

**Architecture**:
```
Load Balancer
  ↓
WebSocket Servers (multiple)
  ↓
Game State Servers (multiple)
  ↓
Database (clustered)
```

**Suitable for**: Production, medium player counts (100-1,000)

### Container Orchestration

**Description**: Use Docker + Kubernetes for deployment

**Benefits**:
- **Scalability**: Auto-scaling based on load
- **Redundancy**: Automatic failover
- **Consistency**: Same environment everywhere
- **Resource efficiency**: Better resource utilization

**Drawbacks**:
- **Complexity**: Steep learning curve
- **Overhead**: Container overhead
- **Cost**: Kubernetes management cost

**Example Kubernetes Deployment**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: game-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: game-server
  template:
    metadata:
      labels:
        app: game-server
    spec:
      containers:
      - name: game-server
        image: game-server:latest
        ports:
        - containerPort: 8080
        resources:
          requests:
            memory: "256Mi"
            cpu: "500m"
          limits:
            memory: "512Mi"
            cpu: "1000m"
```

**Suitable for**: Production, large player counts (>1,000)

## Monitoring and Analytics

### Key Metrics

**Server Metrics**:
- **CPU utilization**: Percentage of CPU used
- **Memory usage**: RAM consumption
- **Network I/O**: Bytes sent/received
- **Connection count**: Active WebSocket connections
- **Message rate**: Messages per second

**Game Metrics**:
- **Active players**: Players currently in game
- **Room count**: Active game rooms
- **Average latency**: Ping between client and server
- **Tick rate**: Game state updates per second
- **Packet loss**: Percentage of lost packets

**Business Metrics**:
- **DAU/MAU**: Daily/Monthly active users
- **Session duration**: Average play time
- **Retention**: Day 1, Day 7, Day 30 retention
- **Revenue**: Total revenue, ARPU

### Monitoring Tools

**Prometheus + Grafana**:
- **Prometheus**: Metrics collection and storage
- **Grafana**: Visualization and dashboards
- **Benefits**: Open source, flexible, widely used

**DataDog**:
- **All-in-one**: Metrics, logs, traces
- **Benefits**: Easy to set up, good UI
- **Drawbacks**: Expensive

**Custom Monitoring**:
```typescript
// Custom metrics collection
class MetricsCollector {
  private metrics: Map<string, number> = new Map();
  
  increment(name: string, value: number = 1): void {
    const current = this.metrics.get(name) || 0;
    this.metrics.set(name, current + value);
  }
  
  gauge(name: string, value: number): void {
    this.metrics.set(name, value);
  }
  
  getMetrics(): Map<string, number> {
    return this.metrics;
  }
}
```

## Recommendations for Your Project

### Current Architecture Assessment

**Your Current Stack**:
- **Server**: Node.js + TypeScript
- **Protocol**: WebSocket (ws library)
- **Architecture**: Worker-based networking (networking.worker.ts)
- **Scale**: Development phase

**Alignment with Industry**:
- ✅ Node.js is industry standard for browser FPS
- ✅ TypeScript matches client (code sharing potential)
- ✅ WebSocket is correct protocol choice
- ✅ Worker-based architecture is good for performance

### Immediate Recommendations

**Phase 1: Development (Current)**
- Stick with Node.js + TypeScript
- Focus on core gameplay mechanics
- Implement basic anti-cheat (server validation)
- Add monitoring (basic metrics)

**Phase 2: Alpha (<100 players)**
- Add room-based architecture
- Implement matchmaking
- Add database for persistent data
- Optimize WebSocket performance

**Phase 3: Beta (100-1,000 players)**
- Horizontal scaling (multiple server instances)
- Load balancing
- Advanced anti-cheat
- Comprehensive monitoring

**Phase 4: Production (>1,000 players)**
- Consider Go for CPU-intensive tasks if needed
- Container orchestration (Docker + Kubernetes)
- Geographic distribution
- Advanced analytics

### Specific Optimizations

**WebSocket Optimization**:
- Implement message batching
- Use binary protocol instead of JSON
- Add connection pooling
- Implement rate limiting

**Physics Optimization**:
- Add spatial partitioning (spatial hash)
- Implement fixed timestep
- Use broad phase / narrow phase collision
- Consider offloading to Go if CPU-bound

**Memory Optimization**:
- Implement object pooling
- Use typed arrays for numerical data
- Profile memory usage
- Add memory leak detection

**Anti-Cheat**:
- Server-side movement validation
- Server-side hit detection (authoritative)
- Rate limiting
- Anomaly detection

### When to Consider Go

**Switch to Go if**:
- CPU utilization consistently >80%
- Hit detection is bottleneck
- Memory usage is problematic
- Player count >10,000 concurrent
- Team knows Go or willing to learn

**Hybrid Approach**:
- Keep Node.js for WebSocket handling
- Offload physics/hit detection to Go service
- Communicate via gRPC or shared memory
- Best of both worlds

## Conclusion

Node.js is the industry standard for browser FPS game servers, used by Shell Shockers, Krunker.io, War Brokers, and most successful browser FPS titles. It offers sufficient performance for most scales, enables code sharing with the client, and has a mature ecosystem.

Go offers superior performance for CPU-intensive tasks and massive scale (10,000+ concurrent players), but introduces complexity and eliminates code sharing benefits. Consider Go only if you hit performance bottlenecks at scale.

For your current project, Node.js + TypeScript is the right choice. Focus on:
1. Room-based architecture for scalability
2. Server-side validation for anti-cheat
3. Performance optimization (batching, spatial partitioning)
4. Monitoring and analytics
5. Horizontal scaling when needed

Only consider Go if you hit performance bottlenecks at 10,000+ concurrent players.

## References

- [Shell Shockers Reverse Engineering](https://github.com/onlypuppy7/LegacyShell/)
- [War Brokers Monorepo](https://github.com/War-Brokers/War-Brokers)
- [Gowog (Go + Node.js)](https://github.com/Kirk-Wang/gowog)
- [Browser FPS Genre Overview](./BROWSER_FPS_GENRE_OVERVIEW.md)
- [Chromebook Optimization](./CHROMEBOOK_OPTIMIZATION.md)
