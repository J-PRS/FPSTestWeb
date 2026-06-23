# Tech Debt Report

**Date:** 2026-06-23  
**Scope:** Server and Client codebase  
**Focus:** Code quality, type safety, and architectural improvements

## Executive Summary

This report identifies and categorizes technical debt across the FPS multiplayer game codebase. The investigation focused on TODO comments, console logging practices, TypeScript type safety, and architectural improvements.

**Key Findings:**
- 7 TODO comments across server and client code
- ~70 console.log/warn/error statements in client code (no centralized logging)
- Extensive use of `any` type in server code (WebSocket and message types)
- Missing TypeScript interfaces for network messages
- Client-side prediction needs input replay implementation

## High Priority Issues

### 1. Tab Visibility Input Handling
**Location:** `client/src/main.ts`  
**Status:** Already tracked in TODO list  
**Impact:** Players can fire projectiles when tab is hidden/alt-tabbed, causing kills while appearing stationary  
**Recommendation:** Disable input processing when `document.hidden` is true

## Medium Priority Issues

### 2. Client-Side Logging System
**Location:** Client codebase (main.ts, NetworkManager.ts, WSAdapter.ts, etc.)  
**Current State:**
- ~50 console.log statements
- ~10 console.warn statements  
- ~10 console.error statements
- Scattered across 8 files

**Impact:**
- Inconsistent logging format
- No log level control
- Difficult to debug in production
- Server has Logger.ts but client does not

**Recommendation:**
- Create `client/src/Logger.ts` matching server implementation
- Support DEBUG, INFO, WARN, ERROR levels
- Add environment variable for log level control
- Replace all console statements with Logger calls

**Files to Update:**
- `client/src/main.ts` (30+ console statements)
- `client/src/networking/NetworkManager.ts` (15+ console statements)
- `client/src/networking/WSAdapter.ts` (5+ console statements)
- `client/src/WorkerNetworkManager.ts` (3 console statements)
- `client/src/networking/networking.worker.ts` (2 console statements)
- `client/src/PlayerModel.ts` (4 console statements)
- `client/src/rocket.ts` (2 console statements)
- `client/src/disc.ts` (1 console statement)

### 3. TypeScript Interfaces for WebSocket Types
**Location:** Server codebase  
**Current State:**
- `any` type used for uWS.js WebSocket in multiple locations
- uWS.js library has poor TypeScript support

**Files Affected:**
- `server/src/types.ts:6` - `ws: any`
- `server/src/Server.ts:23` - `private app: any`
- `server/src/Server.ts:54,57,60` - WebSocket handler parameters
- `server/src/PlayerManager.ts:12` - `Map<any, string>`
- `server/src/PlayerManager.ts:27,35,66` - Method parameters

**Impact:**
- No type safety for WebSocket operations
- Potential runtime errors
- Poor IDE autocomplete

**Recommendation:**
- Create custom WebSocket interface based on uWS.js documentation
- Use type assertions where necessary
- Document type limitations due to library constraints

### 4. TypeScript Interfaces for Message Types
**Location:** `server/src/BinaryProtocol.ts`, `server/src/MessageHandler.ts`  
**Current State:**
- All decoder functions return `any`
- MessageHandler uses `any` for message parameters
- No compile-time validation of message structure

**Files Affected:**
- `server/src/BinaryProtocol.ts:253,276,305,320,399` - Decoder return types
- `server/src/MessageHandler.ts:24,32,113,186,254,332,517` - Method parameters

**Impact:**
- No type safety for network messages
- Difficult to refactor message structure
- Potential runtime errors from malformed messages

**Recommendation:**
- Create interfaces for each message type (Join, Input, Position, Shot, etc.)
- Update decoder functions to return typed interfaces
- Update MessageHandler to use typed parameters
- Add runtime validation where necessary

**Example Interface:**
```typescript
interface ShotMessage {
  targetId: string | null;
  timestamp: number;
  position?: { x: number; y: number; z: number };
  velocity?: { x: number; y: number; z: number };
  projectileId?: string | null;
}
```

### 5. Input Replay for Client-Side Prediction
**Location:** `client/src/main.ts:637`  
**Current State:**
- TODO comment exists
- Current reconciliation snaps to server position
- No input replay for smooth correction

**Impact:**
- Snapping causes visual glitches
- Poor player experience during reconciliation
- Prediction correction is jarring

**Recommendation:**
- Implement input buffer on client
- On reconciliation, replay unprocessed inputs from server state
- Smoothly interpolate to corrected position
- Document in architecture.txt

## Low Priority Issues

### 6. Heightmap Loading in SimpleTerrain
**Location:** `server/src/SimpleTerrain.ts`  
**Current State:**
- 4 TODO comments (lines 15, 20, 26, 35)
- Server uses flat terrain (y = 0)
- No heightmap file loading

**Impact:**
- Server terrain doesn't match client
- Potential position validation issues
- No terrain-based gameplay features

**Recommendation:**
- Implement heightmap file loading (PNG/heightmap format)
- Sample height values for collision detection
- Calculate normals from heightmap gradients
- Sync heightmap with client

### 7. Shot Visualization
**Location:** `client/src/networking/NetworkManager.ts:463`  
**Current State:**
- TODO comment exists
- No visual feedback for shots
- Players can't see where shots land

**Impact:**
- Poor visual feedback
- Difficult to aim without visual confirmation

**Recommendation:**
- Add visual indicators for shot impacts
- Show hit markers on successful hits
- Add tracer lines for projectiles
- Consider impact on performance

## Code Quality Metrics

### Type Safety
- **Server:** ~60% typed (extensive `any` usage)
- **Client:** ~80% typed (better but room for improvement)

### Logging
- **Server:** Centralized (Logger.ts) ✅
- **Client:** Scattered (console.*) ❌

### Documentation
- **TODO comments:** 7 total
- **Architecture docs:** Partial (architecture.txt exists)
- **Changelog:** Comprehensive (changelog.txt)

## Recommended Action Plan

### Phase 1: High Impact (Week 1)
1. Implement client-side logging system
2. Add TypeScript interfaces for message types
3. Fix tab visibility input handling

### Phase 2: Type Safety (Week 2)
1. Add WebSocket type interfaces
2. Update all decoder functions to return typed values
3. Update MessageHandler to use typed parameters

### Phase 3: Gameplay Improvements (Week 3)
1. Implement input replay for client-side prediction
2. Add shot visualization
3. Implement heightmap loading

## Conclusion

The codebase has moderate technical debt, primarily in type safety and logging consistency. The most impactful improvements are:

1. **Client-side logging** - Immediate benefit for debugging
2. **TypeScript interfaces** - Long-term maintainability
3. **Input replay** - Player experience improvement

The server's recent refactoring (Logger.ts, config.ts) provides a good foundation for extending these patterns to the client side.
