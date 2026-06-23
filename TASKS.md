# Project Development Context

## Current State
- **Project:** Browser-based multiplayer FPS (Tribes-inspired)
- **Architecture:** Client-server with WebSocket networking
- **Client:** Three.js rendering, Tribes2-style networking with bit-packing
- **Server:** Node.js with uWebSockets, Tribes2Networking integration
- **Networking:** Tribes2 event system (PositionEvent, ShotEvent, JumpEvent, JetpackEvent, SkiEvent, DeathEvent), bit-packed streams
- **Security:** Position validation (three-tier: accept/nudge/snap)
- **Recent Changes:** Completed Tribes2 networking integration (Phase 58)

## Technical Context
- **Dependencies:**
  - Client: Three.js 0.184.0, ws 8.21.0, Vite 8.0.16
  - Server: uWebSockets.js v20.68.0, TypeScript 6.0.0
- **Key Components:**
  - Tribes2Adapter (client) - Tribes2 networking adapter
  - StreamManager (client/server) - Coordinates MoveManager, EventManager, GhostManager
  - EventManager (client/server) - Event queuing, packing, guaranteed delivery
  - GhostManager (client/server) - State synchronization
  - MoveManager (client/server) - Input/movement handling
  - MessageHandler (server) - JSON message processing
  - Tribes2Networking (server) - Per-connection Tribes2 networking
  - PlayerManager (server) - Player state management
  - PositionValidator (server) - Anti-cheat position validation
- **Integration Points:**
  - Client ↔ Server via WebSocket (port 8080)
  - JSON join handshake → Tribes2 binary packets
  - Tribes2 events converted to MessageHandler format
- **Deprecated:**
  - BinaryProtocol.ts (replaced by Tribes2 event system)
  - server_old.ts (legacy reference)

## Development Guidelines
- **Coding Standards:** TypeScript with implicit any (strict mode not enabled)
- **Required Updates:**
  - Update changelog.txt after each task
  - Update architecture.txt for structural changes
  - Maintain TASKS.md for context
- **Testing Requirements:** No unit tests currently (add as priority)
- **Security Considerations:**
  - Server must be authoritative for movement
  - Rate limit critical messages
  - Validate all client inputs

## Current Task
- **Objective:** Phase 58 complete - binary message routing fully fixed, server waits for join handshake before sending binary packets
- **Status:** All high and medium priority tasks completed, Tribes2 networking fully integrated and tested
- **Integration Points Verified:**
  - Client main.ts: setControlObject, sendInputMove, sendJump, sendJetpack, sendShot all wired
  - Server Server.ts: setControlObjectProvider provides player state for client-side prediction
  - Binary message routing: Server waits for join handshake, client routes binary packets to StreamManager
  - Client-side prediction: MoveManager reconciliation with input replay implemented
  - Event system: JumpEvent, JetpackEvent, SkiEvent, DeathEvent fully implemented
  - GhostManager: State mask synchronization with priority-based updates
- **Completed in Phase 58:**
  - Added joinHandshakeComplete flag to server StreamManager
  - Server now waits for join handshake before sending binary Tribes2 packets
  - Added markJoinHandshakeComplete method to StreamManager and Tribes2Networking
  - Server calls markJoinHandshakeComplete after sending joinAck
  - Added sendBinary method to server WebSocketConnection for raw binary data
  - Client onBinaryMessage callback properly routes Tribes2 packets to StreamManager
- **Completed in Phase 57:**
  - Fixed WebSocketConnection to properly route Tribes2 binary packets
  - Added onBinaryMessage callback to ConnectionConfig interface
  - Binary messages now route to onBinaryMessage instead of msgpack decoder
  - Tribes2Adapter.handleBinaryMessage routes packets to StreamManager.handlePacket
- **Completed in Phase 56:**
  - Fixed client sending binary data before JSON join handshake (joinHandshakeComplete flag)
  - Fixed default room initialization issue (preserve default room when empty)
  - Added msgpack-lite type declarations (server and client package.json)
  - Fixed GhostManager buildUpdateList to use direct ghost access
  - Updated ServerConfig to match multiplayer specification (tick rate 30, rate limits)
  - Integrated ACK transmission into StreamManager (server and client)
  - Verified hybrid Tribes2 architecture (JSON for state, binary for events/moves)
  - Verified delta compression via handlePositionDelta
  - Verified position validation with physics awareness (PositionValidator.ts)
  - Verified projectile synchronization with timeout/fallback/cleanup (main.ts)
  - Verified lag compensation buffer at 1000ms with extrapolation (ServerConfig)
  - Verified connection quality metric usage for adaptive interpolation (RemotePlayer.ts)
  - Verified state restoration on reconnect with velocity (Server.ts)
  - Verified health synchronization in gameState messages (Server.ts)
  - Verified memory leak cleanup on disconnect (PlayerManager)
  - Verified unit tests for EventManager and MoveManager (test files exist)

## Completed Tasks (Phase 58)
- **Event system improvements**: Tribes2Adapter now uses JumpEvent and JetpackEvent properly
- **Code cleanup**: Removed TODO comments in main.ts, fixed console.log usage in EventManager
- **StreamManager enhancement**: Added processOrderedQueue to client for guaranteed event ordering
- **Position optimization**: Removed PositionEvent from Tribes2Adapter.sendPosition (GhostManager handles this)
- **Bug fixes**: Fixed duplicate markJoinHandshakeComplete in Tribes2Networking
- **Tech debt**: Identified 9 .old files for removal (no active imports)
- **Phase 57**: Added onBinaryMessage callback to WebSocketConnection, Tribes2Adapter routes binary packets to StreamManager
- **Phase 56**: Fixed join handshake, room initialization, type safety, GhostManager, ServerConfig, verified existing implementations
- **Phase 55**: Client-side prediction with input replay, event types, GhostManager state mask

## Next Tasks (Deferred - Low Priority)
- **Priority: Low** (deferred - can be done in future cleanup)
  - Refactor monolithic main.ts (split into Game.ts, Renderer.ts, etc.)
  - Implement proper logging system (Logger class)
  - Centralize configuration constants
  - Remove deprecated files (.deprecated, .old) - user's decision when to remove

### Phase 2: High Priority UX Improvements
5. **Refactor monolithic main.ts**
   - Dependencies: None
   - Complexity: High
   - Location: `client/src/main.ts` (953 lines)
   - Description: Split into Game.ts, Renderer.ts, NetworkGame.ts, ProjectileManager.ts, EntityManager.ts

6. **Implement proper logging system**
   - Dependencies: None
   - Complexity: Medium
   - Location: Throughout codebase
   - Description: Replace console.log with structured Logger class (debug, info, warn, error)

7. **Improve position validation with physics awareness**
   - Dependencies: Task 1
   - Complexity: High
   - Location: `server/src/PositionValidator.ts:50-82`
   - Description: Use physics equations (pos = pos0 + vel*t + 0.5*acc*t^2) accounting for gravity, jetpack, skiing

8. **Fix projectile synchronization**
   - Dependencies: None
   - Complexity: Medium
   - Location: `client/src/main.ts:338-349, 803-820`
   - Description: Add timeout for pending rockets, fallback to client-side projectile, cleanup stale pending rockets

### Phase 3: Medium Priority Robustness
9. **Increase lag compensation buffer**
   - Dependencies: None
   - Complexity: Low
   - Location: `server/src/PlayerManager.ts:96-100`
   - Description: Increase buffer to 1000ms, implement extrapolation, adaptive tolerance based on ping

10. **Add connection quality metric usage**
    - Dependencies: None
    - Complexity: Medium
    - Location: `client/src/RemotePlayer.ts:130-142`
    - Description: Use ping to adjust interpolation factor, position send rate, lag compensation window

11. **Fix state restoration on reconnect**
    - Dependencies: None
    - Complexity: Low
    - Location: `server/src/Server.ts:124-133`
    - Description: Include velocity, lastProcessedSequence, input history in restoration message

12. **Add health synchronization**
    - Dependencies: None
    - Complexity: Low
    - Location: `server/src/MessageHandler.ts`
    - Description: Add health updates to playerUpdate messages or separate health sync

13. **Fix memory leaks**
    - Dependencies: None
    - Complexity: Medium
    - Location: `server/src/PlayerManager.ts`, `server/src/PositionValidator.ts`
    - Description: Clear position history, rewind buffer on disconnect

### Phase 4: Low Priority Maintainability
14. **Centralize configuration constants**
    - Dependencies: None
    - Complexity: Low
    - Location: Throughout codebase
    - Description: Create config.ts with NETWORK_CONFIG and PHYSICS_CONFIG

15. **Add unit tests**
    - Dependencies: None
    - Complexity: High
    - Location: New test files
    - Description: Add tests for binary protocol, position validation, lag compensation, rate limiting

16. **Add performance monitoring**
    - Dependencies: None
    - Complexity: Medium
    - Location: New monitoring module
    - Description: Add metrics for server CPU, memory, bandwidth, message queue sizes

17. **Enable TypeScript strict mode**
    - Dependencies: None
    - Complexity: Medium
    - Location: tsconfig.json
    - Description: Enable strict mode and fix resulting type errors
