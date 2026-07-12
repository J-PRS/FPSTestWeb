# Naia Integration Report

## Executive Summary

This report documents the integration of Naia networking library into the FPS Web Test project, including server implementation, shared protocol definition, WASM client setup, and future plans.

## Completed Work

### 1. Naia Server Implementation

**Location:** `server_naia/`

**Components Created:**
- `Cargo.toml` - Dependencies configured with naia-server 0.25, tokio, log, env_logger
- `src/main.rs` - UDP server implementation with:
  - Server listening on 0.0.0.0:14193
  - Connection event handling (ConnectEvent, DisconnectEvent)
  - Room management with main room creation
  - User acceptance and room assignment
  - Main loop with packet receive/send at 20Hz (50ms tick interval)
- `src/protocol.rs` - Shared protocol definition (later moved to shared_protocol crate)
- `_build.bat` - Build script for release compilation
- `_run.bat` - Run script with RUST_LOG=info enabled

**Status:** ✅ Server compiles and runs successfully on UDP port 14193

### 2. Shared Protocol Library

**Location:** `shared_protocol/`

**Components Created:**
- `Cargo.toml` - Library with naia-shared 0.25 dependency
- `src/lib.rs` - Protocol definition including:
  - Components: Position, Rotation, Velocity, Health (all with Property<T> fields)
  - Messages: PlayerInput, ShotEvent
  - Protocol builder with 50ms tick interval and default channels

**Status:** ✅ Shared protocol compiles and is used by both server and client

### 3. Server Refactoring

**Changes:**
- Updated `server_naia/Cargo.toml` to depend on `shared_protocol` instead of local protocol.rs
- Removed local `src/protocol.rs` file
- Updated imports in `src/main.rs` to use `shared_protocol::protocol`

**Status:** ✅ Server now uses shared protocol library

### 4. WASM Client Structure

**Location:** `client_wasm/` and `client_app/`

**Components Created:**

**client_app/ (Core Logic):**
- `Cargo.toml` - Library with naia-client-socket 0.25 and wbindgen feature
- `src/lib.rs` - NaiaClient struct with stub implementation (connect, disconnect, update, send methods)

**client_wasm/ (WASM Bindings):**
- `Cargo.toml` - WASM library depending on client_app with wbindgen feature
- `src/lib.rs` - NaiaWasmClient wasm-bindgen wrapper exposing methods to JavaScript
- `_build.bat` - Build script using wasm-pack

**Status:** ⚠️ Structure created but stub implementation needs full Naia client logic

### 5. Documentation

**Reports Created:**
- `_reports/naia-framework-analysis.md` - Detailed analysis of Naia architecture
- `_reports/naia-wasm-integration-blockers.md` - Documented blockers for WASM integration

**Status:** ✅ Documentation completed

## Current Blockers

### 1. Rust Toolchain
- **Issue:** `rustup` not available in PATH
- **Impact:** Cannot add wasm32-unknown-unknown target
- **Solution:** Install rustup for Windows

### 2. WASM Build
- **Issue:** wasm-pack cannot find wasm32 target
- **Impact:** Cannot compile Rust to WASM
- **Solution:** Run `rustup target add wasm32-unknown-unknown` after installing rustup

### 3. WebRTC Signaling
- **Issue:** Naia's WebRTC transport requires a signaling server
- **Impact:** Browser clients cannot establish peer connections
- **Solution:** 
  - Option A: Use Naia's provided signaling server
  - Option B: Implement simple WebSocket-based signaling server
  - Option C: Use third-party signaling service

### 4. WorldMutType Implementation
- **Issue:** Naia's WorldMutType trait requires ~20+ methods for full entity replication
- **Impact:** Cannot use full Naia client features without implementing these methods
- **Solution:** Implement full WorldMutType or use simplified approach without entity replication initially

## Architecture

### Current Setup

```
FPSWebTest/
├── server_naia/          # Naia UDP server (Rust)
│   ├── src/
│   │   └── main.rs       # Server implementation
│   ├── Cargo.toml
│   ├── _build.bat
│   └── _run.bat
├── shared_protocol/      # Shared protocol library (Rust)
│   ├── src/
│   │   └── lib.rs        # Protocol definition
│   └── Cargo.toml
├── client_app/           # Core client logic (Rust)
│   ├── src/
│   │   └── lib.rs        # NaiaClient (stub)
│   └── Cargo.toml
├── client_wasm/          # WASM bindings (Rust)
│   ├── src/
│   │   └── lib.rs        # NaiaWasmClient (wasm-bindgen)
│   ├── Cargo.toml
│   └── _build.bat
└── client/               # TypeScript client (existing)
    └── src/
        └── networking/
            └── NaiaAdapter.ts  # TypeScript adapter (stub)
```

### Data Flow

1. **Server:** UDP socket on port 14193, processes packets at 20Hz
2. **Protocol:** Shared between server and client via shared_protocol crate
3. **Client:** WASM module compiled from Rust, imported into TypeScript
4. **Transport:** WebRTC for browser clients (requires signaling server)

## Future Plan

### Phase 1: Unblock WASM Build (Immediate)

1. **Install rustup**
   - Download rustup-init.exe from https://win.rustup.rs/x86_64
   - Run installer
   - Restart terminal

2. **Add WASM target**
   ```bash
   rustup target add wasm32-unknown-unknown
   ```

3. **Test WASM build**
   ```bash
   cd client_wasm
   wasm-pack build --target web --out-dir ../client/pkg
   ```

### Phase 2: Implement Full Naia Client

1. **Implement WorldMutType**
   - Add all required methods to client world
   - Or use simplified approach without entity replication initially
   - Start with basic message passing only

2. **Implement actual Naia client logic**
   - Replace stub in client_app with real naia-client usage
   - Implement connection, packet receive/send
   - Add message handling

3. **Set up WebRTC signaling**
   - Implement simple signaling server (Node.js/Express)
   - Or use Naia's provided signaling server
   - Configure client to connect to signaling server

### Phase 3: Integrate with TypeScript Client

1. **Import WASM module**
   - Add WASM package to client/package.json
   - Import in NaiaAdapter.ts
   - Replace stub with actual WASM calls

2. **Update NaiaAdapter**
   - Connect to WASM module
   - Handle connection events
   - Pass messages to/from game logic

3. **Test integration**
   - Start Naia server
   - Start signaling server
   - Run TypeScript client
   - Verify connection and message flow

### Phase 4: Full Multiplayer Features

1. **Entity replication**
   - Implement full WorldMutType
   - Add entity spawn/despawn handling
   - Sync component updates

2. **Room management**
   - Multiple rooms/lobbies
   - Room switching
   - Player limits

3. **Advanced features**
   - Client-side prediction
   - Lag compensation
   - Authority delegation

## Alternative Approach Considered

### Colyseus Integration

**Pros:**
- Native TypeScript/JavaScript SDK
- No WASM compilation required
- Simpler architecture
- Already has working adapter

**Cons:**
- Different from Naia server
- Would require maintaining two server implementations
- Not aligned with original Naia goal

**Decision:** Continue with Naia WASM integration as originally planned

## Technical Debt

### Current Debt
- NaiaAdapter.ts is a stub implementation
- client_app has stub NaiaClient
- No WebRTC signaling server
- rustup not installed

### Debt Reduction
- Completing Naia WASM integration will eliminate most debt
- Single networking stack (Naia) instead of multiple
- Shared protocol reduces duplication
- Rust type safety improves reliability

## Success Criteria

### Short-term (1-2 weeks)
- ✅ Naia server running and tested
- ✅ Shared protocol library created
- ⏳ WASM build working
- ⏳ Basic client connection to server

### Medium-term (1 month)
- ⏳ Full entity replication
- ⏳ Room management
- ⏳ Multiple players in same room
- ⏳ Basic gameplay synchronization

### Long-term (2-3 months)
- ⏳ Client-side prediction
- ⏳ Lag compensation
- ⏳ Advanced multiplayer features
- ⏳ Production-ready deployment

## Recommendations

1. **Prioritize unblocking WASM build** - This is the critical path
2. **Start with message-only approach** - Implement full entity replication later
3. **Use simple signaling server** - Don't over-engineer initially
4. **Test incrementally** - Verify each step before proceeding
5. **Document decisions** - Keep track of architecture choices

## Conclusion

Naia integration is well-structured with shared protocol, working server, and proper WASM client architecture. The main blockers are toolchain-related (rustup, wasm32 target) and infrastructure (signaling server). Once these are resolved, the integration can proceed smoothly.

The decision to continue with Naia WASM integration aligns with the original goal of reducing tech debt by having a single, type-safe networking stack across server and client.
