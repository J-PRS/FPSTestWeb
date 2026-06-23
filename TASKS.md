# Project Development Context

## Current State
- **Project:** Browser-based multiplayer FPS (Tribes-inspired)
- **Architecture:** Client-server with WebSocket networking
- **Client:** Three.js rendering, Tribes2-style networking with bit-packing
- **Server:** Node.js with uWebSockets, Tribes2Networking integration
- **Networking:** Tribes2 event system (PositionEvent, ShotEvent), bit-packed streams
- **Security:** Position validation (three-tier: accept/nudge/snap)
- **Recent Changes:** Completed Tribes2 networking integration (Phase 50)

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
- **Objective:** Complete Tribes2-style networking integration
- **Requirements:**
  1. Wire Tribes2Networking managers to MessageHandler for event/move processing
  2. Remove deprecated network adapters (WSAdapter, UWSAdapter)
  3. Test end-to-end Tribes2 networking with client and server
  4. Update documentation (TASKS.md, changelog.txt)
- **Dependencies:** None (can start immediately)
- **Success Criteria:**
  - Tribes2Networking EventManager and MoveManager properly wired to callbacks
  - NetworkAdapterFactory simplified to only support Tribes2 backend
  - End-to-end testing confirms binary protocol works correctly
  - Documentation updated with integration progress

## Next Tasks
- **Priority: High**
  - Test Tribes2 networking with actual gameplay
  - Verify MoveManager input handling
  - Test GhostManager state synchronization
- **Priority: Medium**
  - Remove deprecated files (server_old.ts, BinaryProtocol.ts if unused)
  - Add unit tests for EventManager
  - Update architecture.txt with Tribes2 components
- **Priority: Low**
  - Performance benchmark Tribes2 vs old protocol
  - Add more event types (jump, jetpack, etc.)

2. **Improve client-side prediction reconciliation**
   - Dependencies: Task 1
   - Complexity: High
   - Location: `client/src/main.ts:788-798`
   - Description: Implement input replay - re-simulate all unprocessed inputs from reconciliation point

3. **Add rate limiting on critical messages**
   - Dependencies: None
   - Complexity: Medium
   - Location: `server/src/MessageHandler.ts`
   - Description: Implement per-player rate limiting for shots, jumps, jetpack

4. **Complete binary protocol**
   - Dependencies: None
   - Complexity: Low
   - Location: `client/src/networking/BinaryProtocol.ts`
   - Description: Implement missing decodePositionDelta function

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
