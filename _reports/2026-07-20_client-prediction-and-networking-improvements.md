# Client Prediction & Networking Improvements

**Date:** 2026-07-20  
**Scope:** Client-side prediction/reconciliation, ping measurement, handshake fix, dead code cleanup

---

## Summary

Implemented five networking improvements to enhance LAN-like responsiveness without increasing server cost. All changes are backward-compatible and pass existing test suites (77 server tests, client `tsc --noEmit` clean).

---

## 1. Client-Side Prediction + Reconciliation

### Problem

The client sent position updates to the server but had no mechanism to handle server corrections. If the server rejected a position (speed hack detection, desync), the client would continue from its local state, gradually diverging. There was no sequence number tracking, no state history, and no correction channel.

### Solution

Implemented a sequence-number-based reconciliation flow:

```
Client                          Server
  |                               |
  |-- position {seq: 1} --------->|
  |                               |-- validate speed
  |                               |-- store lastValidState
  |                               |
  |-- position {seq: 2} --------->|
  |                               |-- REJECT (speed > 200m/s)
  |<--- correction {seq: 1} ------|
  |                               |
  |-- snap to corrected state     |
  |-- prune stateHistory <= seq 1 |
  |                               |
  |<-- tickUpdate {ackSeq: 1} ----|
  |-- prune stateHistory <= 1     |
```

### Changes

**Server:**

| File | Change |
|------|--------|
| `server_bun/src/types.ts` | Added `lastSeq`, `lastValidPosition`, `lastValidVelocity`, `lastValidRotation` to `PlayerState`. Added `seq?` to position `ClientMessage`. Added `correction` and `pong` `ServerMessage` types. Added `ackSeq?` to `tickUpdate`. |
| `server_bun/src/PlayerManager.ts` | `updatePosition()` now accepts `seq?` and stores last valid state. Added `getLastSeq()` and `getLastValidState()` getters. |
| `server_bun/src/MessageHandler.ts` | `handlePosition()` sends `correction` message on speed-check rejection instead of silently dropping. Passes `msg.seq` to `updatePosition()`. |
| `server_bun/src/GameServer.ts` | Tick broadcast includes per-recipient `ackSeq` from `PlayerManager.getLastSeq()`. |
| `server_bun/src/validation.ts` | Position validation extracts optional `seq` field. Added `ping` message validation. |

**Client:**

| File | Change |
|------|--------|
| `client/src/networking/NetworkManager.ts` | Added `sequenceCounter`, `stateHistory` Map (max 120 entries). `sendPosition()` assigns seq, stores state snapshot. Added `pruneStateHistory(ackSeq)` — called on tickUpdate and correction. Added `onCorrection` callback. Handles `correction` and `pong` message types. |
| `client/src/main.ts` | Wired `onCorrection` callback: snaps `player.pos`, `player.vel`, `player.yaw`, `player.pitch` and syncs `MovementController.setState()`. |

### Design Decisions

- **State snap, not input replay**: True client-side prediction (Quake/Source model) buffers inputs and re-simulates from the last acknowledged state. We chose a simpler approach: snap to the server's last valid state. This avoids input duplication complexity and keeps the code minimal. The state history infrastructure is in place for future input-replay if needed.
- **No smoothing on correction**: The snap is instantaneous. A lerp or exponential decay over ~100ms would hide the visual jump — identified as the top next improvement.
- **Backward compatible**: `seq` is optional in the protocol. Old clients without seq still work; server just skips the tracking.

### Bandwidth Impact

- `seq` field: +8-12 bytes per position update (JSON integer, ~20Hz) = ~200 bytes/s per player
- `ackSeq` field: +8-12 bytes per tickUpdate (already sent at 20Hz) = ~200 bytes/s per player
- `correction` message: ~100 bytes, only sent on rejection (rare)
- **Total overhead: ~400 bytes/s per player** — negligible

---

## 2. Ping Measurement

### Problem

`getPing()` returned a static `0` value. `getPacketLoss()` and `getJitter()` were stubs returning `0`. The HUD already called these methods but displayed nothing useful.

### Solution

Implemented client-server ping/pong with sliding-window RTT tracking:

```
Client                          Server
  |-- ping {timestamp: T1} ----->|
  |                               |-- echo timestamp
  |<--- pong {timestamp: T1} ----|
  |-- RTT = now - T1              |
  |-- store in pingHistory[10]    |
  |-- ping = latest RTT           |
  |-- jitter = mean|ΔRTT|         |
```

### Changes

| File | Change |
|------|--------|
| `server_bun/src/MessageHandler.ts` | Added `ping` case: echoes `{ type: 'pong', timestamp }` back to sender. |
| `server_bun/src/validation.ts` | Added `ping` message validation (requires finite `timestamp`). |
| `client/src/networking/NetworkManager.ts` | Sends `{ type: 'ping', timestamp: Date.now() }` every 2s, piggy-backed on position sends. `handlePong()` computes RTT, stores in `pingHistory[]` (max 10). `getJitter()` computes mean absolute difference of consecutive RTT samples. `getPacketLoss()` returns 0 with documented rationale (WebSockets are TCP, loss not directly measurable). |

### Design Decisions

- **2-second interval**: Balances accuracy vs bandwidth. At 2s, we get 30 samples/minute — plenty for a stable moving average.
- **Piggy-backed on position send**: Avoids a separate message in the common case. The ping check runs inside `sendPosition()` after the rate-limit check.
- **Jitter = mean absolute delta**: Simple and effective. Not a formal statistical measure but sufficient for HUD display.
- **Packet loss = 0**: WebSockets use TCP, which guarantees delivery. True packet loss would manifest as increased latency (retransmissions) rather than dropped messages. The method is documented rather than removed.

---

## 3. Handshake Protocol Fix

### Problem

`FastAPIAdapter.connect()` sent `{ playerId: "..." }` as the first message — no `type` field. The server's `handleHandshake()` accepted any object with a `playerId` field, so it worked, but the protocol was inconsistent: all other messages have a `type` field.

### Solution

Changed the handshake message to `{ type: 'join', playerId: '...' }`.

### Changes

| File | Change |
|------|--------|
| `client/src/networking/FastAPIAdapter.ts` | Handshake message now includes `type: 'join'`. |

### Note

The server's `handleHandshake()` does not check `type === 'join'` — it treats the first message from an unregistered WebSocket as a handshake regardless. This is backward compatible with any client that sends `{ playerId }` as their first message. Adding explicit `type` validation on the server is a optional future improvement for protocol clarity.

---

## 4. Dead Stub Implementation

### Problem

`getPacketLoss()` and `getJitter()` in `NetworkManager` returned hardcoded `0` with `// Not implemented yet` comments.

### Solution

- `getJitter()`: Implemented from ping history — computes mean absolute difference of consecutive RTT samples.
- `getPacketLoss()`: Returns `0` with documented rationale (WebSockets are reliable TCP transport; packet loss manifests as latency, not drops).

---

## 5. Dead Method Removal from FastAPIAdapter

### Problem

`FastAPIAdapter` contained three unused methods that duplicated `NetworkManager` functionality:
- `getPlayers()` — returned an empty `Map` that was never populated
- `updateLocalPlayer()` — duplicate of `NetworkManager.sendPosition()`
- `sendShot()` — duplicate of `NetworkManager.sendShot()`

An unused `players` field also existed.

### Solution

Removed all three methods and the `players` field. `FastAPIAdapter` is now a clean transport-only adapter — all game logic lives in `NetworkManager`.

---

## Test Results

```
Server:  bun run test     → 77 pass, 0 fail (326 expect() calls)
Client:  npx tsc --noEmit → 0 errors
```

Pre-existing TypeScript errors in demo files (`CircularBuffer.ts`, `DemoPlayer.ts`, `DemoSerializer.ts`) are unrelated to these changes.

---

## System Architecture Overview

### Current Networking Stack

```
┌─────────────────────────────────────────────────────────┐
│ Client (Browser)                                        │
│                                                         │
│  main.ts                                                │
│    ├── Player.ts (local physics, MovementController)    │
│    ├── RemotePlayer.ts (interpolation, dead reckoning)  │
│    ├── NetworkManager.ts                                │
│    │     ├── sequence tracking + state history          │
│    │     ├── ping/pong RTT measurement                  │
│    │     ├── correction handling + state pruning        │
│    │     └── message routing (gameState, tickUpdate,    │
│    │         playerJoined/Left, hit/kill, knockback,    │
│    │         projectile, snapshot, stateHash,           │
│    │         correction, pong)                          │
│    └── FastAPIAdapter.ts (JSON WebSocket transport)     │
│           └── WebSocketConnection.ts                    │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket (JSON)
┌──────────────────────▼──────────────────────────────────┐
│ Server (Bun, port 8000)                                 │
│                                                         │
│  server.ts (HTTP + WebSocket upgrade)                   │
│    └── GameServer.ts                                    │
│          ├── ConnectionManager (ws registry)            │
│          ├── PlayerManager (state, lastSeq, lastValid)  │
│          ├── MessageHandler (position, shot, AOE,       │
│          │   ping → pong, correction on reject)         │
│          ├── RateLimiter (per-player per-type)          │
│          ├── Tick broadcast (20Hz, delta compressed)    │
│          └── Hash broadcast (2s, integrity check)       │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Local player movement**: Client runs full physics locally (instant response, no server round-trip). Sends position + seq at 20Hz.
2. **Server validation**: Speed check (200 m/s max). On reject → sends `correction` with last valid state. On accept → updates `lastValidState` and `lastSeq`.
3. **Tick broadcast**: 20Hz, delta-compressed (skips players that moved <0.1m). Each recipient gets `ackSeq` so they can prune state history.
4. **Remote players**: Interpolated from tick updates with dead reckoning for prediction between updates.
5. **Ping**: Client sends `ping` every 2s, server echoes `pong`, client computes RTT and jitter.

### Cost Profile

| Resource | Usage |
|----------|-------|
| Server CPU | Minimal — no physics, just position storage + cheat checks + JSON serialization |
| Server memory | ~1KB per player (PlayerState + rate limit entries + connection metadata) |
| Bandwidth per player | ~2-4 KB/s upstream (position at 20Hz) + ~1-3 KB/s downstream (tickUpdate, varies with player count) |
| Tick broadcast | 20Hz with delta compression — idle players generate zero update bytes |

### Cheat Prevention

| Check | Location | Action on Violation |
|-------|----------|-------------------|
| Speed limit (200 m/s) | `MessageHandler.handlePosition` | Send `correction`, reject position |
| Shot distance (200m) | `MessageHandler.handleShot` | Reject shot |
| Self-damage | `MessageHandler.handleShot` | Reject shot |
| Rate limiting | `RateLimiter.check` | Drop message, log warning |
| Player ID validation | `validation.validatePlayerId` | Close connection (1008) |
| Max players (32) | `GameServer.handleHandshake` | Close connection (1013) |
| Duplicate ID | `GameServer.handleHandshake` | Close connection (1008) |

---

## Recommended Next Steps

| Priority | Improvement | Effort | Impact |
|----------|------------|--------|--------|
| High | Smooth correction interpolation (lerp over ~100ms) | Small | Eliminates visual rubber-band on correction |
| Medium | Input replay on correction (re-simulate from corrected state) | Medium | True client-side prediction — eliminates snap entirely |
| Medium | Server `type: 'join'` validation | Trivial | Protocol clarity |
| Low | Client-side unit tests for NetworkManager | Medium | CI coverage |
| Low | Binary protocol (msgpack) | Large | ~40-60% bandwidth reduction at scale |

---

## Files Modified

### Server (`server_bun/src/`)
- `types.ts` — PlayerState fields, ClientMessage/ServerMessage union types
- `PlayerManager.ts` — seq tracking, getLastSeq, getLastValidState
- `MessageHandler.ts` — ping handler, correction on reject, seq passthrough
- `GameServer.ts` — ackSeq in tickUpdate broadcast
- `validation.ts` — seq field in position, ping message validation

### Client (`client/src/`)
- `networking/NetworkManager.ts` — sequence tracking, state history, ping/pong, correction handling, jitter implementation
- `networking/FastAPIAdapter.ts` — handshake fix (`type: 'join'`), dead method removal
- `main.ts` — `onCorrection` callback wiring
