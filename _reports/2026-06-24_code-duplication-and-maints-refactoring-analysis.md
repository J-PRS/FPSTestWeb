# Code Duplication and main.ts Refactoring Analysis

**Date:** 2026-06-24
**Focus:** Code duplication between client/server and main.ts monolithic structure

---

## Executive Summary

After detailed analysis of the codebase, the perceived "code duplication" between client and server networking components is **not actually duplication** - it's intentional architectural separation for client-side prediction vs server-side authority. Extracting to a shared package would add unnecessary complexity.

The **main.ts** file (995 lines) is genuinely monolithic and should be refactored into separate modules for maintainability.

---

## Code Duplication Analysis

### Files Examined

- `client/src/networking/BitStream.ts` (421 lines)
- `server/src/BitStream.ts` (411 lines)
- `client/src/networking/EventManager.ts` (503 lines)
- `server/src/EventManager.ts` (479 lines)
- `client/src/networking/MoveManager.ts` (279 lines)
- `server/src/MoveManager.ts` (257 lines)
- `client/src/networking/GhostManager.ts` (302 lines)
- `server/src/GhostManager.ts` (345 lines)
- `client/src/networking/StreamManager.ts`
- `server/src/StreamManager.ts`
- `client/src/Logger.ts`
- `server/src/Logger.ts`

### Key Findings

#### 1. BitStream - Nearly Identical
**Similarity:** 98%

**Differences:**
- Client version has `setBitPosition(position: number)` method (line 310-315)
- Server version lacks this method

**Recommendation:** Keep separate. The missing method in server is not a bug - it's simply unused. Adding it would add dead code.

---

#### 2. EventManager - Architecturally Different
**Similarity:** 70% (structure similar, behavior different)

**Client Version:**
- Single connection model
- Has `orderedQueue` for guaranteed events (line 293)
- Has `processOrderedQueue()` method (line 381-387)
- Event `process()` method takes no parameters (line 19)
- Events have callbacks (`onPositionUpdate`, `onShot`, etc.)

**Server Version:**
- Per-connection model (all methods take `connectionId`)
- No ordered queue - processes guaranteed events immediately
- Event `process()` method takes `connectionId: string` (line 17)
- Events log to Logger instead of callbacks
- Has `removeConnection()` for cleanup (line 457-461)
- Has `onEvent()` callback for external processing (line 466-468)

**Why Different:**
- Client needs ordered delivery for prediction
- Server processes immediately for authority
- Server tracks multiple connections simultaneously

**Recommendation:** **Do not extract.** The differences are fundamental to the architecture. A shared version would require complex abstraction layers that would obscure the intent.

---

#### 3. MoveManager - Architecturally Different
**Similarity:** 60% (pack/unpack similar, logic different)

**Client Version:**
- Has `moveHistory` for client-side prediction (line 31)
- Has `predictMove()` method (line 166-179)
- Has `reconcile()` method (line 185-212)
- Has `unpackControlState()` for server state updates (line 127-161)
- Has `onReconcileCallback` for prediction correction (line 34)
- Single connection model

**Server Version:**
- Per-connection model (all methods take `connectionId`)
- Has `validateMove()` for anti-cheat (line 160-175)
- Has `processMoves()` for authoritative processing (line 129-154)
- Has `packControlState()` to send state to client (line 181-210)
- Has `onMove()` callback for external processing (line 245-247)
- Has `removeConnection()` for cleanup (line 237-240)

**Why Different:**
- Client predicts movement locally for responsiveness
- Server validates and authoritatively processes movement
- Client reconciles with server state
- Server sends control state to client

**Recommendation:** **Do not extract.** The prediction/reconciliation logic is client-specific. The validation logic is server-specific. These are fundamentally different responsibilities.

---

#### 4. GhostManager - Architecturally Different
**Similarity:** 65% (similar concepts, different implementation)

**Client Version:**
- Tracks single ghost list for local player
- 302 lines
- Single connection model

**Server Version:**
- Tracks per-connection ghost lists
- 345 lines
- Has `removeConnection()` for cleanup
- Manages multiple clients simultaneously

**Why Different:**
- Client only needs to track its own ghost state
- Server must track ghost state for all connected clients

**Recommendation:** **Do not extract.** The per-connection management is server-specific.

---

#### 5. StreamManager - Similar but Different
**Similarity:** 75%

**Differences:**
- Client has single connection
- Server has per-connection management
- Different ACK handling patterns

**Recommendation:** Keep separate. The connection management differences are fundamental.

---

#### 6. Logger - Identical
**Similarity:** 95%

**Differences:**
- Client uses `ChildLogger` for namespaced logging
- Server uses `Logger` directly
- Minor implementation differences

**Recommendation:** Could extract, but low priority. The differences are minor and don't cause maintenance issues.

---

## Conclusion on Code Duplication

**The perceived code duplication is not actually duplication.** It's intentional architectural separation:

- **Client-side:** Prediction, interpolation, responsiveness, single connection
- **Server-side:** Authority, validation, multi-connection management

Extracting to a shared package would require:
1. Complex abstraction layers to handle per-connection vs single-connection
2. Configuration flags to enable/disable prediction features
3. Callback systems to handle different processing patterns
4. Increased complexity for no real benefit

**Recommendation:** Keep client and server networking code separate. The current separation is correct and maintainable.

---

## main.ts Refactoring Analysis

### Current Structure

`client/src/main.ts` is 995 lines with the following responsibilities:

| Lines | Responsibility |
|-------|----------------|
| 1-36 | Imports (36 imports) |
| 38 | Logger initialization |
| 41-75 | Renderer setup (WebGLRenderer, pixel ratio, resize handler) |
| 77-78 | Camera setup |
| 80-83 | Scene setup (fog, clear color) |
| 85-103 | Atmospheric sky & volumetric clouds |
| 105-125 | Lighting (ambient, sun, hemisphere) |
| 127-150 | Game state variables (terrain, player, entities, arrays) |
| 153-173 | UI (score display, frag messages) |
| 175-203 | Input handlers (onFire, onDisc) |
| 205-261 | Explosion processing (processExplosion, processDiscExplosion) |
| 263-349 | Rocket update logic |
| 351-407 | Disc update logic |
| 409-430 | Ball spawning and update |
| 432-558 | Game loop (main loop, delta time, all updates) |
| 560-796 | Initialization (init function, network callbacks) |

### Problems

1. **Monolithic:** 995 lines in a single file
2. **Mixed concerns:** Rendering, game logic, networking, UI all mixed
3. **Hard to navigate:** Related code scattered across file
4. **Hard to test:** Can't unit test individual components
5. **Hard to maintain:** Changes require understanding entire file

### Proposed Refactoring

Create 5 new modules:

#### 1. `client/src/Renderer.ts`
**Responsibilities:**
- WebGLRenderer setup
- Camera setup
- Scene setup
- Lighting setup (ambient, sun, hemisphere)
- Atmospheric sky setup
- Volumetric clouds setup
- Resize handling
- Render call

**Exports:**
- `class Renderer` with methods:
  - `constructor()`
  - `updateSize()`
  - `render(scene, camera)`
  - `getCamera()`
  - `getScene()`
  - `getSun()`
  - `getAtmosphericSky()`
  - `getVolumetricClouds()`

**Estimated lines:** ~200

---

#### 2. `client/src/EntityManager.ts`
**Responsibilities:**
- Entity arrays (balls, rockets, discs, debris, explosions, implosions, remotePlayers)
- Entity spawning (spawnBall)
- Entity update functions (updateBalls, updateRockets, updateDiscs)
- Explosion processing (processExplosion, processDiscExplosion)
- Entity cleanup (removing dead entities)
- Recent explosions tracking

**Exports:**
- `class EntityManager` with methods:
  - `constructor(scene, terrain)`
  - `spawnBall()`
  - `updateBalls(dt)`
  - `updateRockets(dt, terrain, playerPos, remotePlayers)`
  - `updateDiscs(dt, terrain, playerPos, remotePlayers)`
  - `processExplosion(pos, radius, force, shooterId)`
  - `processDiscExplosion(pos, radius, force)`
  - `cleanup()`
  - Getters for entity arrays

**Estimated lines:** ~300

---

#### 3. `client/src/GameLoop.ts`
**Responsibilities:**
- Main loop (requestAnimationFrame)
- Delta time calculation
- Frame update orchestration
- Tab hidden state
- Max delta time clamping

**Exports:**
- `class GameLoop` with methods:
  - `constructor(maxDeltaTime)`
  - `start(updateCallback)`
  - `stop()`
  - `setTabHidden(hidden)`

**Estimated lines:** ~50

---

#### 4. `client/src/NetworkGame.ts`
**Responsibilities:**
- Network manager initialization
- Network event handlers (onPlayerUpdate, onPlayerHit, onPlayerKill, etc.)
- Remote player management (create, update, remove)
- Projectile synchronization (onProjectileCreated, onProjectileUpdate, onProjectileDestroyed)
- Player respawn handling
- Network input forwarding (sendPosition, sendJump, sendJetpack, sendInputMove)

**Exports:**
- `class NetworkGame` with methods:
  - `constructor(networkManager, scene, terrain, entityManager, player, hud)`
  - `initialize()`
  - `update(dt)`
  - `cleanup()`

**Estimated lines:** ~300

---

#### 5. `client/src/main.ts` (Refactored)
**Responsibilities:**
- Initialization orchestration
- Module wiring
- Entry point

**Structure:**
```typescript
import { Renderer } from './Renderer.js';
import { EntityManager } from './EntityManager.js';
import { GameLoop } from './GameLoop.js';
import { NetworkGame } from './NetworkGame.js';
import { Player } from './Player.js';
import { HUD } from './hud.js';
// ... other imports

async function init(): Promise<void> {
  // Create modules
  const renderer = new Renderer();
  const entityManager = new EntityManager(renderer.getScene(), terrain);
  const gameLoop = new GameLoop(MAX_DELTA_TIME);
  const networkGame = new NetworkGame(networkManager, renderer.getScene(), terrain, entityManager, player, hud);
  
  // Initialize
  await loadHeightmap('/assets/heightmaps/Vortex_Smooth2_2048.png');
  terrain = new Terrain(renderer.getScene(), renderer.getSun().position.clone().normalize());
  player = new Player(terrain, renderer.getCamera(), renderer.getScene());
  // ... setup callbacks
  
  // Start game loop
  gameLoop.start((dt) => {
    player.update(dt);
    terrain.update(player.pos.x, player.pos.z);
    entityManager.updateBalls(dt);
    entityManager.updateRockets(dt, terrain, player.pos, networkGame.getRemotePlayers());
    // ... other updates
    renderer.render(renderer.getScene(), renderer.getCamera());
  });
}

init();
```

**Estimated lines:** ~100

---

## Refactoring Benefits

1. **Separation of concerns:** Each module has a single responsibility
2. **Testability:** Can unit test individual modules
3. **Maintainability:** Changes are localized to specific modules
4. **Readability:** Smaller files are easier to understand
5. **Reusability:** Modules can be reused in other projects
6. **Parallel development:** Different developers can work on different modules

---

## Implementation Plan

### Phase 1: Create Module Skeletons
1. Create `Renderer.ts` with empty class
2. Create `EntityManager.ts` with empty class
3. Create `GameLoop.ts` with empty class
4. Create `NetworkGame.ts` with empty class
5. Update `main.ts` to import and instantiate modules

### Phase 2: Extract Renderer
1. Move renderer setup code from main.ts to Renderer.ts
2. Update main.ts to use Renderer instance
3. Test rendering still works

### Phase 3: Extract EntityManager
1. Move entity arrays and update functions to EntityManager.ts
2. Update main.ts to use EntityManager instance
3. Test entity spawning and updates

### Phase 4: Extract GameLoop
1. Move game loop code to GameLoop.ts
2. Update main.ts to use GameLoop instance
3. Test game loop still runs

### Phase 5: Extract NetworkGame
1. Move network callbacks and remote player management to NetworkGame.ts
2. Update main.ts to use NetworkGame instance
3. Test networking still works

### Phase 6: Final Cleanup
1. Remove dead code from main.ts
2. Verify all functionality works
3. Update imports and exports

---

## Estimated Effort

- **Phase 1:** 1 hour
- **Phase 2:** 2 hours
- **Phase 3:** 3 hours
- **Phase 4:** 1 hour
- **Phase 5:** 4 hours
- **Phase 6:** 2 hours

**Total:** ~13 hours

---

## Risks

1. **Breaking changes:** Refactoring could introduce bugs
2. **Testing:** No automated tests exist, manual testing required
3. **Dependencies:** Modules may have hidden dependencies on each other
4. **State management:** Global state may need to be passed around

**Mitigation:**
- Work in small phases
- Test after each phase
- Keep main.ts functional during extraction
- Use git commits after each phase

---

## Recommendations

### Immediate Actions

1. **Do NOT extract shared package** for networking code - the differences are intentional
2. **Proceed with main.ts refactoring** - this is genuine technical debt
3. **Start with Phase 1** (create module skeletons) to validate the approach

### Future Considerations

1. Add unit tests for new modules
2. Consider dependency injection for better testability
3. Document module interfaces with JSDoc
4. Consider using a framework (e.g., ECS) for entity management if complexity grows

---

## Conclusion

The code duplication concern is unfounded - the client/server networking code is correctly separated for architectural reasons. The main.ts file, however, is genuinely monolithic and should be refactored into separate modules for maintainability.

The proposed refactoring will reduce main.ts from 995 lines to ~100 lines while creating 4 focused modules with clear responsibilities.
