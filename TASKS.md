# Project Development Context

## Current State
- **Project:** Browser-based multiplayer FPS (Tribes-inspired)
- **Architecture:** Client-server with WebSocket networking
- **Client:** Three.js rendering, worker-based networking
- **Server:** Node.js with uWebSockets, 15Hz tick rate
- **Networking:** Binary protocol with delta compression, lag compensation
- **Security:** Position validation (three-tier: accept/nudge/snap)
- **Recent Changes:** None documented

## Technical Context
- **Dependencies:**
  - Client: Three.js 0.184.0, ws 8.21.0, Vite 8.0.16
  - Server: uWebSockets.js v20.68.0, TypeScript 6.0.0
- **Key Components:**
  - NetworkManager (client) - Worker-based networking proxy
  - MessageHandler (server) - Processes incoming messages
  - PlayerManager (server) - Player state management
  - PositionValidator (server) - Anti-cheat position validation
  - BinaryProtocol - Efficient binary encoding/decoding
- **Integration Points:**
  - Client ↔ Server via WebSocket (port 8080)
  - Worker ↔ Main thread via postMessage
  - Remote player interpolation in game loop

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
- **Objective:** Fix critical multiplayer security vulnerabilities
- **Requirements:**
  1. Implement server-authoritative input processing
  2. Fix client-side prediction with input replay
  3. Add rate limiting on critical messages
  4. Complete binary protocol (decodePositionDelta)
- **Dependencies:** None (can start immediately)
- **Success Criteria:**
  - Server processes inputs to update position authoritatively
  - Client reconciles state by replaying unprocessed inputs
  - Rate limiting prevents message spam
  - Binary protocol fully functional

## Next Tasks

### Phase 1: Critical Security Fixes (High Priority)
1. **Implement server-authoritative input processing**
   - Dependencies: None
   - Complexity: High
   - Location: `server/src/MessageHandler.ts:102-127`
   - Description: Add server-side physics simulation that processes input sequence numbers to update player position authoritatively

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
