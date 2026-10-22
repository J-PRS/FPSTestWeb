# Efficient WebSocket Networking Plan for Web FPS
## Applying Lessons from Krunker.io and Tribes 2

**Date**: 2026-06-23  
**Purpose**: Design a WebSocket-based networking architecture for browser FPS games that addresses TCP limitations through proven netcode techniques.

---

## Executive Summary

This report synthesizes networking strategies from two successful multiplayer games:
- **Krunker.io**: Browser-based FPS using pure WebSockets with client-side prediction
- **Tribes 2**: Native FPS with sophisticated UDP-based networking model

The proposed architecture adapts Tribes 2's data classification and state management principles to work within WebSocket's TCP constraints, creating a hybrid approach suitable for competitive web FPS games.

---

## Part 1: Krunker.io Analysis

### Current Implementation
- **Protocol**: WebSockets over TCP
- **Encoding**: msgpack (binary, smaller than JSON)
- **Rate Limits**:
  - 2000 bytes per message
  - Broadcast (server→all): 10 msg/sec
  - Server→client: 20 msg/sec per user
  - Client→server: 40 msg/sec
- **Movement Sync**: Server sends position once per second, client retraces steps

### Key Optimizations
1. **Client-side prediction**: Client predicts movement locally, server sends corrections
2. **Low tick rate**: 10-20 Hz instead of 60+ Hz (reduces bandwidth)
3. **Delta compression**: Only send changes, not full state
4. **Binary encoding**: msgpack reduces payload size significantly
5. **Rate limiting**: Prevents network spam and manages bandwidth

### Limitations
- TCP head-of-line blocking causes lag spikes when packets drop
- Low tick rate limits responsiveness for competitive play
- No unreliable transport for non-critical data
- Movement sync at 1 Hz is too slow for tight combat

---

## Part 2: Tribes 2 Networking Principles

### Core Philosophy
Tribes 2 classifies all data by delivery requirements and optimizes each category independently. This approach maximizes bandwidth efficiency while maintaining game responsiveness.

### Data Classification

1. **Non-guaranteed data**: Never retransmitted if lost
   - Use cases: Non-critical position updates, cosmetic effects
   - Benefit: Zero retransmission overhead

2. **Guaranteed data**: Must be retransmitted, delivered in order
   - Use cases: Game events, score changes, inventory updates
   - Benefit: Reliability for critical state

3. **Most Recent State (MRS)**: Only latest version matters
   - Use cases: Position, rotation, velocity
   - Benefit: Stale data is never retransmitted
   - Key innovation: State mask tracking ensures only new data is sent

4. **Guaranteed Quickest**: Delivered as fast as possible
   - Use cases: Player input, control object state
   - Benefit: Immediate response to player actions

### Architecture Layers

#### Connection Layer
- Provides packet delivery status notifications
- Sliding window protocol (3 bytes overhead per packet)
- Never retransmits packets (handled by higher layers)
- Bit-packing for efficient data encoding

#### Stream Layer
Five specialized managers handle different data types:

1. **Event Manager**: Guaranteed/non-guaranteed events
   - Sliding window tracks event delivery
   - Retransmits only guaranteed events on packet loss
   - Minimal overhead (3 bits/packet + 1 bit/event)

2. **Ghost Manager**: Object state synchronization
   - "Ghosting" = copying objects to remote hosts
   - State mask system for partial updates
   - Scoping: only ghost relevant objects
   - Priority-based update ordering
   - MRS algorithm: only latest state guaranteed

3. **Move Manager**: Input and control object synchronization
   - Moves sent every 32ms
   - Each move transmitted 3 times in consecutive packets
   - Control object state sent in every packet
   - Deterministic move processing for prediction

4. **Datablock Manager**: Static data transmission
   - Latest state delivery at low frequency
   - Only sent on connect/map change
   - Separates static attributes from dynamic instance data

5. **String Manager**: String compression (not detailed in paper)

#### Simulation Layer
- Fixed 32ms tick rate
- Client-side prediction for control objects
- Object scoping based on visibility/relevance
- Priority calculation for update ordering
- Backwards interpolation for smooth rendering

### Key Innovations

#### State Mask System
Each object has a state mask where each bit represents a type of state:
- Bit 0: Position
- Bit 1: Rotation
- Bit 2: Animation state
- etc.

When state changes, only the relevant bit is set. The Ghost Manager transmits only the changed states. If a packet is lost, only the lost bits are retransmitted, and only if a newer version hasn't already been sent.

#### Partial State Updates
Objects can have 20+ state flags. Each is tracked and transferred independently. This allows sending only what changed, not the entire object state.

#### Scoping and Prioritization
Objects come in and out of scope based on:
- Visibility from player's perspective
- Distance
- Projected radius in view frustum
- Relative velocity
- Interest modifiers (projectiles > vehicles > items)

Priority determines update order within packets.

#### Move Prediction
- Client processes moves locally for immediate response
- Server validates all moves authoritatively
- Control object state sent in every packet for synchronization
- Deterministic simulation ensures client and server produce same results

---

## Part 3: Hybrid WebSocket Networking Plan

### Challenge: Adapting UDP Principles to TCP

Tribes 2 assumes UDP with packet delivery notifications. WebSockets provide:
- Reliable ordered delivery (no packet loss notifications)
- Head-of-line blocking
- No control over retransmission timing

### Solution: Application-Level Semantics

We implement Tribes 2's data classification at the application layer, treating WebSocket as a reliable pipe while managing data semantics ourselves.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Application Layer                    │
│  (Game Logic, Physics, Input, Rendering)                │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│              WebSocket Stream Layer                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Event Stream │  │ Ghost Stream │  │ Move Stream │  │
│  │   Manager    │  │   Manager    │  │   Manager    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│  ┌──────────────┐  ┌──────────────┐                     │
│  │ Datablock    │  │ State Mask   │                     │
│  │   Manager    │  │   Tracker    │                     │
│  └──────────────┘  └──────────────┘                     │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│              WebSocket Connection Layer                 │
│  (Binary msgpack encoding, rate limiting)              │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│                    TCP/IP Stack                         │
└─────────────────────────────────────────────────────────┘
```

### Data Classification for WebSockets

#### 1. Non-Guaranteed Data (Emulated)
Since WebSocket is reliable, we implement this via:
- Timestamp-based staleness detection
- Client ignores data older than threshold
- Server sends without ACK expectation
- Use case: Cosmetic effects, distant player positions

#### 2. Guaranteed Data
- Standard WebSocket messages
- Sequence numbers for ordering
- ACK/retransmission at application level if needed
- Use case: Game events, scores, inventory

#### 3. Most Recent State (MRS)
- State mask system (direct from Tribes 2)
- Only send changed state bits
- Client tracks last received timestamp per state type
- Server tracks which state bits were sent in which messages
- Use case: Position, rotation, velocity, animation

#### 4. Guaranteed Quickest
- Send in every message
- Highest priority in packet construction
- Use case: Player input, control object state

### Stream Managers Implementation

#### Event Stream Manager
```typescript
class EventManager {
  private outgoingQueue: Event[] = [];
  private sequenceNumber: number = 0;
  
  // Guaranteed events need ACK tracking
  private pendingEvents: Map<number, Event> = new Map();
  
  pack(packet: BitStream): void {
    while (this.outgoingQueue.length > 0 && packet.hasSpace()) {
      const event = this.outgoingQueue.shift();
      packet.writeInt(event.type, 8);
      packet.writeInt(this.sequenceNumber, 16);
      event.pack(packet);
      
      if (event.guaranteed) {
        this.pendingEvents.set(this.sequenceNumber, event);
      }
      this.sequenceNumber++;
    }
  }
  
  unpack(packet: BitStream): void {
    while (packet.hasData()) {
      const type = packet.readInt(8);
      const seq = packet.readInt(16);
      const event = Event.create(type);
      event.unpack(packet);
      
      if (event.guaranteed) {
        this.sendAck(seq);
      }
      
      event.process();
    }
  }
  
  handleAck(seq: number): void {
    this.pendingEvents.delete(seq);
  }
}
```

#### Ghost Stream Manager with State Masks
```typescript
class GhostManager {
  private ghosts: Map<number, Ghost> = new Map();
  private scopeManager: ScopeManager;
  
  // State mask bits
  static readonly POSITION = 1 << 0;
  static readonly ROTATION = 1 << 1;
  static readonly VELOCITY = 1 << 2;
  static readonly ANIMATION = 1 << 3;
  static readonly HEALTH = 1 << 4;
  
  pack(packet: BitStream): void {
    const updateList = this.buildUpdateList();
    
    for (const ghost of updateList) {
      if (!packet.hasSpace()) break;
      
      packet.writeInt(ghost.id, 16);
      packet.writeInt(ghost.stateMask, 8);
      
      // Pack only the states that changed
      if (ghost.stateMask & GhostManager.POSITION) {
        ghost.packPosition(packet);
      }
      if (ghost.stateMask & GhostManager.ROTATION) {
        ghost.packRotation(packet);
      }
      // ... other states
      
      // Clear state mask after packing
      ghost.stateMask = 0;
    }
  }
  
  unpack(packet: BitStream): void {
    while (packet.hasData()) {
      const id = packet.readInt(16);
      const stateMask = packet.readInt(8);
      
      let ghost = this.ghosts.get(id);
      if (!ghost) {
        ghost = this.createGhost(id);
        this.ghosts.set(id, ghost);
      }
      
      // Unpack only the states that were sent
      if (stateMask & GhostManager.POSITION) {
        ghost.unpackPosition(packet);
      }
      if (stateMask & GhostManager.ROTATION) {
        ghost.unpackRotation(packet);
      }
      // ... other states
    }
  }
  
  private buildUpdateList(): Ghost[] {
    // Get all ghosts in scope
    const inScope = this.scopeManager.getInScopeGhosts();
    
    // Sort by priority (status changes first, then by interest)
    return inScope.sort((a, b) => {
      if (a.statusChanged !== b.statusChanged) {
        return a.statusChanged ? -1 : 1;
      }
      return b.priority - a.priority;
    });
  }
}
```

#### Move Stream Manager
```typescript
class MoveManager {
  private moves: Move[] = [];
  private lastProcessedMove: number = 0;
  
  // Collect moves every 32ms
  collectMove(input: Input): void {
    const move = new Move(input);
    this.moves.push(move);
  }
  
  pack(packet: BitStream): void {
    // Send last 3 moves (like Tribes 2)
    const recentMoves = this.moves.slice(-3);
    
    for (const move of recentMoves) {
      packet.writeInt(move.sequence, 16);
      move.pack(packet);
    }
  }
  
  unpack(packet: BitStream): void {
    while (packet.hasData()) {
      const seq = packet.readInt(16);
      const move = new Move();
      move.unpack(packet);
      
      // Process move
      this.processMove(move);
      this.lastProcessedMove = seq;
    }
  }
  
  // Client-side prediction
  predictMove(move: Move): void {
    // Apply move locally for immediate response
    this.controlObject.applyMove(move);
  }
  
  // Server validation
  validateMove(move: Move): boolean {
    // Verify move is valid
    return this.controlObject.canApplyMove(move);
  }
}
```

### Bit-Packing Implementation

Direct adaptation from Tribes 2 for bandwidth efficiency:

```typescript
class BitStream {
  private data: Uint8Array;
  private bitPosition: number = 0;
  
  writeBool(value: boolean): void {
    this.writeBit(value ? 1 : 0);
  }
  
  writeInt(value: number, bits: number): void {
    for (let i = 0; i < bits; i++) {
      this.writeBit((value >> i) & 1);
    }
  }
  
  writeFloatNormalized(value: number, bits: number): void {
    // Compress 0-1 float to specified bits
    const compressed = Math.floor(value * ((1 << bits) - 1));
    this.writeInt(compressed, bits);
  }
  
  writeStringHuffman(str: string): void {
    // Huffman compression for strings
    const encoded = huffmanEncode(str);
    this.writeInt(encoded.length, 16);
    for (const byte of encoded) {
      this.writeInt(byte, 8);
    }
  }
  
  private writeBit(bit: number): void {
    const byteIndex = Math.floor(this.bitPosition / 8);
    const bitIndex = this.bitPosition % 8;
    
    if (bit) {
      this.data[byteIndex] |= (1 << bitIndex);
    }
    
    this.bitPosition++;
  }
}
```

### Scoping System

```typescript
class ScopeManager {
  private spatialDatabase: SpatialDatabase;
  
  getInScopeGhosts(player: Player): Ghost[] {
    const visibleObjects = this.spatialDatabase.queryVisible(
      player.position,
      player.viewDirection,
      player.viewFrustum
    );
    
    return visibleObjects
      .map(obj => obj.ghost)
      .filter(ghost => this.calculatePriority(ghost, player) > 0);
  }
  
  calculatePriority(ghost: Ghost, player: Player): number {
    let priority = 0;
    
    // Distance factor (closer = higher priority)
    const distance = ghost.position.distanceTo(player.position);
    priority += Math.max(0, 100 - distance);
    
    // View frustum factor (in view = higher priority)
    if (player.viewFrustum.contains(ghost.position)) {
      priority += 50;
    }
    
    // Velocity factor (moving toward player = higher priority)
    const relativeVelocity = ghost.velocity.sub(player.velocity);
    if (relativeVelocity.dot(player.position.sub(ghost.position)) < 0) {
      priority += 30;
    }
    
    // Interest modifiers
    if (ghost.type === 'projectile') priority += 40;
    if (ghost.type === 'vehicle') priority += 20;
    if (ghost.type === 'item') priority += 10;
    
    return priority;
  }
}
```

### Client-Side Prediction

```typescript
class ClientPrediction {
  private controlObject: ControlObject;
  private moveHistory: Move[] = [];
  private serverState: State;
  
  applyMove(move: Move): void {
    // Store move for reconciliation
    this.moveHistory.push(move);
    
    // Apply locally for immediate response
    this.controlObject.applyMove(move);
  }
  
  reconcile(serverState: State): void {
    // Find the last move the server has processed
    const lastServerMove = serverState.lastMoveSeq;
    
    // Remove old moves from history
    this.moveHistory = this.moveHistory.filter(m => m.seq > lastServerMove);
    
    // If server state differs significantly, snap to server
    if (this.controlObject.state.distanceTo(serverState) > THRESHOLD) {
      this.controlObject.state = serverState;
      
      // Re-apply all pending moves
      for (const move of this.moveHistory) {
        this.controlObject.applyMove(move);
      }
    }
  }
}
```

### Rate Limiting and Bandwidth Management

```typescript
class BandwidthManager {
  private maxBytesPerSecond: number;
  private maxPacketSize: number;
  private packetsPerSecond: number;
  
  constructor(bandwidth: number) {
    // Example: 28.8 modem = ~2KB/s
    this.maxBytesPerSecond = bandwidth;
    this.maxPacketSize = 200;
    this.packetsPerSecond = 10;
  }
  
  canSendPacket(size: number): boolean {
    return size <= this.maxPacketSize;
  }
  
  getPacketInterval(): number {
    return 1000 / this.packetsPerSecond;
  }
  
  // Dynamic adjustment based on network conditions
  adjustBandwidth(measuredLatency: number, packetLoss: number): void {
    if (packetLoss > 0.1) {
      // Reduce bandwidth if high packet loss
      this.packetsPerSecond = Math.max(5, this.packetsPerSecond - 1);
    } else if (measuredLatency < 100 && packetLoss < 0.02) {
      // Increase bandwidth if good conditions
      this.packetsPerSecond = Math.min(20, this.packetsPerSecond + 1);
    }
  }
}
```

### Message Structure

Each WebSocket message follows this structure:

```
┌─────────────────────────────────────────────────────────┐
│ Header (8 bytes)                                        │
│ - Message Type (1 byte): Event/Ghost/Move/Datablock     │
│ - Sequence Number (2 bytes)                             │
│ - Timestamp (2 bytes)                                   │
│ - State Mask (1 byte)                                   │
│ - Reserved (2 bytes)                                   │
├─────────────────────────────────────────────────────────┤
│ Stream Manager Data (variable)                          │
│ - Event Manager data (if type = Event)                  │
│ - Ghost Manager data (if type = Ghost)                 │
│ - Move Manager data (if type = Move)                    │
│ - Datablock Manager data (if type = Datablock)         │
└─────────────────────────────────────────────────────────┘
```

### Tick Rate Strategy

Based on Krunker's limitations and Tribes 2's approach:

- **Input rate**: 32ms (31.25 Hz) - matches Tribes 2
- **Network tick rate**: 20-30 Hz (configurable based on bandwidth)
- **Client prediction**: Interpolate between network updates
- **Server validation**: Authoritative at 20-30 Hz

This provides:
- Better responsiveness than Krunker's 1 Hz position sync
- Lower bandwidth than native 60 Hz
- Smooth gameplay through prediction

---

## Part 4: Implementation Recommendations

### Phase 1: Core Infrastructure
1. Implement BitStream class with bit-packing
2. Create WebSocket connection wrapper with msgpack encoding
3. Build basic Event Manager for guaranteed/non-guaranteed events
4. Implement sequence numbering and ACK system

### Phase 2: State Management
1. Implement Ghost Manager with state mask system
2. Create scoping system with spatial database
3. Build priority calculation for update ordering
4. Implement partial state updates

### Phase 3: Movement and Prediction
1. Build Move Manager with 32ms input collection
2. Implement client-side prediction
2. Add server-side move validation
3. Create reconciliation system

### Phase 4: Optimization
1. Implement dynamic bandwidth adjustment
2. Add Huffman string compression
3. Optimize state mask bit allocation
4. Profile and tune packet sizes

### Phase 5: Testing
1. Simulate high-latency conditions (200ms+)
2. Test with packet loss (5-20%)
3. Benchmark bandwidth usage
4. Compare against pure WebSocket baseline

---

## Part 5: Expected Benefits

### Compared to Pure WebSocket (Krunker-style)
- **Higher tick rate**: 20-30 Hz vs 1 Hz position sync
- **Better bandwidth efficiency**: State masks send only changes
- **Reduced perceived lag**: Client prediction with reconciliation
- **Scalability**: Scoping system reduces unnecessary updates

### Compared to WebRTC
- **Simpler implementation**: No signaling/STUN/TURN complexity
- **Better firewall penetration**: WebSocket works everywhere
- **Easier debugging**: Reliable stream simplifies troubleshooting
- **Fallback compatibility**: Works on older browsers

### Trade-offs
- **Still subject to TCP head-of-line blocking**: Mitigated by prediction
- **Higher CPU usage**: Bit-packing and state management add overhead
- **Complexity**: More complex than simple WebSocket, simpler than WebRTC

---

## Part 6: Performance Targets

### Bandwidth
- **Target**: 2-4 KB/s per client (modem-friendly)
- **Optimal**: 5-10 KB/s per client (broadband)
- **Maximum**: 20 KB/s per client (high-speed)

### Latency
- **Input latency**: < 50ms (local prediction)
- **Network latency**: 100-200ms (acceptable with prediction)
- **Update rate**: 20-30 Hz (network), 60+ Hz (rendering)

### Scalability
- **Players per server**: 32-64 (realistic for web)
- **Objects per client**: 50-100 in scope
- **Packet size**: 200-400 bytes average

---

## Conclusion

This hybrid architecture combines the best of both worlds:
- Krunker's proven WebSocket-based browser compatibility
- Tribes 2's sophisticated data classification and state management

By implementing Tribes 2's principles at the application layer over WebSockets, we can achieve:
- Competitive responsiveness through client prediction
- Efficient bandwidth usage through state masks and scoping
- Browser compatibility without WebRTC complexity
- Scalability to support 32+ players per server

The key innovation is treating WebSocket as a reliable pipe while managing data semantics ourselves, effectively implementing UDP-like behavior over TCP through intelligent data classification and state tracking.

---

## References

1. Krunker.io networking analysis
   - WebSocket endpoint: wss://social.krunker.io/ws
   - msgpack binary encoding
   - Rate limits: 10-40 msg/sec

2. Tribes 2 Networking Model
   - Frohnmayer, Mark and Gift, Tim. "The TRIBES Engine Networking Model"
   - Data classification: Non-guaranteed, Guaranteed, MRS, Guaranteed Quickest
   - State mask system for partial updates
   - Scoping and prioritization
   - Client-side prediction

3. Web Networking Technologies
   - WebSockets: Reliable ordered delivery over TCP
   - WebRTC: UDP-like unreliable delivery
   - WebTransport: Emerging HTTP/3 over QUIC

---

**Next Steps**: Implement Phase 1 (Core Infrastructure) and validate bit-packing efficiency with msgpack encoding.
