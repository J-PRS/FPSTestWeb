# Web Shooter Development Plan
## Immediately Playable Browser FPS (Tribes 2-style Aesthetic)

---

## Research Summary

### Key Competitors Analysis

**Krunker.io** (Market Leader)
- **Tech Stack**: Three.js (WebGL), custom server infrastructure
- **Performance**: Runs on low-end machines, no GPU required for browser
- **Features**: Multiple classes, map editor, account system, custom content
- **Load Time**: Instant browser play, lightweight client option
- **Player Base**: Massive international community

**War Brokers**
- **Features**: Vehicle combat (tanks, helicopters, drones), larger maps
- **Progression**: XP system, daily missions, loadout management
- **Trade-off**: Longer initial load times but richer gameplay

**Venge.io**
- **Style**: Hero-based shooter with unique abilities
- **Graphics**: More polished than block-style competitors
- **Focus**: Objective-based gameplay

**Bullet Force**
- **Visuals**: Console-quality graphics, realistic environments
- **Depth**: Rank progression, weapon customization, private matches
- **Trade-off**: Higher system requirements

---

## Technical Architecture

### Minimal Viable Stack

**Client-Side**
- **Babylon.js** - 3D WebGL/WebGPU rendering (chosen for long-term scalability)
- **Svelte** - UI layer for HUD, menus, settings (compiles to vanilla JS, excellent performance)
- **Vite** - Build tool and dev server (fast HMR, optimized production builds)
- **ws client** - Lightweight WebSocket (matches server ws library)
- **Pointer Lock API** - First-person mouse control
- **Web Audio API** - Sound effects (minimal, synthesized)
- **Vanilla JS** - Game logic (no framework overhead for maximum performance)

**Server-Side**
- **Node.js** - WebSocket server
- **ws library** - Lightweight WebSocket (3-5x faster than Socket.io, minimal overhead)
- **Custom binary protocol** - Not JSON (reduces bandwidth by 50-70%, faster parsing)
- **WebWorkers** - Network processing off main thread (preserve 60 FPS rendering)
- **In-Memory State** - Room-based game state (no database for MVP)
- **10-20Hz tick rate** - Low tick rate with client-side tricks (Krunker-style, reduces server costs)
- **Lag compensation** - Server-side rewind for hit detection ("what you hit is what you get")

**Hosting**
- **Client**: Vercel/Netlify (free tier, CDN, HTTPS)
- **Server**: Railway/Render/Heroku (free tier WebSocket support)
- **Alternative**: Cloudflare Workers (edge computing, global distribution)

### Engine Decision Analysis: Babylon.js vs Alternatives

**Research Findings for Tribes 2-Style Web FPS**:

**Babylon.js**:
- Bundle size: ~1.4MB (everything included)
- Complete game engine with physics, audio, particles, collision
- Microsoft-backed, stable API, backward compatibility
- Strong WebXR support
- Proven multiplayer performance: 70+ FPS on low-end, 140+ FPS on high-end
- Node Material Editor for visual shader creation
- **Trade-off**: Heavier initial load than minimal frameworks

**Three.js**:
- Bundle size: ~168KB (core only)
- Rendering library only - must build custom architecture
- Krunker.io uses Three.js successfully
- Largest community (5M weekly downloads)
- WebGPU production-ready with zero config
- **Trade-off**: Requires significant custom engineering for game features
- **Risk**: Codebase fragmentation at scale without strong discipline

**PlayCanvas**:
- Bundle size: ~1-2MB runtime
- Cloud-based visual editor with real-time collaboration
- Optimized for mobile performance out of the box
- WebGL2 + WebGPU support
- Small runtime, efficient asset compression
- **Trade-off**: Cloud-based workflow may not suit all teams
- **Best for**: Teams with non-technical members, rapid prototyping

**Defold**:
- Bundle size: ~1.14MB (smallest)
- WebAssembly by default, excellent load times
- Built-in publishing to web platforms
- **Trade-off**: Lua scripting, smaller community
- **Best for**: Mobile-first web games where load time is critical

**Recommendation for Tribes 2-Style FPS**:

**Babylon.js remains the top choice** because:
1. **Complete game engine** - Physics, audio, collision, animation included (no assembly required)
2. **Proven multiplayer performance** - Real-world example achieving 70+ FPS on low-end devices
3. **Long-term scalability** - Opinionated structure prevents codebase fragmentation
4. **Development speed** - Built-in tools reduce custom engineering effort
5. **Microsoft backing** - Stable API, backward compatibility for 5+ year projects

**Bundle size concern (1.4MB vs 168KB)** is mitigated by:
- Tribes 2 aesthetic (medium-poly, not hyper-realistic) keeps asset sizes manageable
- Target specs (Intel HD 5000+, 6GB RAM) can handle 1.4MB engine + ~8MB total assets
- Development time savings outweigh initial load difference
- Dynamic quality scaling can adjust for lower-end devices

**Alternative**: If initial load time is absolutely critical (<3 seconds), consider **PlayCanvas** for mobile optimization, but Babylon.js offers better long-term maintainability for complex multiplayer FPS.

### Multiplayer Networking Strategy

**Networking Library Decision**:

**ws library** (Recommended):
- 3-5x faster than Socket.io for raw message throughput
- Handles 50K+ connections per server
- Minimal overhead, low-level control
- No automatic reconnection (implement custom)
- **Best for**: Maximum performance, lean bandwidth usage

**Rhubarb** (Alternative):
- Specifically designed for multiplayer JS games
- WebWorkers for network processing (off main thread)
- Binary protocol with transferables (zero copy, no GC)
- Protocol definitions shared between server/client
- **Best for**: Maximum 60 FPS preservation, complex games

**Decision**: Start with **ws library** for simplicity, migrate to Rhubarb if main thread blocking becomes an issue.

**Binary Protocol vs JSON**:
- **Binary**: 50-70% bandwidth reduction, faster parsing, harder to analyze
- **JSON**: Human-readable, easier debugging, 2-3x larger payload
- **Decision**: Custom binary protocol for position/input data, JSON for lobby/settings

**Tick Rate Strategy**:

**Krunker.io Approach** (Proven):
- 10Hz tick rate (100ms server updates)
- Client-side prediction for immediate response
- Server reconciliation for correction
- Lag compensation (server rewind) for hit detection
- **Result**: LAN-like feel despite low tick rate

**Why Low Tick Rate Works**:
- Tick rate is a major cost decision (CPU + bandwidth)
- VALORANT at 128Hz = years-long engineering investment
- Apex at 20Hz, CS2 at 64Hz with subtick, Krunker at 10Hz
- Client-side tricks mask low tick rate from player perception

**Our Strategy**:
- Start at 15Hz (67ms updates) - balance between cost and responsiveness
- Implement aggressive client-side prediction
- Server-side lag compensation with 200-500ms rewind buffer
- Interpolation for smooth enemy movement
- Delta compression (send only changes)

**Lag Compensation Techniques**:

1. **Client-Side Prediction**:
   - Player inputs processed immediately on client
   - Predict movement locally before server response
   - Eliminates input latency perception

2. **Server Reconciliation**:
   - Server sends authoritative state
   - Client reconciles predicted state with server state
   - Smooth correction (snap only if large discrepancy)

3. **Lag Compensation (Rewind)**:
   - Server rewinds time when processing shots
   - Uses player's latency to determine "when" shot occurred
   - Checks hit detection at that historical moment
   - "What you hit is what you get" - LAN feel

4. **Interpolation**:
   - Smooth enemy movement between server snapshots
   - 100-200ms interpolation buffer
   - Hides network jitter

**Bandwidth Optimization**:
- Binary protocol for position data (Float32Arrays)
- Delta compression (send only changed values)
- Prioritize critical data (shots > movement > chat)
- Adaptive quality based on connection

**Expected Performance**:
- 15Hz tick rate = ~50-100 kbps per player
- 16-player room = ~800-1600 kbps total
- Server cost: 1-2x cheaper than 60Hz equivalent
- Player perception: LAN-like with proper lag comp

### Build Tool: Vite

**Why Vite**:
- **Official support**: Babylon.js 9 template uses Vite 8, Svelte uses Vite by default
- **Performance**: Lightning-fast HMR (Hot Module Replacement) for rapid iteration
- **Optimization**: Tree-shaking, code splitting, and minification out of the box
- **Modern**: Native ES modules, no bundling during development
- **Ecosystem**: Excellent plugin support for TypeScript, Svelte, Babylon.js

**Decision**: Vite is the obvious choice - it's the standard for both Babylon.js and Svelte in 2026.

### UI Framework Decision: Svelte for Game HUD

**Why Svelte for Game UI**:

**Performance**:
- Compiles to vanilla JS - no virtual DOM overhead
- Svelte 5 Runes deliver measurably faster updates in high-frequency scenarios
- Smaller bundle sizes than React (critical for initial load)
- Proven real-time performance (log viewers, streaming applications)

**Developer Experience**:
- Less boilerplate, simpler mental model
- Explicit reactivity with `$state`, `$derived`, `$effect`
- Consistently ranks among most admired frameworks in developer surveys
- Faster ramp-up for small teams

**Babylon.js Integration**:
- Official Babylon.js 9 template includes Svelte support
- Multiple proven integrations: BabylonJS-Svelte-Example, svelte-babylon
- Reactive components for 3D scene management
- Clean separation: Babylon.js handles canvas, Svelte handles DOM UI overlay

**Game UI Specifics**:
- HUD elements (health, ammo, score) update frequently - Svelte's compile-time approach excels
- Menus, settings, lobby screens - Svelte's component model ideal
- CSS animations perform well when positioned correctly (not on canvas)
- Avoid rendering UI on canvas - use DOM overlay for better performance

**Alternatives Considered**:
- **React**: Larger ecosystem but virtual DOM overhead, more boilerplate
- **Vanilla JS**: Maximum performance but poor developer experience for complex UI
- **Babylon GUI**: Built-in but limited compared to full framework

**Decision**: Svelte for UI layer - compiles to vanilla JS for performance while providing excellent developer experience.

### Why Babylon.js Over Three.js

**Three.js at Scale Issues**:
- Lightweight but requires building custom architecture on top
- Codebase fragmentation without strong discipline
- Different patterns lead to high maintenance costs
- Custom pipelines need rewrites when standards change
- Durability depends entirely on custom architectural layer

**Babylon.js Advantages**:
- Opinionated, structured APIs with consistent patterns
- Built-in tools (Asset Manager, Inspector, Node Material Editor)
- Predictable standardization reduces decision fatigue
- Microsoft-backed with backward compatibility focus
- Lower refactoring costs, better long-term maintainability
- Updates integrate smoothly with minimal code changes
- Better for 5+ year lifecycle projects

**Decision**: Babylon.js for multiplayer FPS scalability despite Three.js being easier to start with.

---

## Performance Optimization Strategy

### Visual Style
- **Tribes 2-inspired aesthetic** (early 2000s clean sci-fi military)
- **Medium-poly models** with clean textures (not blocky, not hyper-realistic)
- **Outdoor terrain-based maps** with rolling hills and bases
- **Limited color palette** (earth tones, military greens/blues)
- **Simple but readable textures** (512x512 max for performance)
- **Minimal lighting calculations** (baked lightmaps where possible)
- **Pre-baked shadows** (no real-time shadows)
- **Clean silhouette-based character designs** for readability

### Rendering Optimizations
- **Dynamic resolution scaling** based on performance
- **Smaller back buffer** rendering with upscaling
- **Batch draw calls** (combine similar objects)
- **Texture atlasing** (multiple sprites in single texture)
- **Per-pixel VRAM budget** management
- **Object pooling** for bullets, particles, effects

### Network Optimizations
- **Binary data transmission** (not JSON)
- **Client-side prediction** for movement
- **Server reconciliation** for position correction
- **Interpolation** for smooth player movement
- **Delta compression** (send only changes)
- **30-60 tick rate** (adjustable based on server load)

---

## Development Phases

### Phase 1: Core Engine (Week 1-2)
**Objective**: Basic 3D movement and rendering

**Tasks**:
- Set up Babylon.js scene with basic lighting
- Implement first-person camera controls (Pointer Lock)
- Create medium-poly player character with clean silhouette
- Basic WASD movement with collision detection
- Jump mechanics
- Simple floor/room geometry

**Success Criteria**:
- Player can move around a simple room
- Smooth 60 FPS on mid-range hardware
- Responsive controls

---

### Phase 2: Shooting Mechanics (Week 2-3)
**Objective**: Basic weapon system

**Tasks**:
- Implement raycasting for hit detection
- Create medium-poly weapon model with clean textures
- Add shooting animation (simple recoil)
- Implement damage system
- Add basic sound effects (Web Audio API synthesis)
- Create simple target practice mode

**Success Criteria**:
- Player can shoot and hit targets
- Visual and audio feedback on hits
- Accurate hit detection

---

### Phase 3: Multiplayer Foundation (Week 3-4)
**Objective**: Real-time multiplayer

**Tasks**:
- Set up Node.js server with Socket.io
- Implement room system (lobby → game)
- Player join/leave handling
- Position synchronization (client-side prediction)
- Basic player interpolation
- Implement binary protocol for position data

**Success Criteria**:
- Multiple players can join same room
- See other players moving smoothly
- <100ms latency perception

---

### Phase 4: Game Modes (Week 4-5)
**Objective**: Playable game modes

**Tasks**:
- Free-for-All deathmatch
- Team Deathmatch (red vs blue)
- Score tracking
- Respawn system
- Match timer
- Kill feed

**Success Criteria**:
- Complete matches can be played
- Score tracking works
- Fun gameplay loop

---

### Phase 5: Maps & Content (Week 5-6)
**Objective**: Multiple playable maps

**Tasks**:
- Design 3-5 simple arena maps
- Implement map selection
- Add spawn points
- Basic cover objects
- Map-specific gameplay elements

**Success Criteria**:
- 3 distinct maps available
- Balanced gameplay across maps
- Fast map loading

---

### Phase 6: Polish & Optimization (Week 6-7)
**Objective**: Performance and UX improvements

**Tasks**:
- Performance profiling and optimization
- Add settings menu (graphics quality, sensitivity)
- Implement dynamic resolution scaling
- Add crosshair customization
- Improve visual feedback (hit markers, damage indicators)
- Add simple UI (health, ammo, score)

**Success Criteria**:
- Runs smoothly on low-end hardware
- Good user experience
- Customizable controls

---

### Phase 7: Deployment (Week 7-8)
**Objective**: Public deployment

**Tasks**:
- Deploy client to Vercel/Netlify
- Deploy server to Railway/Render
- Set up custom domain
- Test multiplayer across different networks
- Add basic analytics
- Create landing page

**Success Criteria**:
- Game accessible via URL
- Multiplayer works across internet
- Stable performance

---

## Technical Specifications

### Minimum Requirements (Target)
- **Browser**: Chrome 90+, Firefox 88+, Edge 90+
- **GPU**: Integrated graphics (Intel HD 5000+ or equivalent)
- **RAM**: 6GB (increased for texture memory)
- **CPU**: Dual-core 2.5GHz+
- **Network**: 1 Mbps upload/download

### Recommended Requirements
- **GPU**: Dedicated GPU (GTX 1050+)
- **RAM**: 8GB
- **CPU**: Quad-core 3GHz+
- **Network**: 5 Mbps upload/download

### File Size Targets
- **Initial Load**: <8MB (compressed) - increased for textures
- **Total Assets**: <30MB - increased for character/weapon assets
- **Per Map**: <3MB - increased for terrain data

---

## MVP Feature Set

### Core Features
- [x] First-person movement
- [x] Shooting mechanics
- [x] Real-time multiplayer (8-16 players)
- [x] 2 game modes (FFA, TDM)
- [x] 3 maps
- [x] Basic UI (health, ammo, score)
- [x] Settings menu

### Stretch Features (Post-MVP)
- [ ] Account system
- [ ] Progression/ranking
- [ ] Weapon customization
- [ ] Map editor
- [ ] Spectator mode
- [ ] Voice chat
- [ ] More game modes (CTF, Search & Destroy)
- [ ] Destructible terrain (voxel-based, Deep Rock Galactic style)

**Destructible Terrain Research**:
- Reference: [How To Make 3D Destructible Terrain in Godot](https://www.youtube.com/watch?v=D8IqImS6u8M)
- Godot Voxel Tools: https://github.com/Zylann/godot_voxel
- Consider for map editor and dynamic gameplay
- Would require custom implementation in Babylon.js

---

## Risk Assessment

### Technical Risks
- **WebSocket latency**: Mitigate with client-side prediction
- **Performance on low-end**: Implement dynamic quality scaling
- **Cheating**: Basic server-side validation (expand later)
- **Browser compatibility**: Test on major browsers, fallbacks

### Development Risks
- **Scope creep**: Stick to MVP features first
- **Network code complexity**: Use proven libraries (Socket.io)
- **Asset creation**: Use modular kit approach (base pieces + variations)

---

## Next Steps

1. **Set up development environment**
   - Initialize Three.js project
   - Set up Node.js server skeleton
   - Create basic folder structure

2. **Create first prototype**
   - Implement Phase 1 (Core Engine)
   - Test performance on target hardware
   - Iterate on movement feel

3. **Build incrementally**
   - Follow phased approach
   - Test each phase thoroughly
   - Gather feedback early

---

## Success Metrics

### Technical Metrics
- Load time <8 seconds (increased for textures)
- 60 FPS on target hardware
- <100ms perceived latency
- <8MB initial download

### User Metrics
- Session length >5 minutes
- Return rate >30%
- Multiplayer match completion >80%

---

## Resources

### Libraries & Tools
- Babylon.js: https://babylonjs.com/
- Babylon.js Inspector: https://doc.babylonjs.com/toolsAndResources/inspector
- Socket.io: https://socket.io/
- Cannon.js (physics): https://schteppe.github.io/cannon.js/
- Rhubarb (binary WebSocket): https://github.com/oguzeroglu/Rhubarb

### Learning Resources
- Babylon.js FPS tutorial: https://doc.babylonjs.com/featuresAndDeepDive/cameras/arcRotateCamera
- Babylon.js game development: https://doc.babylonjs.com/featuresAndDeepDive/games
- WebGL best practices: https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
- Game networking: https://gafferongames.com/post/udp_vs_tcp/
- Babylon.js vs Three.js comparison: https://dev.to/devin-rosario/babylonjs-vs-threejs-the-360deg-technical-comparison-for-production-workloads-2fn6

### Reference Games
- Krunker.io: https://krunker.io/
- War Brokers: https://warbrokers.io/
- Venge.io: https://venge.io/

---

*Last Updated: June 2026*
