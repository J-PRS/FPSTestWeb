# Networking Architecture Report for Tribes-Inspired Browser FPS

**Date:** 2026-06-22
**Objective:** Achieve Krunker-style LAN-like feel with instant hit detection and movement, while keeping costs minimal

## The "LAN-Like Feel" Problem

### What Players Experience

**Krunker.io feel:**
- Instant shooting (no perceptible delay)
- Instant movement (no rubber-banding)
- "If you hit on your screen, you hit" (favor-the-shooter)
- Feels like playing on LAN even with 50-100ms ping

**Traditional networking problems:**
- Input delay (client sends input, waits for server response)
- Rubber-banding (client prediction errors)
- Shot registration issues (hit on client but not on server)
- Peekers advantage (seeing opponents before they see you)

### The Technical Challenge

Achieving LAN-like feel over the internet requires:
1. **Client-side prediction** - Apply input immediately, don't wait for server
2. **Lag compensation** - Server rewinds time to validate shots from shooter's perspective
3. **High tick rate** - Frequent state updates (60Hz+)
4. **Delta compression** - Only send what changed, not full state
5. **Interest management** - Only send data for entities player can see/hear

## Krunker's Architecture

### Hosting Infrastructure

**Cloudflare-based:**
- Uses Cloudflare CDN and DNS
- Cloudflare Workers for edge computing
- Zero egress fees (critical for cost control)
- Global edge network (low latency worldwide)

**Cost implications:**
- Cloudflare Workers: $5/month base + $0.30/M requests
- For 10k DAU with 20 requests/sec: ~$50/month
- Significantly cheaper than traditional VPS hosting

### Networking Model

**From Krunker docs:**
- **Movement syncing:** Server sends player position every second, client retraces steps since that point
- **Rate limits:**
  - Client to server: 40 msg/sec
  - Server to client: 20 msg/sec per user
  - Broadcast (server to all): 10 msg/sec
  - Chat: 2 msg/sec
- **Data size:** 2000 bytes per message max
- **Prediction:** Can be disabled with `GAME.DEFAULT.disablePrediction()`

**Key insight:** Krunker uses relatively low tick rate (1 sec for position sync) but compensates with client-side prediction and lag compensation to achieve LAN-like feel.

## Modern Competitive FPS Networking (Exfil Reference)

### Exfil Project Architecture

**What it demonstrates:**
- 64Hz authoritative server tick rate
- Client-side prediction + reconciliation
- Lag compensation (favor-the-shooter)
- Delta-compressed snapshots (sub-1KB)
- Interest management
- Measured peeker's advantage window

**Tech stack:**
- Server: Go (deterministic simulation)
- Client: Rust → WebAssembly
- Protocol: Custom binary WebSocket
- Hosting: Fly.io (server) + Cloudflare Pages (client)

### Key Techniques

**1. Authoritative Server**
- Server is single source of truth
- Clients send input commands, not state
- Server calculates position, movement, damage
- Prevents cheating (clients can't teleport or fake damage)

**2. Client-Side Prediction**
- Client applies input immediately (instant feedback)
- Stores input history
- When server state arrives, client replays unacknowledged inputs
- Corrects prediction errors smoothly
- Result: Instant movement feel

**3. Lag Compensation (Favor-the-Shooter)**
- Server keeps ~1 second ring buffer of past world states
- When client shoots, server rewinds to shooter's view tick
- Validates hit against rewound state
- Checks line-of-sight against cover
- Result: "If you hit on your screen, you hit"

**4. Delta Compression**
- Only send what changed since last snapshot
- P95 ~93 bytes at 6 players with interest management
- Dramatically reduces bandwidth
- Result: Lower costs, better performance

**5. Interest Management**
- Only send entities player can see/hear
- Cull distant entities from network data
- Reduces bandwidth and server load
- Result: Scales to more players

**6. Deterministic Simulation**
- Fixed-point math (no floats)
- Seeded RNG
- Same inputs = same outputs on client and server
- Enables prediction and reconciliation
- Result: Consistent state across clients

### Measured Results

**From Exfil verification harness:**
- 64Hz tick sustained with zero tick drops
- Sub-1KB delta snapshots (P95 ~93 bytes)
- Lag-compensated hit registration validated across 50/100/150ms ping
- Peeker's advantage window measured and tunable

## Nengi Architecture (Alternative Approach)

### Key Features

**Server-authoritative:**
- Only commands sent (move direction, shoot)
- Server calculates actual position and ray
- No client state transfer

**Client-side prediction:**
- Movement predicted on client
- Simple collisions via moveWithCollisions
- Reconciliation of prediction errors

**Rewind lag compensation:**
- Shots are lag-compensated
- Server logs hits to console
- No damage in demo (just hit validation)

**Deterministic systems:**
- Deterministic cooldown/timer
- Shooting speed controlled server-side
- Stays synced across clients

**Two-entity model:**
- rawEntity (actual server state)
- smoothEntity (interpolated display)
- Conceals packet loss and CPU lag spikes
- Complicated but effective

## Recommended Architecture for Tribes-Inspired FPS

### Core Principles

**1. Authoritative Server (Non-negotiable)**
- Server is single source of truth
- Clients send input commands only
- Server validates all actions
- Prevents cheating

**2. Client-Side Prediction (Critical for feel)**
- Apply input immediately
- Instant movement feedback
- Reconcile with server state
- Smooth error correction

**3. Lag Compensation (Critical for shooting)**
- Favor-the-shooter model
- Server rewinds to shooter's view tick
- Validate hits against rewound state
- "If you hit on your screen, you hit"

**4. High Tick Rate (60Hz+)**
- 60Hz minimum for competitive feel
- 64Hz ideal (Exfil proven)
- Higher = smoother but more cost
- Consider adjustable based on player count

**5. Delta Compression (Critical for cost)**
- Only send changed data
- Target <100 bytes per snapshot
- Dramatically reduces bandwidth
- Enables cost-effective scaling

**6. Interest Management (Critical for scale)**
- Only send visible entities
- Cull distant players
- Reduces server load
- Enables larger matches

### Proposed Tech Stack

**Server:**
- **Runtime:** Go (like Exfil) or Rust
- **Tick rate:** 64Hz
- **Protocol:** WebTransport (HTTP/3) with binary encoding
- **Hosting:** Cloudflare Workers (edge computing)
- **Database:** Supabase (PostgreSQL) for persistence

**Client:**
- **Runtime:** JavaScript/TypeScript (native browser)
- **Prediction:** Native JS (no WASM needed for simple prediction)
- **Rendering:** Three.js
- **Protocol:** WebTransport with binary encoding

**Why WebTransport over WebSocket:**
- **Unreliable datagrams:** UDP-like for game state (fast, can drop old packets)
- **Reliable streams:** TCP-like for critical data (chat, auth, events)
- **HTTP/3/QUIC:** 47% faster than HTTP/1.1 on lossy connections
- **Multiple streams:** Independent data channels (no head-of-line blocking)
- **Modern API:** Designed for web, better than WebRTC for client-server
- **Browser support:** Baseline 2026 (Chrome 97+, Firefox 114+, Safari 26.4+)

**Why this stack:**
- Go/Rust: Deterministic, fast, good for game loops
- Cloudflare Workers: Global edge, zero egress, cheap
- WebTransport: Modern, supports both reliable/unreliable, HTTP/3 benefits
- Native JS: No WASM overhead, simpler debugging
- Binary encoding: Smaller than JSON, faster parsing

## Protocol Comparison: WebSocket vs WebRTC vs WebTransport

### WebSocket (Legacy)

**How it works:**
- TCP-based protocol
- Single bidirectional stream
- Reliable, ordered delivery only
- HTTP/1.1 upgrade to WebSocket

**Pros:**
- Universal browser support (all browsers)
- Simple API
- Reliable delivery
- Good for: Chat, turn-based games, notifications

**Cons:**
- No unreliable option (all data must arrive)
- Head-of-line blocking (one slow packet blocks all)
- TCP overhead (handshake, congestion control)
- No multiple streams
- Bad for: Fast-paced FPS (can't drop old state)

**Suitability for Tribes FPS:** Poor - no unreliable option for game state updates

### WebRTC (P2P-focused)

**How it works:**
- UDP-based data channels
- Designed for peer-to-peer (video/audio)
- ICE/STUN/TURN for NAT traversal
- Complex signaling setup

**Pros:**
- Unreliable data channels (UDP-like)
- Low latency
- Good for: P2P games, voice/video chat

**Cons:**
- Designed for P2P, not client-server
- Complex setup for authoritative server
- Browser support varies
- Requires signaling server
- Overhead for WebRTC negotiation
- Bad for: Authoritative server architecture

**Suitability for Tribes FPS:** Poor - complex for authoritative server, P2P-focused

### WebTransport (Modern, Recommended)

**How it works:**
- HTTP/3 (QUIC) based
- Supports both unreliable datagrams and reliable streams
- Multiple independent streams
- Designed for client-server real-time applications

**Pros:**
- **Unreliable datagrams:** UDP-like for game state (fast, can drop old packets)
- **Reliable streams:** TCP-like for critical data (chat, auth, events)
- **Multiple streams:** Independent channels, no head-of-line blocking
- **HTTP/3/QUIC:** 47% faster than HTTP/1.1 on lossy connections
- **Modern API:** Designed for web, better than WebRTC for client-server
- **Browser support:** Baseline 2026 (Chrome 97+, Firefox 114+, Safari 26.4+)
- **Works in Web Workers:** Independent of main thread
- **Congestion control:** Built-in, unlike raw UDP

**Cons:**
- Newer API (less ecosystem maturity)
- Requires HTTP/3 server support
- Older browsers not supported (IE, old Safari)
- Fallback needed for unsupported browsers

**Suitability for Tribes FPS:** Excellent - designed for this use case, supports both reliable/unreliable

### Comparison Summary

| Feature | WebSocket | WebRTC | WebTransport |
|---------|-----------|--------|-------------|
| **Transport** | TCP | UDP | HTTP/3 (QUIC) |
| **Reliable** | Yes | Optional | Both (streams + datagrams) |
| **Unreliable** | No | Yes | Yes (datagrams) |
| **Multiple streams** | No | Yes | Yes |
| **Head-of-line blocking** | Yes | No | No |
| **Browser support** | Universal | Good | Baseline 2026 |
| **Client-server** | Excellent | Poor | Excellent |
| **P2P** | Poor | Excellent | Poor |
| **Latency** | Medium | Low | Low |
| **Complexity** | Low | High | Medium |
| **Suitability for FPS** | Poor | Poor | Excellent |

### Recommendation: WebTransport

**For Tribes-inspired browser FPS:**

**Use WebTransport because:**
- Designed for client-server real-time applications
- Supports both reliable (chat, auth) and unreliable (game state) data
- Multiple streams prevent head-of-line blocking
- HTTP/3 provides 47% speed improvement on lossy connections
- Modern API designed for web developers
- Baseline 2026 support covers all modern browsers

**Implementation strategy:**
- **Game state updates:** Unreliable datagrams (fast, can drop old packets)
- **Player input:** Unreliable datagrams (fast, latest input matters most)
- **Chat messages:** Reliable streams (must arrive in order)
- **Authentication:** Reliable streams (critical security data)
- **Matchmaking:** Reliable streams (must arrive in order)
- **Demo recording:** Reliable streams (must not lose data)

**Fallback for old browsers:**
- Detect WebTransport support
- Fallback to WebSocket for unsupported browsers
- Note: Old browsers can't play competitive FPS well anyway (performance issues)

### Implementation Strategy

**Phase 1: Basic Authoritative Server**
- Server accepts input commands
- Server simulates movement and shooting
- Server sends full state snapshots
- Client displays server state (no prediction yet)
- Goal: Basic multiplayer, no lag compensation

**Phase 2: Client-Side Prediction**
- Client applies input immediately
- Client stores input history
- Server sends authoritative state
- Client reconciles prediction errors
- Goal: Instant movement feel

**Phase 3: Lag Compensation**
- Server maintains state history buffer
- On shoot, server rewinds to shooter's view tick
- Validate hit against rewound state
- Goal: "If you hit on your screen, you hit"

**Phase 4: Delta Compression**
- Implement delta encoding
- Only send changed entities
- Measure bandwidth reduction
- Goal: <100 bytes per snapshot

**Phase 5: Interest Management**
- Implement visibility culling
- Only send visible entities
- Measure CPU/bandwidth savings
- Goal: Scale to 16+ players

**Phase 6: Optimization**
- Tune tick rate (60Hz vs 64Hz)
- Optimize delta compression
- Tune interpolation buffer
- Measure peeker's advantage
- Goal: Balance feel vs cost

## Cost Analysis

### Bandwidth Requirements

**Without optimization (full state):**
- 16 players × 100 bytes state = 1.6KB per snapshot
- 60Hz tick rate = 96KB/sec per player
- 10k DAU = 960MB/sec = 2.5TB/day
- Cost: Prohibitive

**With delta compression + interest management (Exfil results):**
- 93 bytes per snapshot (P95)
- 60Hz tick rate = 5.6KB/sec per player
- 10k DAU = 56MB/sec = 4.8GB/day
- Cloudflare R2: $0.015/GB/month = $0.07/day
- **Cost: ~$2/month for 10k DAU**

### Cloudflare Workers Cost

**Base tier:**
- Free: 100,000 requests/day
- Paid: $5/month for 10M requests/day

**For 10k DAU:**
- Assume 20 requests/sec per player during play
- 10k DAU × 20 req/sec × 3600 sec = 720M requests/day
- Over base tier: 720M - 100M = 620M requests
- Cost: 620M / 10M × $5 = $310/month

**Optimization:**
- Reduce request rate with delta compression
- Batch updates (send every 2-3 ticks instead of every tick)
- Target: 10 requests/sec per player
- 10k DAU × 10 req/sec × 3600 sec = 360M requests/day
- Cost: 260M / 10M × $5 = $130/month

**Total estimated cost for 10k DAU:**
- Cloudflare Workers: $130/month
- Cloudflare R2: $2/month
- **Total: ~$132/month**

**Compare to traditional VPS:**
- DigitalOcean: $20/month per 200 players (Narrow.one)
- For 10k DAU: 50 servers × $20 = $1,000/month
- **Cloudflare Workers: 87% cheaper**

## Anti-Cheat Considerations

### Server-Side Validation

**What to validate:**
- Movement speed (no teleporting)
- Shooting rate (no rapid fire)
- Damage values (no one-shot kills)
- Position (no walking through walls)
- Input sequences (no impossible actions)

**How to validate:**
- Server-authoritative simulation
- Rate limiting on actions
- Sanity checks on state
- Ban suspicious patterns

### Client-Side Detection

**What to detect:**
- Aim patterns (too perfect)
- Reaction times (inhuman)
- Movement patterns (bunny hopping scripts)
- External tool signatures

**How to detect:**
- Statistical analysis of player behavior
- Heuristic detection
- Report suspicious accounts
- Manual review for bans

## Performance Targets

### Latency Budget

**Target feel:**
- Input to display: <16ms (1 frame at 60Hz)
- Shot to hit confirmation: <50ms
- Movement correction: <100ms
- Interpolation delay: 50-100ms (tunable)

**Acceptable ping ranges:**
- <30ms: Excellent (LAN-like)
- 30-60ms: Great
- 60-100ms: Acceptable
- 100-150ms: Playable with lag compensation
- 150ms+: Degraded but playable

### Tick Rate vs Cost

**Trade-offs:**
- 30Hz: Cheaper, less smooth
- 60Hz: Good balance, recommended
- 64Hz: Proven (Exfil), slightly more expensive
- 120Hz: Very smooth, expensive

**Recommendation:** Start with 60Hz, optimize, then consider 64Hz if needed.

## Implementation Complexity

### Difficulty Assessment

**Easy (1-2 weeks):**
- Basic authoritative server
- Simple client-server communication
- Full state snapshots

**Medium (2-4 weeks):**
- Client-side prediction
- Basic reconciliation
- Lag compensation

**Hard (4-8 weeks):**
- Delta compression
- Interest management
- Deterministic simulation
- Anti-cheat validation

**Very Hard (8+ weeks):**
- Perfect prediction/reconciliation
- Advanced lag compensation
- Sophisticated anti-cheat
- Performance optimization

### Recommended Approach

**Start simple:**
1. Basic authoritative server (no prediction)
2. Add client-side prediction
3. Add lag compensation
4. Optimize with delta compression
5. Add interest management
6. Tune and optimize

**Don't try to do everything at once.** Each layer adds complexity. Get basic multiplayer working first, then incrementally add features.

## Alternatives Considered

### P2P Networking (Rejected)

**Pros:**
- No server cost
- Lower latency (direct connection)

**Cons:**
- No authoritative server (cheating rampant)
- Host dependency (if host leaves, game ends)
- Harder to implement
- Not suitable for competitive FPS

**Conclusion:** Not viable for competitive FPS with anti-cheat requirements.

### Relay Server (Rejected)

**Pros:**
- Simple implementation
- Low server cost

**Cons:**
- No authoritative validation
- Clients can cheat easily
- No lag compensation
- Not competitive

**Conclusion:** Not suitable for competitive FPS.

### Third-Party Services (Photon, Nakama, etc.)

**Pros:**
- Faster implementation
- Proven technology
- Less custom code

**Cons:**
- Ongoing costs (per MAU)
- Less control
- Vendor lock-in
- May not optimize for our use case

**Conclusion:** Consider for MVP, but custom solution likely cheaper long-term.

## Conclusion

### Recommended Architecture

**For LAN-like feel with minimal cost:**
1. **Authoritative server** (Go or Rust)
2. **Client-side prediction** (instant movement)
3. **Lag compensation** (favor-the-shooter)
4. **64Hz tick rate** (proven by Exfil)
5. **Delta compression** (sub-1KB snapshots)
6. **Interest management** (only visible entities)
7. **Cloudflare Workers** (global edge, zero egress)
8. **Binary WebSocket protocol** (efficient)

### Expected Results

**Feel:**
- Instant movement (client-side prediction)
- Instant shooting (lag compensation)
- "If you hit on your screen, you hit" (favor-the-shooter)
- LAN-like feel even with 100ms ping

**Cost:**
- ~$130/month for 10k DAU
- 87% cheaper than traditional VPS
- Scales linearly with player count
- Zero egress fees (Cloudflare)

**Timeline:**
- Basic authoritative server: 2 weeks
- Client-side prediction: 2 weeks
- Lag compensation: 2 weeks
- Delta compression: 2 weeks
- Interest management: 2 weeks
- **Total: 10 weeks for full implementation**

### Next Steps

1. **Prototype basic authoritative server** (2 weeks)
   - Go server with WebSocket
   - Simple movement simulation
   - Full state snapshots
   - Test with 2-4 players

2. **Add client-side prediction** (2 weeks)
   - Immediate input application
   - Input history buffer
   - Reconciliation logic
   - Test prediction errors

3. **Measure and iterate**
   - Test with various ping values
   - Measure bandwidth
   - Tune parameters
   - Validate feel

4. **Add lag compensation** (2 weeks)
   - State history buffer
   - Rewind logic
   - Hit validation
   - Test hit registration

5. **Optimize** (4 weeks)
   - Delta compression
   - Interest management
   - Performance tuning
   - Cost measurement

The combination of proven techniques (client-side prediction, lag compensation, delta compression, interest management) with cost-effective hosting (Cloudflare Workers) should achieve Krunker-style LAN-like feel while keeping costs under $150/month even at 10k DAU.

## Server-as-a-Service Options for Multiplayer Shooters

### Game Server Hosting (VPS-style)

**OMC Cloud:**
- **Pricing:** $4/mo for basic VPS (2 vCPU, 4GB RAM, 40GB NVMe)
- **Features:** 24 global data centers, DDoS protection, NVMe storage
- **Pros:** Full root access, any game, predictable pricing
- **Cons:** Manual DevOps, need to manage scaling
- **Suitability:** Good for custom authoritative server implementation

**Godlike Host:**
- **Pricing:** $1-9/mo for gaming VPS (1-4 vCPU, 2-8GB RAM)
- **Features:** NVMe SSD, DDoS protection, instant scaling
- **Pros:** Very cheap, predictable per-GB pricing
- **Cons:** Manual DevOps, need to manage infrastructure
- **Suitability:** Good for custom authoritative server

### Backend as a Service (BaaS)

**PlayFab:**
- **Pricing:** Usage-based (MAU + API calls)
- **Cost for 10k DAU:** ~$275/mo
- **Features:** Auth, leaderboards, matchmaking, cloud save
- **Pros:** Microsoft-backed, comprehensive feature set
- **Cons:** Usage-based pricing can spike, vendor lock-in
- **Suitability:** Good for backend services, not real-time netcode

**Supabase:**
- **Pricing:** $25/mo Pro + usage overage
- **Cost for 10k DAU:** ~$400/mo
- **Features:** PostgreSQL, auth, real-time subscriptions
- **Pros:** Open-source, generous free tier, good for persistence
- **Cons:** Not designed for high-frequency game loops
- **Suitability:** Excellent for persistence/auth, not game server

**Photon:**
- **Pricing:** CCU-based (concurrent users)
- **Features:** Real-time networking, matchmaking, rooms
- **Pros:** Battle-tested, Unity integration
- **Cons:** Expensive at scale, Unity-focused
- **Suitability:** Good for Unity games, overkill for browser

### Game Server Orchestration

**Gameye:**
- **Pricing:** $0.07/vCPU/hr, no egress fees
- **Features:** 21 providers, 200+ datacenters, no SDK required
- **Pros:** Very cheap, no egress, 99.99% SLA
- **Cons:** Need to containerize game server
- **Suitability:** Excellent for custom authoritative server

**AWS GameLift:**
- **Pricing:** $3.3k-5.5k/mo for 1000 CCU + egress
- **Features:** AWS integration, FlexMatch, FleetIQ
- **Pros:** Mature, AWS ecosystem
- **Cons:** Very expensive, egress fees, AWS-only
- **Suitability:** Too expensive for indie project

### Open Source Frameworks

**Colyseus:**
- **Pricing:** Free (MIT license), or Colyseus Cloud (paid)
- **Features:** Room-based, state sync, delta compression, matchmaking
- **Pros:** Open-source, battle-tested, TypeScript
- **Cons:** Learning curve, need to host yourself
- **Suitability:** Excellent option - designed for real-time games

## Recommended Hosting Strategy

### For MVP (0-1k DAU)

**Cloudflare Workers + Supabase (Recommended)**
- **Game server:** Cloudflare Workers ($5/mo base)
- **Persistence:** Supabase ($25/mo Pro)
- **Total:** ~$30/mo
- **Pros:** Global edge, zero egress, cheap, scalable
- **Cons:** Need to implement custom netcode

**Godlike Host VPS + Supabase**
- **Game server:** Godlike Host ($4/mo for 2 vCPU, 4GB RAM)
- **Persistence:** Supabase ($25/mo Pro)
- **Total:** ~$29/mo
- **Pros:** Full control, predictable pricing
- **Cons:** Manual scaling, single region

**Colyseus Self-Hosted + VPS**
- **Game server:** Colyseus (free) + Godlike Host ($4/mo)
- **Persistence:** Supabase ($25/mo Pro)
- **Total:** ~$29/mo
- **Pros:** Framework handles netcode, battle-tested
- **Cons:** Learning curve, framework limitations

### For Growth (1k-10k DAU)

**Cloudflare Workers + Supabase (Recommended)**
- **Game server:** Cloudflare Workers (~$130/mo optimized)
- **Persistence:** Supabase (~$400/mo for 10k DAU)
- **Total:** ~$530/mo
- **Pros:** Scales automatically, global edge
- **Cons:** Need to optimize request rate

**Gameye Orchestration + Supabase**
- **Game server:** Gameye ($0.07/vCPU/hr × 24hrs × 10 servers = $168/mo)
- **Persistence:** Supabase (~$400/mo for 10k DAU)
- **Total:** ~$568/mo
- **Pros:** No egress fees, 99.99% SLA, multi-provider
- **Cons:** Need containerization

## Final Recommendation

**For Tribes-inspired browser FPS:**

**Phase 1 (MVP):**
- **Cloudflare Workers** for game server (custom Go/Rust implementation)
- **Supabase** for persistence/auth
- **Cost:** ~$30/mo for 0-1k DAU
- **Rationale:** Global edge, zero egress, cheap, full control

**Phase 2 (Growth):**
- Continue with Cloudflare Workers + Supabase
- Optimize delta compression and request rate
- **Cost:** ~$530/mo for 10k DAU
- **Rationale:** Scales automatically, no migration needed

**Why not other options:**
- **VPS hosting:** Manual DevOps overhead, single-region limitations
- **BaaS (PlayFab/Nakama):** Expensive at scale, vendor lock-in
- **Game orchestration (Gameye):** Good backup, but Cloudflare Workers cheaper for our use case
- **Colyseus:** Good framework, but custom implementation gives more control for Tribes-specific mechanics

**Cloudflare Workers + Supabase provides:**
- Global edge network (low latency worldwide)
- Zero egress fees (critical for bandwidth-heavy games)
- Automatic scaling (no DevOps overhead)
- Full control over netcode (critical for LAN-like feel)
- Cheap at all scales (under $1,500/mo even at 50k DAU)
- Proven technology (Krunker uses Cloudflare)
