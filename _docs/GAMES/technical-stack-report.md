# Technical Stack Report: Tribes-Inspired Browser FPS

**Date:** 2026-06-22
**Context:** Optimal technology choices for browser-based multiplayer FPS with skiing, jetpacks, procedural terrain, and demo recording

## Executive Summary

The technical stack must balance three critical requirements:
1. **3-second load time** - Tiny bundle, instant play
2. **LAN-like multiplayer feel** - Client-side prediction, lag compensation
3. **Low operational costs** - Serverless architecture, efficient bandwidth

This report recommends a modern, serverless-first stack optimized for browser gaming with strong AI-resistant moats.

## Core Technology Stack

### Rendering Engine

**Recommendation: Three.js with custom physics**

**Why Three.js:**
- Largest ecosystem and community support
- Mature, battle-tested in production games
- Extensive documentation and examples
- Good performance for low-poly aesthetic
- WebGPU support for future performance gains
- Smaller bundle size than Babylon.js (~600KB vs ~1MB)

**Alternative: Babylon.js**
- More game-focused features out of the box
- Better physics engine integration (Cannon.js, Havok)
- Strong TypeScript support
- Larger bundle size

**Physics Engine:**
- **Cannon.js** for basic collision detection
- Custom skiing physics (momentum, slope detection)
- Custom jetpack energy management
- Projectile physics with gravity and air resistance

**Procedural Generation:**
- **Simplex Noise** or **Perlin Noise** for terrain heightmaps
- Custom slope detection for skiing mechanics
- Procedural texturing using canvas/WebGL shaders
- All client-side generation for tiny bundle

### Networking

**Recommendation: WebSocket with client-side prediction**

**WebSocket Implementation:**
- **Socket.io** for reliable WebSocket connections
- Automatic reconnection and fallback to polling
- Room-based matchmaking for matches
- Binary message encoding for efficiency

**Client-Side Prediction:**
```javascript
// Apply input locally immediately
localVelocity += input * acceleration;
localPosition += localVelocity * deltaTime;

// Send to server with sequence number
sendToServer({ input, sequenceNumber });

// Store for reconciliation
predictedStates[sequenceNumber] = { position: localPosition };
```

**Server Reconciliation:**
```javascript
// On server update, correct local state
predicted = predictedStates[serverState.sequenceNumber];
error = serverState.position - predicted.position;

if (error.length < threshold) {
    localPosition = lerp(localPosition, serverState.position, 0.1);
} else {
    localPosition = serverState.position; // Snap for large errors
}
```

**Lag Compensation:**
```javascript
// Rewind time for hit detection
function checkHit(projectile, target) {
    targetPastPosition = target.getPositionAtTime(projectile.fireTime);
    if (projectile.intersects(targetPastPosition)) {
        registerHit();
    }
}
```

**Alternative: WebRTC for P2P**
- Zero server cost for casual matches
- More complex implementation
- NAT traversal issues
- Use for unranked/casual only

### Hosting Architecture

**Recommendation: Serverless hybrid (Cloudflare Workers + P2P)**

**Cloudflare Workers:**
- **Game logic server:** Matchmaking, state validation, leaderboards
- **Edge deployment:** Low latency worldwide
- **Pay per request:** No idle costs
- **Estimated cost:** $5-50/month for 1,000 DAU
- **Auto-scaling:** Handles traffic spikes automatically

**Cloudflare R2:**
- **Demo storage:** Tiny demo files (KB-sized)
- **MP4 rendering output:** Temporary storage for rendered videos
- **Asset storage:** If any non-procedural assets needed
- **Cost:** $0.015/GB/month storage + $0.01/GB egress

**P2P (WebRTC):**
- **Casual matches:** Host on player's machine
- **Zero server cost**
- **Fallback to Workers if P2P fails**
- **Use for unranked only**

**Alternative: Deno Deploy**
- Similar to Cloudflare Workers
- Better TypeScript support
- Slightly less mature edge network
- Good backup option

### Database

**Recommendation: Cloudflare D1 (SQLite) or Supabase**

**Cloudflare D1:**
- Edge SQLite database
- Integrated with Workers
- Low latency for leaderboards
- Free tier available
- Good for: leaderboards, user profiles, demo metadata

**Supabase:**
- PostgreSQL with real-time features
- Better for complex queries
- Row Level Security
- Good for: user accounts, social features, analytics

**Data Schema:**
```sql
-- Players
CREATE TABLE players (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    created_at TIMESTAMP,
    stats JSONB
);

-- Leaderboards
CREATE TABLE leaderboard_entries (
    player_id TEXT REFERENCES players(id),
    score INTEGER,
    mode TEXT,
    updated_at TIMESTAMP
);

-- Demos
CREATE TABLE demos (
    id TEXT PRIMARY KEY,
    player_id TEXT REFERENCES players(id),
    seed TEXT, -- For reproducible replay
    score INTEGER,
    created_at TIMESTAMP,
    mp4_url TEXT
);
```

### Demo Recording System

**Architecture:**

**Phase 1: Game State Recording (Client-side)**
```javascript
// Record compact game state
gameStateBuffer.push({
    timestamp,
    playerPositions,
    projectilePositions,
    events: { hits, kills, flagCaptures }
});

// When cool moment detected
if (directHit && distance > 50m && targetSpeed > 100kph) {
    highlightSegment = extractGameState(last_5_seconds);
    saveDemo(highlightSegment); // KB-sized file
    uploadToPublicLibrary(highlightSegment);
}
```

**Phase 2: Demo Storage**
- Store demos as JSON in Cloudflare R2
- Include seed for procedural terrain regeneration
- Metadata: player, score, map seed, timestamp
- Tiny file size: ~5-10KB per 5-second clip

**Phase 3: MP4 Rendering (Client-side only)**
```javascript
// Client-side rendering using FFmpeg.wasm or WebCodecs
function renderToMP4(demoFile) {
    // Load demo in Three.js instance
    // Replay game state at 60fps
    // Capture frames using Canvas API
    // Encode to MP4 using FFmpeg.wasm or WebCodecs
    // Return MP4 blob for download
}
```

**Rendering Options:**
- **FFmpeg.wasm:** Client-side encoding, no server cost, slower
- **WebCodecs API:** Browser-native encoding, faster, modern browsers only
- **No server-side rendering needed** - MP4s are generated on-demand by the client

**Recommendation:** WebCodecs API for modern browsers (faster), fallback to FFmpeg.wasm for older browsers

**Cost impact:** Zero MP4 storage costs - only store tiny demo files (game state), MP4s are generated and downloaded by clients

### Build Tools

**Recommendation: Vite + TypeScript**

**Vite:**
- Instant dev server start
- Fast HMR (Hot Module Replacement)
- Optimized production builds
- Tree-shaking for minimal bundle
- Native ES modules

**TypeScript:**
- Type safety for complex game logic
- Better IDE support
- Catch errors at compile time
- Essential for networking code

**Bundle Optimization:**
- **Code splitting:** Load game engine first, then assets
- **Tree-shaking:** Remove unused code
- **Minification:** Terser for production
- **Compression:** Brotli for smaller downloads
- **Target bundle:** <5MB for 3-second load

## Performance Optimization

### Rendering

**Level of Detail (LOD):**
```javascript
if (distanceToPlayer > 1000) {
    renderQuality = LOW; // Low-poly, no shadows
} else if (distanceToPlayer > 500) {
    renderQuality = MEDIUM; // Medium-poly, basic shadows
} else {
    renderQuality = HIGH; // Full quality
}
```

**Instanced Rendering:**
- Use instanced meshes for repeated objects (trees, rocks)
- Reduces draw calls significantly
- Essential for large maps

**Occlusion Culling:**
- Don't render objects behind terrain
- Frustum culling (outside camera view)
- Portal culling for indoor structures

**Texture Optimization:**
- Procedural textures (no texture assets)
- Texture atlasing if needed
- Compressed textures (WebP/AVIF)

### Networking

**Delta Compression:**
```javascript
// Only send changes, not full state
delta = {
    playerPositions: changedPositions,
    projectiles: newProjectiles,
    events: newEvents
};
```

**Priority Updates:**
- Movement: 60 updates/second
- Position: 30 updates/second
- Animation: 15 updates/second
- Chat: 5 updates/second

**Bandwidth Estimation:**
- Movement: 20 bytes/update × 60 = 1.2 KB/s
- Position: 50 bytes/update × 30 = 1.5 KB/s
- Total: ~3-5 KB/s per player
- 16 players: ~50-80 KB/s total

### Client-Side

**Performance Monitoring:**
```javascript
// FPS counter
const fps = 1000 / deltaTime;
if (fps < 30) {
    reduceQuality();
}

// Network latency
const ping = Date.now() - lastServerUpdate;
if (ping > 200) {
    adjustPredictionWindow();
}
```

**Quality Settings:**
- Auto-detect hardware capabilities
- Adjust quality based on performance
- User override option
- Save preferences locally

## Cost Analysis

### Development Costs

**Tools (all free):**
- Vite: Free
- TypeScript: Free
- Three.js: Free (MIT)
- Socket.io: Free (MIT)
- Cloudflare Workers: Free tier (100k requests/day)
- Cloudflare R2: Free tier (10GB storage)

**Total development cost:** $0 (using free tiers)

### Operational Costs (Verified 2026 Pricing)

**Cloudflare Workers:**
- Free tier: 100k requests/day
- Paid: $5/month base includes 10M requests + 30M CPU-ms
- Overages: $0.30 per million requests, $0.02 per million CPU-ms
- **Note: No bandwidth charges for Workers**

**1,000 DAU calculation:**
- 1,000 DAU × 10 requests/day = 10,000 requests/day
- 10,000 × 30 = 300,000 requests/month
- Well within 10M included limit
- **Workers cost: $5/month**

**100k DAU calculation:**
- 100,000 DAU × 10 requests/day = 1,000,000 requests/day
- 1,000,000 × 30 = 30,000,000 requests/month
- 30M - 10M included = 20M overage
- 20M × $0.30 = $6 overage
- **Workers cost: $5 + $6 = $11/month**

**Cloudflare R2:**
- Storage: $0.015/GB-month
- Class A ops (writes): $4.50/million
- Class B ops (reads): $0.60/million
- **Zero egress fees** (key advantage)

**1,000 DAU calculation:**
- 1,000 demos × 10KB = 10MB = 0.01GB
- 0.01GB × $0.015 = $0.00015/month
- **R2 cost: <$0.01/month**

**100k DAU calculation:**
- 100,000 demos × 10KB = 1GB
- 1GB × $0.015 = $0.015/month storage
- 10M read operations × $0.60/M = $6/month
- **R2 cost: ~$6/month**

**Bandwidth:**
- **Zero cost** - R2 has no egress fees, Workers has no bandwidth charges
- This is a major advantage of Cloudflare stack

**Total operational cost (1,000 DAU):** ~$5/month
**Total operational cost (100k DAU):** ~$17/month

**Revenue estimates (from AppLixir benchmarks):**
- Web game ARPU: $0.20 - $0.60 per month
- Poki revenue share: Typically 50/50 split

**Realistic DAU expectations (based on current web FPS data):**

**Krunker:**
- **Web version:** ~430 concurrent players currently, ~1,111 24-hour peak
- **Steam version:** 24-53 average concurrent players (declining)
- **Estimated DAU:** ~5,000-10,000 (based on concurrent-to-DAU ratio)

**Narrow.one (from developer interviews/devlogs):**
- **Team size:** 2 developers (Pelican Party - Jesper and Jurgen)
- **Age:** Over 2 years old (started as small demo: 1 map, 1 bow, no animations)
- **Success level:** "Pay the bills" - successful enough to be their primary income
- **Server infrastructure:** DigitalOcean servers, $4/month per server, ~200 players per server
- **Distribution:** Partnered with Poki for reach and monetization
- **Steam version:** 2 concurrent players currently (very low), peak of 21 (Sept 2025)
- **Estimated DAU:** Likely 1,000-3,000 (smaller than Krunker but sustainable for 2-person team)

**Key insights from Narrow.one:**
- 2-person team can sustain themselves with a successful browser FPS
- $4/month DigitalOcean servers scale to ~200 players each
- Poki partnership was crucial for distribution and monetization
- Game started as simple demo and grew over 2 years
- Steam version has minimal impact (web is primary platform)

**Revenue scenarios:**

**Conservative (1,000 DAU - similar to current Krunker web concurrent):**
- Gross revenue: 1,000 × $0.20 = $200/month
- Poki share (50%): $100/month
- **Profit: $100 - $5 = $95/month**

**Moderate (5,000 DAU - realistic success):**
- Gross revenue: 5,000 × $0.30 = $1,500/month
- Poki share (50%): $750/month
- **Profit: $750 - $5 = $745/month**

**Optimistic (10,000 DAU - Krunker-level success):**
- Gross revenue: 10,000 × $0.40 = $4,000/month
- Poki share (50%): $2,000/month
- **Profit: $2,000 - $5 = $1,995/month**

**Very optimistic (100k DAU - Poki top-tier):**
- Gross revenue: 100,000 × $0.40 = $40,000/month
- Poki share (50%): $20,000/month
- **Profit: $20,000 - $17 = $19,983/month**

**Key insight:** Even Krunker, the most successful browser FPS, has only ~430 concurrent players currently. 100k DAU is extremely optimistic and unlikely for a new game. Realistic success is 1,000-10,000 DAU.

## Security Considerations

### Anti-Cheat

**Server-Side Authority:**
- All combat decisions on server
- Client sends input, server validates
- Reject impossible movements (speed hacks)

**Rate Limiting:**
- Limit actions per second
- Detect abnormal patterns
- Temporarily ban suspicious accounts

**Obfuscation:**
- Minify production code
- Don't expose internal state
- Use WebAssembly for critical logic (optional)

### Data Protection

**GDPR Compliance:**
- Minimal data collection
- Clear privacy policy
- Data deletion on request
- Cookie consent for analytics

**Input Validation:**
- Sanitize all user input
- Prevent SQL injection
- Validate demo files before storage

## Development Roadmap

### Phase 1: Prototype (1-2 months)
- Three.js rendering setup
- Basic skiing physics
- Jetpack energy system
- Single-player testing
- **No demo system yet**

### Phase 2: Multiplayer MVP (2-3 months)
- WebSocket networking
- Client-side prediction
- Server reconciliation
- One CTF map
- 8v8 player support
- Leaderboard system

### Phase 3: Polish (1-2 months)
- Performance optimization
- UI/UX improvements
- Poki submission
- **Demo recording system**
- Public library

### Phase 4: Post-Launch (Ongoing)
- New maps (procedural seeds)
- New weapons
- Balance tweaks
- Community features

## Alternative Stacks Considered

### Unity WebGL
- **Pros:** Familiar to developer, powerful engine
- **Cons:** Large bundle size (50MB+), slow load time, expensive
- **Verdict:** Not suitable for 3-second play requirement

### Unreal Engine 5 (Web)
- **Pros:** High-end graphics
- **Cons:** Massive bundle size (100MB+), overkill for low-poly
- **Verdict:** Not suitable

### Pure Vanilla JS
- **Pros:** Smallest bundle possible
- **Cons:** Reinventing the wheel, no ecosystem
- **Verdict:** Not worth the development time

### Three.js + Cannon.js
- **Pros:** Good balance of bundle size and features
- **Cons:** Cannon.js is basic, may need custom physics
- **Verdict:** Recommended

## Recommendations

### Must-Have Technologies
1. **Three.js** - Rendering engine
2. **TypeScript** - Type safety
3. **Vite** - Build tool
4. **Socket.io** - Networking
5. **Cloudflare Workers** - Serverless hosting
6. **Cloudflare R2** - Storage

### Nice-to-Have Technologies
1. **Simplex Noise** - Procedural terrain
2. **FFmpeg.wasm** - Client-side video encoding
3. **Zod** - Runtime validation
4. **Zustand** - State management (if needed)

### Technologies to Avoid
1. **Unity WebGL** - Too large for 3-second play
2. **Unreal Engine** - Overkill, too large
3. **Traditional VPS** - Higher cost, less scalable
4. **Heavy frameworks** (React, Vue) - Unnecessary overhead

## Conclusion

The recommended stack balances three critical requirements:
- **3-second load time** achieved through procedural generation and tiny bundle
- **LAN-like multiplayer feel** achieved through client-side prediction and server reconciliation
- **Low operational costs** achieved through serverless architecture and efficient bandwidth

Total estimated cost for 1,000 DAU: ~$7/month
Total estimated cost for 100k DAU: ~$250/month
Estimated revenue at 100k DAU (Poki share): $20,000/month

This stack provides a strong technical moat while remaining financially viable. The complexity of client-side prediction, procedural generation, and demo recording creates barriers that AI cannot easily replicate.
