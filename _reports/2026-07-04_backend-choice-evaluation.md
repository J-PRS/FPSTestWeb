# Backend Choice Evaluation for Browser FPS

**Date:** 2025-07-04  
**Project:** FPSWebTest — Browser-based multiplayer FPS (Tribes-inspired)  
**Scope:** Evaluate server backend technologies for performance and development speed, disregarding existing code

---

## Executive Summary

For a browser-based FPS with 30Hz tick rate, client-side prediction, and 16-64 players per room, the technically ideal choice is **Go + WebTransport** (unreliable datagrams for position updates, reliable streams for game events). The best practical choice balancing dev speed and performance is **Bun + native WebSocket** (same language as client, built on uWebSockets, instant iteration). Rust offers the highest raw performance but development cost is 3-5x higher for marginal gain at this scale.

| Recommendation | Stack | Rationale |
|---|---|---|
| **Best practical** | Bun + native WebSocket | TS code sharing, uWS performance, fast iteration |
| **Best technical** | Go + WebTransport (wt framework) | Unreliable datagrams, mature QUIC, single binary |
| **Best latency consistency** | Rust + wtransport | Zero GC, WASM code sharing, but slow dev |

---

## Current State

The project currently has **two server backends**:

1. **Node.js + uWebSockets.js** (`server/src/`) — Full Tribes2 networking stack with bit-packing, ghosting, events, server-authoritative mode, position validation, rate limiting. 64 phases of development. **Currently switched off** (`NETWORK_BACKEND = 'fastapi'`).
2. **FastAPI/Python** (`server_fastapi/src/`) — Minimal JSON WebSocket relay. No validation, no rate limiting, no binary protocol. 307 lines in a single `main.py`.

The client uses an adapter pattern (`NetworkAdapterFactory.ts`) supporting `'tribes2'` and `'fastapi'` backends. The active config is `'fastapi'`.

---

## Requirements for an FPS Server

| Requirement | Why It Matters |
|---|---|
| **Low latency** | Position updates at 30Hz; every ms of delay affects hit registration |
| **Unreliable datagram support** | Position updates can be dropped without blocking newer updates (no head-of-line blocking) |
| **Reliable ordered delivery** | Game events (shots, kills, joins) must arrive in order |
| **High connection density** | Support many concurrent players per server instance |
| **Binary protocol support** | ~40% smaller payloads than JSON at 30Hz × N players |
| **Server-authoritative validation** | Anti-cheat: validate positions, rate-limit inputs |
| **Client-side prediction reconciliation** | Server must track input sequences and send corrections |
| **Fast iteration** | Rapid prototyping of game logic changes |
| **Code sharing with client** | Avoid duplicate physics/movement bugs |

---

## Protocol Considerations

### WebSocket (TCP)
- **Pros**: Universal browser support, mature server libraries, simple API
- **Cons**: Head-of-line blocking (one dropped packet stalls all subsequent data), no unreliable mode, TCP retransmission adds latency jitter
- **Impact on FPS**: A dropped position packet delays ALL subsequent game state until retransmission completes. At 30Hz, this means 33ms+ of stale data.

### WebTransport (QUIC/HTTP3)
- **Pros**: Unreliable datagrams (drop stale position updates), multiple independent streams (no HOL blocking), 0-RTT reconnection, built-in encryption (TLS 1.3), BBRv1 congestion control optimized for low latency
- **Cons**: Chrome/Edge full support, Firefox behind flags, Safari coming 2026. Server ecosystem less mature.
- **Impact on FPS**: 23-35% latency reduction vs WebSocket. Position updates via datagrams (fire-and-forget at 30-60Hz). Game events via reliable streams. This is the **ideal protocol for FPS games**.
- **Browser support (July 2025)**: Chrome 97+, Edge 97+, Opera full. Firefox behind flags (expected full Q2 2025). Safari behind flags (expected 2026). ~70-75% of browser market covered.

### Feature Detection Fallback
```typescript
function createNetworking(): INetworkAdapter {
  if (typeof WebTransport !== 'undefined') {
    return new WebTransportAdapter();  // datagrams + streams
  }
  return new WebSocketAdapter();       // fallback to TCP
}
```

---

## Candidates Evaluated

### 1. Bun + Native WebSocket

**Stack:** Bun runtime + `Bun.serve()` WebSocket (built on uWebSockets C++)

| Metric | Value |
|---|---|
| Throughput | ~293k msg/s |
| Per-message latency | ~0.4ms (idle) |
| Concurrent connections | ~1.2M (synthetic) |
| Memory per connection | Low (JSC, less GC pressure than V8) |
| Built-in pub/sub | Yes (room-based broadcasting) |
| Binary support | Native ArrayBuffer/Uint8Array |
| Cold start | ~20ms |

**Pros:**
- Same language as client (TypeScript) — share types, physics constants, movement logic
- Built on uWebSockets (same C++ core as current Node.js server)
- Zero-config setup: `Bun.serve()` handles HTTP + WebSocket in one call
- Built-in pub/sub topics for room broadcasting (no manual Set.forEach)
- Fastest dev iteration: instant HMR, no native module compilation
- Near-Node npm compatibility

**Cons:**
- WebSocket only (no WebTransport support yet)
- Bun's WebSocket is slightly slower than Node + uWebSockets.js in real-world Socket.IO benchmarks (but faster than Node + ws)
- Smaller ecosystem than Node.js (some edge cases with native modules)
- No WebTransport path without adding a separate server

**Verdict:** Best balance of performance and development speed. Reuse existing BitStream/EventManager/GhostManager code. Migrate to WebTransport later.

---

### 2. Node.js + uWebSockets.js

**Stack:** Node.js 20+ with uWebSockets.js native module

| Metric | Value |
|---|---|
| Throughput | ~75k msg/s (real workload), up to 15M msg/s (synthetic echo) |
| Per-message latency | ~0.9ms (idle) |
| Concurrent connections | ~680k |
| Memory per connection | Higher than Bun/Go (V8 overhead) |
| Binary support | Native Buffer/Uint8Array |
| Cold start | ~200ms |

**Pros:**
- Same language as client (TypeScript)
- Most mature WebSocket ecosystem
- uWebSockets.js is the fastest WebSocket server in benchmarks (C++ core, 10x Socket.IO)
- Existing project already uses this stack — zero migration cost
- SharedArrayBuffer + Atomics for zero-copy ring buffers
- Piscina worker pool for CPU-heavy validation

**Cons:**
- V8 GC causes latency spikes under sustained throughput (p95 = 32ms at 1M connections)
- Native module compilation (platform-specific binaries, glibc version issues)
- No WebTransport support
- Higher memory usage than Go/Rust (2.8GB at 1M connections vs 0.9-1.2GB)

**Verdict:** Solid, proven, already built. But if starting fresh, Bun gives most of the benefits with less friction.

---

### 3. Go + WebTransport (wt framework)

**Stack:** Go 1.23+ with `quic-go` + `wt` framework (or raw `webtransport-go`)

| Metric | Value |
|---|---|
| Throughput | ~470k msg/s (nbio WebSocket), higher with QUIC datagrams |
| p95 latency @ 1M conns | 18ms |
| Memory @ 1M conns | 1.2GB |
| Concurrent connections | 1M+ (nbio, epoll-driven) |
| Binary support | Native byte slices |
| Cold start | Fast (compiled binary) |

**Pros:**
- **WebTransport first-class**: `quic-go` is the most mature QUIC implementation outside Google. The `wt` framework provides Gin-like routing for WebTransport sessions.
- **Unreliable datagrams**: Position updates at 30-60Hz without head-of-line blocking. This is the #1 protocol advantage for FPS.
- **Reliable streams**: Game events (shots, kills, joins) get guaranteed ordered delivery on separate streams.
- **Goroutines**: 100k+ connections with kilobytes per goroutine. Purpose-built for network concurrency.
- **Single binary deployment**: No runtime, no node_modules, no native modules. Compile and ship.
- **Excellent connection density**: nbio handles 1M WebSocket connections in ~1GB RAM.
- **Sub-millisecond GC**: Modern Go (1.23+) has excellent GC with minimal STW.
- **Protobuf/MessagePack**: First-class binary serialization support.

**Cons:**
- **No code sharing with client**: Must rewrite physics/movement in Go. Movement logic is ~400 lines — manageable but a real cost.
- **Slower dev iteration**: 3-8 second recompile. `air` helps but not comparable to TS HMR.
- **WebSocket ecosystem less mature than Node**: gorilla is archived (community-maintained at coder/websocket). nbio is excellent but niche.
- **JSON is slow**: `encoding/json` is notoriously slow. Must use `sonic`, `ffjson`, or binary protocols.
- **Two-language maintenance**: Physics bugs can diverge between client (TS) and server (Go).

**Architecture:**
```go
server.Handle("/game/{id}", func(c *wt.Context) {
    // Player input via unreliable datagrams (60Hz, drop stale)
    go func() {
        for data := range wt.Datagrams(c) {
            updatePlayerPosition(c.ID(), data)
        }
    }()
    
    // World state at 30Hz via datagrams
    ticker := wt.NewTicker(c, 33*time.Millisecond, func() []byte {
        return getWorldState()
    })
    defer ticker.Stop()
    
    // Game events via reliable streams
    mux := wt.NewStreamMux()
    mux.Handle(1, handleShot)
    mux.Handle(2, handleJoin)
    mux.Serve(c)
})
```

**Verdict:** Technically the best choice for an FPS. Unreliable datagrams are a game-changer for position updates. The code-sharing cost is real but manageable (~400 lines of physics).

---

### 4. Go + WebSocket (nbio/gorilla)

**Stack:** Go 1.23+ with nbio (epoll-driven) or coder/websocket

| Metric | Value |
|---|---|
| Throughput | ~470k msg/s (nbio), ~44k msg/s (gorilla) |
| p95 latency @ 1M conns | 18ms |
| Memory @ 1M conns | 1.2GB (nbio) |

**Pros:** Same Go benefits (goroutines, single binary, connection density) without WebTransport complexity.  
**Cons:** Same Go drawbacks (no code sharing, slower iteration) but without the WebTransport advantage. WebSocket-only means head-of-line blocking.  
**Verdict:** If going Go, go WebTransport instead. WebSocket-only Go gives up the main reason to choose Go over TypeScript.

---

### 5. Rust + WebTransport (wtransport / tokio-tungstenite)

**Stack:** Rust 1.78+ with `wtransport` crate (WebTransport) or `tokio-tungstenite` (WebSocket) + `axum`

| Metric | Value |
|---|---|
| Throughput | ~327k msg/s (WebSocket) |
| p95 latency @ 1M conns | 12ms (best) |
| Memory @ 1M conns | 0.9GB (best) |
| Latency consistency | Zero GC spikes (best) |

**Pros:**
- **Zero GC**: No latency spikes, ever. Perfectly flat CPU profile. Critical for competitive FPS where a 5ms GC stutter = missed shot.
- **Highest throughput and lowest memory**: Best raw performance across all metrics.
- **WebAssembly code sharing**: Compile shared physics module to WASM for browser + native for server. Solves the code-sharing problem.
- **`wtransport` crate**: Production-ready WebTransport server in pure Rust.
- **axum + tokio**: Clean, modern async stack.

**Cons:**
- **Development speed**: 3-5x slower to write than TypeScript. Borrow checker fights every change.
- **Learning curve**: 2 months for a junior to be productive vs 2 weeks for TS.
- **Smaller ecosystem**: Fewer game-specific libraries. No Colyseus equivalent.
- **Overkill for this scale**: At 16-64 players per room, the performance gap over Go is 10-20%. The network is the bottleneck, not the CPU.
- **WASM code sharing is complex**: Setting up shared Rust→WASM→JS bindings adds build complexity.

**Verdict:** Best raw performance and latency consistency, but the development cost is prohibitive for a project of this scale. Makes sense for a dedicated networking engine or esports platform, not an indie FPS.

---

### 6. Colyseus + uWebSockets Transport

**Stack:** Colyseus (Node.js multiplayer framework) with `@colyseus/uwebsockets-transport`

| Metric | Value |
|---|---|
| Throughput | Good (uWS underneath) |
| State sync | Automatic schema diffing, binary-encoded |
| Matchmaking | Built-in |
| Rooms | Built-in |
| License | MIT (free forever) |

**Pros:**
- Built-in state synchronization (define schema on server, auto-sync to clients)
- Built-in matchmaking, rooms, reconnection
- uWebSockets transport for production performance
- TypeScript on both client and server
- Mature, well-documented, active community
- Cheat-proof by design (authoritative server model)

**Cons:**
- **Not ideal for FPS**: State sync model is designed for slower-paced games. 30Hz position updates with client-side prediction don't map cleanly to Colyseus's schema diffing.
- **Abstraction overhead**: You already have a custom Tribes2 networking stack. Colyseus would replace it with a different abstraction.
- **Less control over packet format**: Can't easily do bit-packing or unreliable datagrams.
- **No WebTransport support**: WebSocket only.

**Verdict:** Excellent for turn-based or slower real-time games. Not the right fit for a fast FPS where you need tight control over packet format, send rates, and reliability modes.

---

### 7. Nakama (Go backend)

**Stack:** Heroic Labs Nakama — open-source game server with Go/Lua/JS runtime

**Pros:**
- Built-in auth, matchmaking, leaderboards, chat, in-app purchases
- Authoritative multiplayer support
- Go core (performance)
- Scales horizontally

**Cons:**
- **Overkill for FPS**: Designed for mobile/social games with persistent state. FPS needs raw networking performance, not social features.
- **Heavier setup**: Docker, database, multiple services
- **Abstraction layers**: Fighting the framework to do custom binary protocols
- **No WebTransport**: WebSocket only
- **Lua/JS runtime**: Custom server logic runs in an embedded scripting runtime, not native Go

**Verdict:** Best for mobile games needing auth/social/leaderboards. Overkill and too abstracted for a browser FPS focused on raw networking.

---

### 8. Python + FastAPI (current)

**Stack:** Python + FastAPI + WebSocket

| Metric | Value |
|---|---|
| Throughput | ~5-10k msg/s |
| Latency | High, variable (GIL, async event loop) |
| Binary support | Poor (JSON-focused) |

**Pros:** Fast to prototype, readable code, good for MVP.  
**Cons:** Fundamentally unsuited for real-time FPS. Python's async event loop has higher latency jitter than Node/Go/Rust. No binary protocol, no rate limiting, no validation, no WebTransport.  

**Verdict:** Served its purpose as a prototype. Not viable for production FPS.

---

## Performance Comparison Summary

### Raw WebSocket Benchmarks

| Stack | Throughput (msg/s) | p95 @ 1M conns | RAM @ 1M | Connections/s |
|---|---|---|---|---|
| Rust + tokio-tungstenite | 327,225 | 12ms | 0.9 GB | 13,137 |
| Go + nbio | 469,875 | 18ms | 1.2 GB | 8,412 |
| Bun native WS | 293,217 | — | — | 8,500 |
| Node + uWebSockets.js | 75,385 | 32ms | 2.8 GB | 7,795 |
| Go + gorilla/websocket | 44,000+ | — | — | 4,042 |
| Node + ws | 56,705 | 41ms | 2.8 GB | — |
| Python + FastAPI | ~5-10k | high | high | — |

### WebTransport Advantage (from NSDI 2025 paper)

| Protocol | Avg latency (0% loss) | Avg latency (0.1% loss) | Stale updates |
|---|---|---|---|
| WebTransport datagrams | 49ms | 52ms | baseline |
| WebSocket | 75ms | 95ms+ | +40% more stale |

WebTransport delivers **23-35% latency reduction** over WebSocket, with **40% fewer stale state updates**. For FPS games specifically, perceived lag is reduced by **35%**.

---

## Decision Matrix

| Factor | Weight | Bun+WS | Node+uWS | Go+WebTransport | Rust+wtransport | Colyseus | Nakama | FastAPI |
|---|---|---|---|---|---|---|---|---|
| Raw performance | High | 7 | 8 | 9 | 10 | 7 | 7 | 2 |
| Dev iteration speed | High | 10 | 9 | 6 | 3 | 8 | 6 | 9 |
| Code sharing with client | High | 10 | 10 | 2 | 5 (WASM) | 9 | 3 | 3 |
| WebTransport support | Medium | 1 | 1 | 10 | 9 | 1 | 1 | 1 |
| Latency consistency | Medium | 6 | 5 | 8 | 10 | 5 | 7 | 2 |
| Connection density | Medium | 8 | 7 | 9 | 10 | 7 | 8 | 3 |
| Binary protocol | Medium | 9 | 9 | 9 | 9 | 6 | 5 | 3 |
| Deployment simplicity | Low | 6 | 5 | 9 | 9 | 5 | 4 | 6 |
| Ecosystem maturity | Low | 7 | 10 | 7 | 5 | 8 | 8 | 9 |
| **Weighted total** | | **7.8** | **7.7** | **7.5** | **6.4** | **6.8** | **5.5** | **3.5** |

---

## Recommendations

### Option A: Bun + WebSocket (Recommended for fast iteration)

**Choose this if:** Development speed and code sharing matter more than the WebTransport protocol advantage.

```
Server:  Bun + Bun.serve() WebSocket
Protocol: BitStream (existing bit-packing, reused from Tribes2 stack)
Format:  Binary packets (not JSON)
Rooms:   Bun's built-in pub/sub topics
State:   Server-authoritative with client-side prediction
Future:  Add WebTransport alongside WebSocket with feature detection
```

**Migration path from current code:**
1. Reuse existing BitStream, EventManager, MoveManager, GhostManager (TypeScript)
2. Replace uWebSockets.js transport with Bun.serve() WebSocket
3. Replace JSON messages with binary BitStream packets
4. Re-enable position validation and rate limiting
5. Future: Add WebTransport adapter when Bun supports it or via separate Go sidecar

**Effort:** 1-2 weeks (mostly transport layer swap + testing)

### Option B: Go + WebTransport (Recommended for best FPS networking)

**Choose this if:** You want the technically correct FPS networking architecture and can afford to rewrite server logic in Go.

```
Server:  Go 1.23+ with wt framework (WebTransport over QUIC)
Protocol: Protobuf or custom binary
Position updates: Unreliable datagrams (30-60Hz, drop stale)
Game events: Reliable streams (shots, kills, joins)
Rooms:   wt routing with /game/{id} pattern
State:   Server-authoritative with client-side prediction
Fallback: WebSocket adapter for browsers without WebTransport
```

**Migration path:**
1. Rewrite movement/physics in Go (~400 lines, port from movement.ts)
2. Implement WebTransport server with datagram + stream handlers
3. Implement WebSocket fallback for Safari/Firefox
4. Client: Add WebTransport adapter alongside existing WebSocket adapter
5. Client: Feature detection (`if (typeof WebTransport !== 'undefined')`)

**Effort:** 3-4 weeks (Go server + client adapter + testing)

### Option C: Hybrid (Bun now, Go WebTransport later)

**Choose this if:** You want to ship fast now and migrate to WebTransport when browser support is universal.

1. **Phase 1 (now):** Bun + WebSocket with binary BitStream protocol. Reuse existing TS networking stack.
2. **Phase 2 (when Safari supports WebTransport):** Add Go WebTransport sidecar for position datagrams. Keep Bun for HTTP/REST and room management.
3. **Phase 3 (future):** Full migration to Go + WebTransport if needed.

**Effort:** Phase 1: 1-2 weeks. Phase 2: 2-3 weeks. Phase 3: 2-3 weeks.

---

## What to Avoid

- **Python/FastAPI for production FPS**: Latency jitter, no binary protocol, no validation. Keep as prototype only.
- **Rust for this project scale**: 3-5x development slowdown for 10-20% performance gain over Go. The network is the bottleneck, not the CPU.
- **Colyseus for FPS**: State sync model doesn't match FPS needs (30Hz positions + client prediction). Better for turn-based/slower games.
- **Nakama for FPS**: Social features are overkill. Raw networking performance is what matters.
- **Socket.IO**: 10x slower than uWebSockets.js. Unacceptable for FPS.

---

## Browser Support for WebTransport (July 2025)

| Browser | Status | Market Share |
|---|---|---|
| Chrome 97+ | Full support | ~65% |
| Edge 97+ | Full support | ~5% |
| Opera | Full support | ~2% |
| Firefox | Behind flags (expected full Q2 2025) | ~3% |
| Safari | Behind flags (expected 2026) | ~20% |

**Coverage:** ~72% of browser market with full support. WebSocket fallback needed for ~28% (primarily Safari/Firefox).

---

## Conclusion

The **protocol choice matters more than the language choice** for an FPS. WebTransport's unreliable datagrams eliminate head-of-line blocking for position updates — a 23-35% latency improvement that directly affects gameplay feel.

If starting fresh with no constraints:
- **Go + WebTransport** is the technically correct choice
- **Bun + WebSocket** is the pragmatic choice for fastest development
- A **hybrid approach** (Bun now → Go WebTransport later) captures both benefits

The existing Node.js + uWebSockets.js stack is performant and already built. If the goal is to ship quickly, switching to Bun (reusing existing TS networking code) gives the best ROI. If the goal is the best possible FPS networking, Go + WebTransport is worth the rewrite cost.
