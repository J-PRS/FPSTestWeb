# P2P FPS Games Analysis Report

**Date:** 2026-06-22
**Objective:** Analyze peer-to-peer FPS games and understand why none have achieved success in competitive multiplayer

## Executive Summary

**Finding:** No successful competitive P2P FPS games exist. All major competitive FPS games (CS:GO, Valorant, Apex Legends, Call of Duty) use dedicated server architecture. P2P is limited to co-op games, technical demos, and niche projects.

**Key reasons for P2P failure in competitive FPS:**
- Anti-cheat vulnerabilities (host manipulation, client-side exploits)
- Reliability issues (host dependency, bandwidth constraints)
- Inconsistent player experience
- Complexity of implementation
- Industry standardization on dedicated servers

## P2P FPS Projects Analyzed

### web-quaker

**Description:** Quake 3 Arena ported to browser with WebRTC P2P multiplayer

**Technical details:**
- ioquake3 compiled to WebAssembly via Emscripten
- Custom networking layer replacing UDP with WebRTC DataChannels
- HTTP REST signaling for WebRTC handshake
- Host generates 4-character room code, others join
- Once DataChannel opens, all traffic flows P2P
- Mid-game joining supported

**Limitations:**
- Peer-to-peer architecture (one player's browser is the server)
- Performance depends on host's upload bandwidth
- More than 3-4 players get laggy
- No dedicated server (if host closes tab, game ends)
- 330MB first load (large asset download)

**Status:** Technical demo, not commercial product
**Success level:** None (proof of concept only)

### peerFire

**Description:** Low poly P2P FPS developed with Godot Engine and WebRTC

**Features:**
- P2P networking via WebRTC
- Low poly graphics
- Fast-paced action
- Character customization
- Cross-platform

**Limitations:**
- No dedicated servers
- Host dependency
- WebRTC complexity
- No evidence of significant player base

**Status:** Small indie project
**Success level:** Minimal (no evidence of commercial success)

### Trac Doom

**Description:** P2P Doom netplay with smart-contract backed stats

**Features:**
- Play classic Doom online without port-forwarding
- Deathmatch and co-op modes
- Smart-contract backed stats (kills, rankings, achievements)
- Max 4 players (Doom netplay limit)
- Custom WAD support

**Limitations:**
- Limited to 4 players
- Niche audience (Doom enthusiasts)
- P2P architecture
- Not a modern competitive FPS

**Status:** Niche project for Doom community
**Success level:** Limited (niche audience only)

### Xonotic WASM Port

**Description:** Xonotic (arena FPS) ported to WebAssembly with full P2P multiplayer

**Technical achievements:**
- DarkPlaces engine compiled to WASM/WebGL2
- Engine runs on worker via OffscreenCanvas
- GPU texture transcoding (5.3GB → few hundred MB)
- Streamed on-demand filesystem from Cloudflare R2
- SIMD optimization (-msimd128)
- P2P via WebRTC DataChannel (unreliable/unordered)
- Tested 1v1 across Pacific (Edmonton to Bangkok)

**Limitations:**
- P2P architecture
- Technical demo, not commercial game
- Host dependency
- Limited player count (bandwidth constraints)

**Status:** Technical achievement / proof of concept
**Success level:** None (demonstration of WASM capabilities)

### Undead Night Crew

**Description:** Co-op zombie survival game using P2P via Steam Datagram Relay

**Features:**
- P2P via Steam Datagram Relay (free relay network)
- Client-hosted sessions (UNC)
- Hot-standby architecture with deterministic election
- Host failover (4-7 second recovery)
- 80-90% bandwidth savings
- Server-validated RPCs
- Published by Galore Interactive

**Key difference:** This is a **co-op game**, not competitive FPS

**Why it works for co-op:**
- Less competitive pressure (cheating less impactful)
- Host failover mitigates disconnection issues
- Co-op players more tolerant of inconsistencies
- Steam provides NAT traversal via relay network

**Status:** Published commercial game
**Success level:** Moderate (published, but not a major hit; co-op not competitive)

## Why P2P Fails for Competitive FPS

### 1. Anti-Cheat Vulnerabilities

**Host manipulation:**
- Host controls game state
- Can manipulate position, health, damage
- No authoritative validation
- Other clients must trust host

**Client-side exploits:**
- Clients can modify local game state
- No server-side validation
- Memory manipulation possible
- Aimbots, wallhacks easily implemented

**No authoritative validation:**
- No single source of truth
- Each client runs game logic
- Inconsistent state across clients
- Hard to detect cheating

**Research findings:**
- "P2P increases the possibility of cheating" (RACS paper)
- "Hard to prevent cheating in P2P system unless you designate an authoritative peer" (GameDev StackExchange)
- Anti-cheat based on P2P is "dumb idea" - network glitches look like cheating, cheaters can trigger false positives (Reddit)

### 2. Reliability Issues

**Host dependency:**
- If host disconnects, game ends for everyone
- Host's internet quality affects all players
- Host's hardware performance affects all players
- Single point of failure

**Bandwidth constraints:**
- Host's upload bandwidth limits player count
- web-quaker: 3-4 players max due to bandwidth
- Higher player counts = more lag
- Asymmetric connections problematic

**Inconsistent experience:**
- Player experience varies based on host
- No consistent server tick rate
- No consistent latency
- Unfair competitive environment

**Connection issues:**
- NAT traversal required (STUN/TURN)
- Some networks block P2P
- Firewall issues
- Connection establishment complex

### 3. Implementation Complexity

**NAT traversal:**
- STUN/TURN servers required
- ICE candidate exchange
- Connection establishment complex
- Fallback mechanisms needed
- WebRTC signaling server required

**State synchronization:**
- Deterministic simulation required
- All clients must compute same state
- Input synchronization complex
- Replay for late joiners
- Convergence after reconnect

**Host election:**
- Need mechanism to select host
- Host failover required
- State transfer on host change
- Complex to implement correctly

**Undead Night Crew solution:**
- Hot-standby architecture with deterministic election
- 4-7 second recovery on host disconnect
- Shadow state on all peers
- Complex implementation (not trivial)

### 4. Player Experience Issues

**Latency variance:**
- Players connect to each other, not to optimized server
- Geographic clustering issues
- No edge network optimization
- Higher latency than dedicated servers

**Tick rate inconsistency:**
- Host's hardware affects tick rate
- No consistent simulation rate
- Unfair advantage/disadvantage
- Hard to balance gameplay

**Physics inconsistencies:**
- Different client hardware = different physics
- Floating point precision issues
- State divergence over time
- Desynchronization problems

### 5. Scalability Issues

**Player count limits:**
- Host bandwidth limits players
- web-quaker: 3-4 players max
- Trac Doom: 4 players max
- Linear bandwidth increase with players
- Not suitable for large matches

**Network topology:**
- Mesh topology (all-to-all) complex
- N² connections for N players
- Bandwidth scales poorly
- Not suitable for 16+ players

## Industry Standard: Dedicated Servers

### Why All Major Competitive FPS Use Dedicated Servers

**Anti-cheat:**
- Authoritative server validates all actions
- Clients send input only, not state
- Server-side validation prevents manipulation
- Consistent rule enforcement

**Reliability:**
- No host dependency
- Professional hosting (99.9% uptime)
- Consistent server performance
- Global edge networks

**Consistent experience:**
- Same tick rate for all players
- Same server hardware
- Optimized routing (edge networks)
- Fair competitive environment

**Scalability:**
- Horizontal scaling (add more servers)
- Load balancing
- Geographic distribution
- Support for large player counts

**Examples:**
- **CS:GO/CS2:** Dedicated servers, Valve Anti-Cheat
- **Valorant:** Dedicated servers, Riot Vanguard
- **Apex Legends:** Dedicated servers, EA anti-cheat
- **Call of Duty:** Dedicated servers, proprietary anti-cheat
- **Overwatch:** Dedicated servers, Blizzard anti-cheat

### Steam Datagram Relay (P2P with Relay)

**What it is:**
- Global relay network for P2P connectivity
- Free for Steamworks games
- Routes P2P connections through relay when direct connection fails
- Used by Undead Night Crew

**Why it doesn't solve P2P problems:**
- Still P2P architecture (host dependency)
- Still no authoritative validation
- Still anti-cheat vulnerable
- Only solves NAT traversal, not core issues

**Suitability:**
- Good for co-op games (Undead Night Crew)
- Not suitable for competitive FPS
- Reduces P2P complexity but not vulnerabilities

## Comparison: P2P vs Dedicated Server

| Aspect | P2P | Dedicated Server |
|--------|-----|------------------|
| **Anti-cheat** | Poor (host manipulation) | Excellent (authoritative) |
| **Reliability** | Poor (host dependency) | Excellent (99.9% uptime) |
| **Consistency** | Poor (varies by host) | Excellent (standardized) |
| **Scalability** | Poor (bandwidth limits) | Excellent (horizontal scaling) |
| **Latency** | Variable (peer-to-peer) | Optimized (edge networks) |
| **Implementation** | Complex (NAT, election) | Standard (well-understood) |
| **Cost** | Low (no server cost) | Higher (server hosting) |
| **Player count** | Limited (4-8 players) | High (16-128 players) |
| **Competitive fairness** | Poor | Excellent |
| **Industry adoption** | None (competitive FPS) | Universal (competitive FPS) |

## When P2P Works

### Co-op Games

**Why P2P works for co-op:**
- Less competitive pressure
- Cheating less impactful (playing together, not against)
- Players more tolerant of inconsistencies
- Host failover acceptable (brief interruption)
- Bandwidth requirements lower (fewer players)

**Examples:**
- **Undead Night Crew:** Co-op zombie survival
- **Trac Doom:** Co-op Doom play
- **Many indie co-op games:** Small player counts, casual play

### Technical Demos

**Why P2P used in demos:**
- No server cost for demo
- Proves technical capability
- Shows off WebRTC/WebAssembly
- Not intended for commercial use

**Examples:**
- **web-quaker:** Quake 3 in browser (technical demo)
- **Xonotic WASM:** Arena FPS port (technical achievement)

### Niche Communities

**Why P2P works for niche:**
- Small, trusted communities
- Less competitive pressure
- Tolerance for technical limitations
- Retro game enthusiasts

**Examples:**
- **Trac Doom:** Doom enthusiasts
- **Classic game netplay:** Niche communities

## Recommendations for Tribes-Inspired Browser FPS

### Do Not Use P2P

**Reasons:**
- Competitive FPS requires authoritative server for anti-cheat
- P2P has no successful competitive FPS examples
- Host dependency unacceptable for competitive play
- Industry standard is dedicated servers
- Player expectations for consistent experience

### Use Dedicated Server Architecture

**Recommended stack:**
- **Server:** Go or Rust (authoritative game loop)
- **Protocol:** WebTransport (HTTP/3) with binary encoding
- **Hosting:** Cloudflare Workers (global edge, zero egress)
- **Persistence:** Supabase (PostgreSQL)

**Benefits:**
- Authoritative validation (anti-cheat)
- Consistent player experience
- Scalable to 16+ players
- Global edge network (low latency)
- Industry-standard approach

**Cost:**
- ~$30/mo for MVP (0-1k DAU)
- ~$530/mo for growth (10k DAU)
- Still affordable at scale

### Alternative: Hybrid Approach (Not Recommended)

**Concept:** P2P for casual play, dedicated for ranked

**Why not recommended:**
- Two networking implementations (complex)
- Split player base
- Different experiences confuse players
- Still need dedicated servers for competitive
- Adds complexity without solving core problem

## Conclusion

**P2P FPS games have not achieved success in competitive multiplayer because:**

1. **Anti-cheat vulnerabilities** - Host manipulation and client-side exploits make fair competition impossible
2. **Reliability issues** - Host dependency and bandwidth constraints create inconsistent experience
3. **Implementation complexity** - NAT traversal, host election, state synchronization are complex
4. **Player experience** - Inconsistent latency, tick rate, and physics create unfair environment
5. **Scalability limits** - Bandwidth constraints limit player count to 4-8 players

**Industry standard is dedicated servers** for competitive FPS because they provide:
- Authoritative validation (anti-cheat)
- Consistent experience (standardized hardware, tick rate)
- Reliability (99.9% uptime, no host dependency)
- Scalability (horizontal scaling, global edge networks)
- Fair competitive environment

**For Tribes-inspired browser FPS:**
- Use dedicated server architecture
- Implement authoritative game loop
- Use WebTransport for modern protocol
- Host on Cloudflare Workers for cost-effective global edge
- Follow industry standard for competitive FPS

**P2P is suitable for:**
- Co-op games (Undead Night Crew)
- Technical demos (web-quaker, Xonotic WASM)
- Niche communities (Trac Doom)
- Casual play with trusted friends

**P2P is not suitable for:**
- Competitive FPS
- Ranked play
- Large player counts
- Fair competition
- Professional esports

The lack of successful P2P competitive FPS games is not an accident - it's a fundamental architectural limitation that makes P2P unsuitable for fair, competitive multiplayer.
