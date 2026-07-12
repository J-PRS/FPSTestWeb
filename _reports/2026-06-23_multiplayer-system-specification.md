# Multiplayer System Specification

## Document Information
- **Version**: 1.0
- **Date**: 2026-06-23
- **Status**: Active
- **Project**: FPS Web Game

## 1. System Overview

### 1.1 Purpose
The multiplayer system provides LAN-like gameplay experience for a browser-based FPS game using Tribes 2-style networking principles. The system prioritizes client-side prediction for instant responsiveness while maintaining server authority for validation and anti-cheat.

### 1.2 Key Design Principles
- **Instant Responsiveness**: All player actions (shooting, movement, hits) feel immediate with no perceptible network delay
- **Client-Side Prediction**: Clients predict and execute actions locally before server confirmation
- **Server Authority**: Server validates all actions and can override client predictions for anti-cheat
- **Bandwidth Efficiency**: Bit-packing and state masks minimize network traffic
- **Scalability**: Designed for 16-32 players per room with room-based architecture

## 2. Functional Requirements

### 2.1 Player Movement
- **FR-1**: Player movement must update immediately on client input (no input lag)
- **FR-2**: Client-side prediction must simulate movement locally before server confirmation
- **FR-3**: Server must validate player positions using physics-aware extrapolation
- **FR-4**: Position reconciliation must smooth corrections without snapping
- **FR-5**: Movement must support: walking, jumping, skiing, jetpack

### 2.2 Shooting Mechanics
- **FR-6**: Projectiles must spawn immediately on client when fired (no network delay)
- **FR-7**: Client must detect hits locally and show immediate feedback (hit marker, score)
- **FR-8**: Server must validate projectile positions and hit detection
- **FR-9**: Server must be able to override client hit predictions for anti-cheat
- **FR-10**: Projectile synchronization must handle network delays with timeout
- **FR-11**: WYSIWYG hit detection - if shooter sees projectile pass through enemy model on screen, it's a hit
- **FR-12**: Shooter advantage principle - shooter's client is authoritative for visual hit confirmation
- **FR-13**: Accept false positives (target hit by shot they thought they dodged) over false negatives (shooter misses hit that looks like hit)

### 2.3 State Synchronization
- **FR-14**: Player positions must be synchronized at 30 ticks per second
- **FR-15**: Remote players must be interpolated smoothly based on ping
- **FR-16**: State updates must use delta compression for bandwidth efficiency
- **FR-17**: Ghost objects must use state masks for partial updates
- **FR-18**: Scoping system must prioritize relevant objects based on distance/interest

### 2.4 Event System
- **FR-19**: Guaranteed events (shots, hits) must use ACK/retransmission
- **FR-20**: Non-guaranteed events (position updates) must use best-effort delivery
- **FR-21**: Event sequence numbers must enable ordering and deduplication
- **FR-22**: Sliding window must manage ACK tracking and retransmission

### 2.5 Connection Management
- **FR-23**: WebSocket connections must auto-reconnect with exponential backoff
- **FR-24**: Player state must be restored on reconnection
- **FR-25**: Input history must be replayed for smooth reconciliation
- **FR-26**: Disconnection must clean up all per-player resources

## 3. Non-Functional Requirements

### 3.1 Performance
- **NFR-1**: Client input-to-visual feedback latency < 16ms (1 frame at 60fps)
- **NFR-2**: Server tick rate: 30 ticks per second
- **NFR-3**: Network bandwidth per player: < 42 KB/s (42000 bytes per second)
- **NFR-4**: Packet size: < 1400 bytes (MTU-safe)
- **NFR-5**: Remote player interpolation: adaptive based on ping (10-20ms lerp)

### 3.2 Reliability
- **NFR-6**: Guaranteed events must be delivered with 99.9% reliability
- **NFR-7**: Position validation must accept legitimate movement (jetpack, skiing)
- **NFR-8**: Hit validation must reject impossible hits (distance > 10m)
- **NFR-9**: Memory leaks must be prevented on player disconnect
- **NFR-10**: Server must handle graceful shutdown

### 3.3 Security
- **NFR-11**: All player inputs must be validated server-side
- **NFR-12**: Player IDs must be validated to prevent injection attacks
- **NFR-13**: Numeric data must be validated to prevent NaN/Infinity attacks
- **NFR-14**: Rate limiting must prevent message spam (20 shots/sec, 10 jumps/sec, 5 jetpack/sec)
- **NFR-15**: Position validation must detect teleportation/speed hacks

### 3.4 Scalability
- **NFR-16**: Support 16-32 players per room
- **NFR-17**: Support multiple rooms per server instance
- **NFR-18**: Room-based architecture for horizontal scaling
- **NFR-19**: Connection quality metrics for adaptive behavior

### 3.5 Usability
- **NFR-20**: Gameplay must feel like LAN (no perceptible lag)
- **NFR-21**: Shooting must feel instant (no delay between click and projectile spawn)
- **NFR-22**: Hits must register immediately (no waiting for server round-trip)
- **NFR-23**: Movement must feel responsive (no input lag)
- **NFR-24**: Reconnection must be seamless (state restoration)

## 4. Architecture

### 4.1 Client Architecture
```
NetworkManager (INetworkAdapter interface)
├── Tribes2Adapter (implements INetworkAdapter)
│   ├── WebSocketConnection (msgpack encoding, reconnection)
│   └── StreamManager (coordinates all managers)
│       ├── EventManager (guaranteed/non-guaranteed events)
│       ├── GhostManager (state mask synchronization)
│       └── MoveManager (input collection, prediction)
└── Legacy Adapters (WSAdapter, UWSAdapter - for compatibility)
```

### 4.2 Server Architecture
```
Server (uWebSockets.js)
├── Tribes2Networking (per-connection StreamManagers)
│   ├── EventManager (per-connection event handling)
│   ├── GhostManager (per-connection ghost management)
│   └── MoveManager (per-connection move processing)
├── PlayerManager (player state, rewind buffer)
├── ProjectileManager (projectile lifecycle)
├── MessageHandler (message routing, validation)
├── PositionValidator (physics-aware validation)
├── GameLoop (30 ticks/sec, state updates)
└── RoomManager (room-based architecture)
```

### 4.3 Data Flow
```
Client Input → MovementController (local prediction)
              ↓
            NetworkManager → Tribes2Adapter → StreamManager
              ↓
            WebSocketConnection → Server
              ↓
            Server Validation → MessageHandler → GameLoop
              ↓
            State Update → StreamManager → WebSocketConnection
              ↓
            Client → NetworkManager → Reconciliation
```

## 5. Key Features

### 5.1 Bit-Packing (BitStream)
- Bit-level serialization for bandwidth efficiency
- Variable-length integers for small values
- Float range encoding for normalized values
- String compression for repeated strings

### 5.2 State Masks (GhostManager)
- Partial updates only for changed properties
- Priority-based update scheduling
- Scoping system for relevance filtering
- Delta compression for position updates

### 5.3 Client-Side Prediction
- **Movement**: MovementController simulates physics locally
- **Shooting**: Projectiles spawn immediately on client
- **Hits**: Client detects hits locally for instant feedback
- **Reconciliation**: Input replay smooths server corrections
- **WYSIWYG Hit Detection**: Shooter's visual perspective is authoritative - if shooter sees projectile pass through enemy model, it's a hit
- **Shooter Advantage**: Accept false positives (target hit by shot they thought they dodged) over false negatives (shooter misses hit that looks like hit)

### 5.4 Lag Compensation
- Server rewinds player state to shot timestamp
- 1000ms rewind buffer for high-latency scenarios
- Velocity-based extrapolation for positions outside buffer
- 200ms position tolerance for hit detection

### 5.5 Event System
- Guaranteed events with ACK/retransmission
- Non-guaranteed events with best-effort delivery
- Sequence numbers for ordering and deduplication
- Sliding window for ACK tracking

## 6. Technical Specifications

### 6.1 Network Protocol
- **Transport**: WebSocket (binary messages)
- **Encoding**: msgpack-lite (JSON fallback for compatibility)
- **Serialization**: BitStream (bit-packing for efficiency)
- **Packet Size**: < 1400 bytes (MTU-safe)
- **Tick Rate**: 30 ticks per second
- **Bandwidth**: < 42 KB/s per player

### 6.2 Message Types
- **Join**: Player join with room selection
- **Position**: Player position/rotation update
- **PositionDelta**: Delta-compressed position update
- **Input**: Player input (forward, right, jump, ski)
- **Shot**: Projectile fire with position/velocity
- **HitConfirmation**: Server-confirmed hit
- **GameState**: Full state snapshot (on join/reconnect)
- **PlayerJoined**: New player notification
- **PlayerLeft**: Player disconnect notification
- **Death**: Player death notification

### 6.3 Position Validation
- **Horizontal Thresholds**: 0.5-1.0m (soft), 2.0-3.0m (hard)
- **Vertical Thresholds**: 2.0-3.0m (soft), 5.0-7.0m (hard)
- **Extrapolation**: Physics-based (pos = pos0 + vel*t + 0.5*acc*t²)
- **Rewind Buffer**: 1000ms (100 snapshots at 10ms intervals)
- **Position Tolerance**: 200ms for hit detection

### 6.4 Rate Limiting
- **Shots**: 20 per second
- **Jumps**: 10 per second
- **Jetpack**: 5 per second
- **Total Messages**: 100 per second
- **Warning Cooldown**: 1 second per player

## 7. Performance Targets

### 7.1 Latency Targets
- **Input-to-Visual**: < 16ms (1 frame at 60fps)
- **Shot-to-Projectile**: 0ms (instant spawn)
- **Hit-to-Feedback**: 0ms (instant confirmation)
- **Movement-to-Position**: < 16ms (instant update)
- **Server Round-Trip**: < 100ms (for reconciliation)

### 7.2 Bandwidth Targets
- **Per Player**: < 42 KB/s (42000 bytes per second)
- **Packets Per Second**: 30 (at 30 ticks/sec)
- **Average Packet Size**: < 1400 bytes
- **Peak Packet Size**: < 1400 bytes (MTU-safe)

### 7.3 Server Targets
- **Tick Rate**: 30 ticks per second
- **Players Per Room**: 16-32
- **Rooms Per Server**: Multiple (horizontal scaling)
- **CPU Usage**: < 50% (with 32 players)
- **Memory Usage**: < 500MB (with 32 players)

## 8. Security Considerations

### 8.1 Anti-Cheat Measures
- Server-authoritative input processing
- Position validation with physics-aware thresholds
- Hit validation with distance checks
- Rate limiting on all actions
- Player ID validation to prevent injection

### 8.2 Input Validation
- Numeric validation (NaN/Infinity prevention)
- Vector validation (position/velocity limits)
- String validation (player ID format)
- Message size validation (prevent DoS)

### 8.3 State Validation
- Position history tracking for teleportation detection
- Velocity limits for speed hack detection
- Health validation for god mode detection
- Projectile validation for speed hack detection

## 9. Testing Requirements

### 9.1 Unit Tests
- BitStream serialization/deserialization
- EventManager ACK/retransmission
- GhostManager state mask updates
- MoveManager input collection
- PositionValidator extrapolation

### 9.2 Integration Tests
- Client-server message flow
- Reconnection with state restoration
- Lag compensation accuracy
- Rate limiting enforcement
- Position validation accuracy

### 9.3 Performance Tests
- Bandwidth usage with 32 players
- CPU usage with 32 players
- Memory leak detection
- Latency under load
- Packet loss handling

### 9.4 Security Tests
- Teleportation detection
- Speed hack detection
- God mode detection
- Injection attack prevention
- DoS attack prevention

## 10. Future Enhancements

### 10.1 Planned Features
- **Interpolation Improvements**: Extrapolation for high-latency players
- **Bandwidth Optimization**: Further delta compression
- **Scalability**: Horizontal scaling with multiple server instances
- **Analytics**: Connection quality metrics collection
- **Anti-Cheat**: Machine learning for anomaly detection

### 10.2 Research Areas
- **WebRTC**: For peer-to-peer voice chat
- **WebAssembly**: For performance-critical path
- **Service Workers**: For offline capability
- **WebGPU**: For enhanced graphics
- **WebTransport**: For next-generation networking

## 11. References

### 11.1 Inspirations
- **Tribes 2**: Bit-packing, state masks, client-side prediction
- **Krunker.io**: Browser-based FPS performance
- **Source Engine**: Lag compensation, interpolation
- **Quake 3**: Client-side prediction, reconciliation

### 11.2 Documentation
- WebSocket API: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- uWebSockets.js: https://github.com/uNetworking/uWebSockets.js
- msgpack-lite: https://github.com/kawanet/msgpack-lite
- Three.js: https://threejs.org/

## 12. Glossary

- **ACK**: Acknowledgment (confirmation of receipt)
- **Bit-packing**: Serializing data at bit level for efficiency
- **Client-side prediction**: Client simulates actions before server confirmation
- **Delta compression**: Sending only changes instead of full state
- **Ghost**: Remote player/object representation
- **Lag compensation**: Server rewinds state to validate past events
- **Reconciliation**: Correcting client state based on server authority
- **State mask**: Bitmask indicating which properties changed
- **Scoping**: Filtering objects based on relevance/interest
- **StreamManager**: Coordinates all networking managers
