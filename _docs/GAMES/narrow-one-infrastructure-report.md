# Narrow.one Infrastructure Analysis: Cloudflare Workers vs DigitalOcean

**Date:** 2026-06-22
**Objective:** Analyze Narrow.one's networking infrastructure and compare Cloudflare Workers vs DigitalOcean for game server hosting

## Executive Summary

**Narrow.one uses DigitalOcean droplets for game servers** with Cloudflare as CDN/proxy. This is a proven, cost-effective approach that works well for their scale (~1,000 concurrent players).

**Cloudflare Workers with Durable Objects is a viable alternative** that offers:
- **Lower operational overhead** (no server management)
- **Global edge deployment** (300+ locations vs single region)
- **Zero egress fees** (significant cost savings at scale)
- **Auto-scaling** (no manual server management)

**However, Cloudflare Workers has limitations:**
- **Memory limits** (128MB vs DigitalOcean's 1GB+)
- **CPU time limits** (30ms per request vs unlimited on droplet)
- **Learning curve** (new paradigm vs traditional VM)
- **Cold starts** (though <5ms, still exists)

**Recommendation:** For MVP, **DigitalOcean is easier** (traditional VM, proven by Narrow.one). For scale, **Cloudflare Workers is better** (global edge, no egress fees, auto-scaling).

## Narrow.one Infrastructure Analysis

### Current Architecture

**Game Servers:**
- **Provider:** DigitalOcean
- **Server type:** Cheapest droplet ($4/month)
- **Capacity:** ~200 players per server
- **Current scale:** 9 servers for 1,023 concurrent players
- **Location:** Amsterdam, Netherlands (188.166.22.52)

**Auto-scaling System:**
- **Scale up:** Boot new server when current server reaches 200 players
- **Scale down:** Shut down server when below 100 players
- **Monitoring:** Custom application monitors player count per server
- **Goal:** Always enough servers for players, no unnecessary costs

**CDN/Proxy:**
- **Provider:** Cloudflare
- **Domain:** narrow.one (routes through Cloudflare)
- **Purpose:** CDN, DDoS protection, SSL termination
- **Mirror:** narrow-one.io for unblocked access (schools/workplaces)

**Matchmaking Logic:**
- **Geographic proximity:** Servers close to player get 20 points
- **Elo rating:** Similar skill level gets 50 points
- **Map availability:** Prefer maps player has downloaded
- **Player count:** Balance games, avoid full/empty games
- **Score-based:** Highest score determines game to join

### Cost Analysis

**Current costs (Narrow.one):**
- **Game servers:** 9 × $4/month = $36/month
- **Bandwidth:** Included in droplet price (1TB transfer)
- **CDN:** Cloudflare free tier
- **Total:** ~$36/month for 1,000 concurrent players

**Cost per player:**
- $36/month ÷ 1,000 players = $0.036/month per concurrent player
- Assuming 10k DAU with 10% concurrency = 1,000 concurrent
- Cost scales linearly with player count

### Advantages of DigitalOcean Approach

**1. Proven and Battle-Tested:**
- Narrow.one has been running this way since 2021
- 200M+ lifetime players
- Stable, predictable performance
- Well-understood operational model

**2. Simple and Predictable:**
- Traditional VM model (familiar to most developers)
- No runtime constraints (unlimited CPU, memory)
- Full control over server configuration
- Easy debugging (SSH access, full logs)

**3. Cost-Effective at Scale:**
- $4/month per 200 players = $0.02/month per player
- Included bandwidth (1TB per droplet)
- No hidden fees or complex pricing
- Predictable monthly bills

**4. Geographic Flexibility:**
- Can deploy servers in multiple regions
- Players connect to nearest server
- Manual control over server locations
- Can optimize for specific regions

### Disadvantages of DigitalOcean Approach

**1. Operational Overhead:**
- Must manage server lifecycle (boot, shutdown, monitor)
- Must implement auto-scaling logic
- Must handle server failures manually
- Must maintain server images and updates

**2. Manual Scaling:**
- Custom application needed for auto-scaling
- Delay between scaling trigger and server ready
- Risk of over-provisioning (paying for idle servers)
- Risk of under-provisioning (lag during spikes)

**3. Single Region Latency:**
- Players far from Amsterdam have higher ping
- No automatic geographic optimization
- Must manually deploy to multiple regions
- Complex multi-region management

**4. Bandwidth Costs at Scale:**
- 1TB included per droplet
- Overage: $0.01/GB (competitive but not free)
- At scale, bandwidth becomes significant cost
- No zero-egress model like Cloudflare

## Cloudflare Workers Alternative

### Architecture with Durable Objects

**Game Servers:**
- **Provider:** Cloudflare Workers + Durable Objects
- **Runtime:** V8 isolates at edge
- **Capacity:** Per-room isolation (each room is a Durable Object)
- **Deployment:** Global edge (300+ locations)
- **State:** Built-in SQLite per Durable Object

**Key Features:**
- **WebSocket support:** Built-in WebSocket server/client
- **Stateful serverless:** Durable Objects maintain state
- **Hibernation:** Connections persist without CPU when idle
- **Auto-scaling:** Automatic per-room isolation
- **Global distribution:** Players connect to nearest edge

### Cost Analysis

**Cloudflare Workers pricing:**
- **Free tier:** 100,000 requests/day
- **Paid tier:** $5/month for 10M requests
- **Durable Objects:** $0.15 per million read operations, $0.50 per million write operations
- **Egress:** Free (no bandwidth costs)
- **Storage:** R2 at $0.015/GB/month

**Estimated costs for 1,000 concurrent players:**
- **Workers:** $5/month (10M requests included)
- **Durable Objects:** ~$2-5/month (depends on read/write operations)
- **R2 storage:** ~$1-2/month (for game state, demos)
- **Total:** ~$8-12/month for 1,000 concurrent players

**Cost comparison:**
- DigitalOcean: $36/month for 1,000 players
- Cloudflare Workers: $8-12/month for 1,000 players
- **Savings:** ~$24-28/month (67-75% cheaper)

### Advantages of Cloudflare Workers

**1. Zero Operational Overhead:**
- No server management (no boot, shutdown, monitor)
- Auto-scaling built-in (per-room isolation)
- No server failures to handle (Cloudflare manages infrastructure)
- Deploy with `wrangler deploy` (single command)

**2. Global Edge Deployment:**
- 300+ edge locations worldwide
- Players automatically connect to nearest edge
- No manual multi-region management
- Consistent low latency globally

**3. Zero Egress Fees:**
- No bandwidth costs (significant at scale)
- R2 storage has no egress fees
- Predictable costs regardless of traffic
- Massive savings at high traffic

**4. Fast Cold Starts:**
- Workers boot in <5ms
- Durable Objects resume from hibernation instantly
- No delay when scaling up
- Players don't notice cold starts

**5. Built-in WebSocket Support:**
- Native WebSocket in Durable Objects
- No additional infrastructure needed
- Automatic connection management
- Built-in hibernation for idle connections

### Disadvantages of Cloudflare Workers

**1. Runtime Constraints:**
- **Memory limit:** 128MB (vs 1GB+ on DigitalOcean)
- **CPU time limit:** 30ms per request (vs unlimited)
- **Execution time limit:** 50ms for initial request
- **No full Node.js API:** Limited compatibility

**2. Learning Curve:**
- New paradigm (serverless, Durable Objects)
- Different mental model than traditional VMs
- Limited debugging tools compared to SSH
- Requires understanding of edge computing

**3. State Management Complexity:**
- Durable Objects have specific patterns
- Must design for stateful serverless
- Hibernation adds complexity
- SQLite per object (not traditional database)

**4. Limited Control:**
- Can't install custom software
- Can't access full Linux environment
- Limited to Workers runtime
- Vendor lock-in (Cloudflare only)

## Ease of Use Comparison

### DigitalOcean

**Setup:**
- Create droplet via web UI or API
- SSH into server
- Install dependencies (Node.js, game server)
- Configure firewall, networking
- Deploy game server code
- **Time:** 30-60 minutes initial setup

**Scaling:**
- Must implement custom auto-scaling logic
- Must monitor player count per server
- Must trigger scale up/down manually
- Must handle server boot time (1-2 minutes)
- **Time:** 1-2 days to implement auto-scaling

**Maintenance:**
- Update server OS and dependencies
- Monitor server health and logs
- Handle server failures manually
- Manage SSL certificates (if not using Cloudflare)
- **Time:** Ongoing, 1-2 hours/month

**Debugging:**
- SSH access to servers
- Full system logs available
- Can run debugging tools on server
- Can inspect running processes
- **Ease:** High (traditional debugging)

### Cloudflare Workers

**Setup:**
- Create Workers project
- Write game server code (TypeScript/JavaScript)
- Configure Durable Objects
- Deploy with `wrangler deploy`
- **Time:** 1-2 hours initial setup

**Scaling:**
- Automatic per-room isolation
- No manual scaling needed
- Durable Objects scale automatically
- No server boot time
- **Time:** Zero (built-in)

**Maintenance:**
- No server OS to update
- No server failures to handle
- Cloudflare manages infrastructure
- Deploy updates with `wrangler deploy`
- **Time:** Minimal, 15-30 minutes/month

**Debugging:**
- Cloudflare dashboard for logs
- Limited debugging tools
- Can't SSH into Workers
- Must rely on logging and metrics
- **Ease:** Medium (new paradigm)

## Cost Comparison at Scale

### Scenario 1: 1,000 Concurrent Players (MVP)

**DigitalOcean:**
- 5 servers × $4/month = $20/month
- Bandwidth: Included (5TB total)
- **Total:** $20/month

**Cloudflare Workers:**
- Workers: $5/month (10M requests)
- Durable Objects: ~$2/month
- R2 storage: ~$1/month
- **Total:** $8/month

**Winner:** Cloudflare Workers ($12/month savings)

### Scenario 2: 10,000 Concurrent Players (Growth)

**DigitalOcean:**
- 50 servers × $4/month = $200/month
- Bandwidth: 50TB included
- **Total:** $200/month

**Cloudflare Workers:**
- Workers: $5/month (10M requests)
- Additional requests: $0.50 per million (assuming 100M requests) = $45/month
- Durable Objects: ~$20/month
- R2 storage: ~$10/month
- **Total:** $80/month

**Winner:** Cloudflare Workers ($120/month savings)

### Scenario 3: 100,000 Concurrent Players (Scale)

**DigitalOcean:**
- 500 servers × $4/month = $2,000/month
- Bandwidth: 500TB included
- Auto-scaling infrastructure cost: +$500/month
- **Total:** $2,500/month

**Cloudflare Workers:**
- Workers: $5/month (10M requests)
- Additional requests: $0.50 per million (assuming 1B requests) = $495/month
- Durable Objects: ~$200/month
- R2 storage: ~$100/month
- **Total:** $800/month

**Winner:** Cloudflare Workers ($1,700/month savings)

**Note:** At scale, Cloudflare Workers becomes significantly cheaper due to:
- No egress fees (massive bandwidth savings)
- Auto-scaling (no over-provisioning)
- Global edge (no multi-region infrastructure)

## Technical Suitability for Tribes FPS

### DigitalOcean Suitability

**Pros:**
- **Proven by Narrow.one:** Same game type (browser FPS)
- **No runtime constraints:** Full CPU/memory for game loop
- **Custom physics:** Can implement any physics engine
- **Full control:** Can optimize for specific hardware
- **Familiar model:** Traditional VM, easy to debug

**Cons:**
- **Manual scaling:** Must implement auto-scaling
- **Single region:** Players far from server have high ping
- **Operational overhead:** Server management required
- **Bandwidth costs:** At scale, bandwidth becomes expensive

**Suitability:** High for MVP, Medium for scale

### Cloudflare Workers Suitability

**Pros:**
- **Global edge:** Automatic low latency worldwide
- **Auto-scaling:** No manual server management
- **Zero egress:** Massive cost savings at scale
- **WebSocket support:** Built-in for real-time multiplayer
- **Durable Objects:** Perfect for game rooms

**Cons:**
- **Runtime constraints:** 128MB memory, 30ms CPU limit
- **Physics limitations:** May not fit complex physics in constraints
- **Learning curve:** New paradigm, different mental model
- **Cold starts:** Though <5ms, still exists

**Suitability:** Medium for MVP, High for scale

### Specific Considerations for Tribes FPS

**Physics Requirements:**
- **Skiing/jetpack mechanics:** Custom physics required
- **64Hz tick rate:** High-frequency simulation
- **Deterministic simulation:** Required for authoritative server
- **State synchronization:** Complex game state

**DigitalOcean:**
- Can run any physics engine (Rust, Go, custom)
- No memory/CPU constraints
- Can optimize for 64Hz tick
- Full control over simulation

**Cloudflare Workers:**
- May struggle with complex physics in 128MB
- 30ms CPU limit may not fit 64Hz tick (15.6ms per tick)
- Need to optimize physics for constraints
- May need to simplify physics

**Networking Requirements:**
- **WebTransport:** Modern protocol for FPS
- **Delta compression:** Efficient state updates
- **Lag compensation:** Client-side prediction
- **Interest management:** Only send visible entities

**DigitalOcean:**
- Can implement any networking protocol
- Full control over optimization
- Can run custom WebSocket/WebTransport server
- No constraints on protocol complexity

**Cloudflare Workers:**
- Native WebSocket support (Durable Objects)
- WebTransport support coming
- Built-in optimization (edge deployment)
- May need to simplify protocol for constraints

## Recommendations

### Phase 1: MVP (0-1,000 DAU)

**Recommendation: DigitalOcean**

**Reasons:**
- **Proven approach:** Narrow.one uses it successfully
- **Easier to implement:** Traditional VM, familiar model
- **No runtime constraints:** Can implement complex physics
- **Faster development:** Less learning curve
- **Cost:** Affordable at small scale ($20-40/month)

**Implementation:**
- Start with 2-3 droplets ($4/month each)
- Implement basic auto-scaling (manual trigger)
- Focus on gameplay, not infrastructure
- Optimize for single region initially

### Phase 2: Growth (1,000-10,000 DAU)

**Recommendation: Evaluate Migration to Cloudflare Workers

**Reasons:**
- **Cost savings:** Significant at this scale
- **Global edge:** Better for international players
- **Auto-scaling:** Less operational overhead
- **Zero egress:** Bandwidth savings

**Migration strategy:**
- Implement game server in Cloudflare Workers + Durable Objects
- Test with small percentage of traffic
- Compare performance and costs
- Migrate gradually if benefits clear

### Phase 3: Scale (10,000+ DAU)

**Recommendation: Cloudflare Workers

**Reasons:**
- **Massive cost savings:** 60-70% cheaper at scale
- **Global edge:** Essential for international player base
- **Auto-scaling:** No manual server management
- **Zero egress:** Critical for bandwidth-heavy games

**Implementation:**
- Full migration to Cloudflare Workers
- Optimize physics for runtime constraints
- Implement per-room Durable Objects
- Leverage global edge deployment

## Conclusion

**Narrow.one's DigitalOcean approach is proven and cost-effective** for their scale (~1,000 concurrent players). It's a solid choice for MVP.

**Cloudflare Workers offers significant advantages** for scale:
- **67-75% cost savings** at 1,000 players
- **60-70% cost savings** at 10,000+ players
- **Global edge deployment** (300+ locations)
- **Zero operational overhead** (auto-scaling)
- **Zero egress fees** (massive bandwidth savings)

**However, Cloudflare Workers has constraints:**
- **128MB memory limit** (may not fit complex physics)
- **30ms CPU limit** (may not fit 64Hz tick)
- **Learning curve** (new paradigm)
- **Vendor lock-in** (Cloudflare only)

**For Tribes-inspired browser FPS:**
- **Start with DigitalOcean** for MVP (proven, easier, no constraints)
- **Evaluate Cloudflare Workers** at growth phase (test migration)
- **Migrate to Cloudflare Workers** at scale (cost savings, global edge)

**The path is clear:** DigitalOcean for MVP, Cloudflare Workers for scale. Narrow.one proved DigitalOcean works. Cloudflare Workers offers the future with lower costs and global edge deployment.
