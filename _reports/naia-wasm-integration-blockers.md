# Naia WASM Integration Blockers

## Current Status
Naia server is implemented and running on UDP port 14193. WASM client structure created but blocked.

## Blockers

### 1. Rust Toolchain
- `rustup` not available in PATH
- Need to install rustup and add `wasm32-unknown-unknown` target
- Command: `rustup target add wasm32-unknown-unknown`

### 2. wasm-pack Build
- wasm-pack installed but cannot find wasm32 target
- Error: "cannot find binary path" when running `wasm-pack build`

### 3. WebRTC Signaling Infrastructure
- Naia's WebRTC transport requires a signaling server for peer connection establishment
- The server URL passed to `webrtc::Socket::new()` must point to a WebRTC signaling server
- This is not the same as the Naia UDP server - it's a separate signaling component
- Naia docs reference this but don't provide a simple signaling server implementation

### 4. Complex WorldMutType Trait
- Naia's `WorldMutType` trait requires ~20+ methods for full entity replication
- Minimal stub implementation insufficient for actual gameplay
- Would need full ECS integration or complex stub implementation

## Recommendation
Given the goal of reducing tech debt and the complexity of Naia WASM integration:

**Pursue Colyseus instead:**
- Already working with TypeScript client
- No WASM compilation required
- Native JavaScript SDK
- Simpler architecture
- Reduces overall tech debt

**Naia server can remain as:**
- Reference implementation for native clients
- Future option if native client is needed
- Learning resource for Rust networking

## Next Steps
1. Improve existing ColyseusAdapter implementation
2. Add room management to Colyseus server
3. Implement player state synchronization
4. Test multiplayer with multiple clients
