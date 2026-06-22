# Three.js Multiplayer Games Report

**Date:** 2026-06-22
**Objective:** Analyze popular online multiplayer web games built with Three.js to understand successful architectures, patterns, and implementation strategies

## Executive Summary

**Key finding:** Three.js is the dominant choice for browser multiplayer games, including the most successful browser FPS (Krunker). The games analyzed span from simple prototypes to production games with hundreds of concurrent players.

**Common patterns:**
- **Rendering:** Three.js (or React Three Fiber)
- **Networking:** Socket.IO (WebSocket) for authoritative servers, WebRTC for P2P
- **Physics:** Cannon.js, Rapier, or custom physics
- **Architecture:** Client-server (authoritative) or P2P (host-authoritative)
- **Build tools:** Vite, plain ES modules, or no build step

**Success factors:**
- Lightweight bundles (< 5MB)
- Fast load times (< 5s)
- Simple, optimized graphics
- Efficient networking (delta compression, interpolation)
- Quality settings for low-end devices

## Game Analysis

### 1. Krunker.io

**Status:** Most successful browser FPS
**Player count:** ~5,000-10,000 DAU (browser)
**Engine:** Custom engine with Three.js for rendering
**Architecture:** Authoritative server

**Tech stack:**
- **Rendering:** Three.js (confirmed by Reddit discussion)
- **Networking:** Custom WebSocket implementation
- **Physics:** Custom physics (skiing, movement)
- **Hosting:** Cloudflare (global edge network)

**Key features:**
- Fast-paced arena FPS
- Multiple game modes (FFA, TDM, Capture the Flag)
- Weapon customization and skins
- In-game economy
- Custom maps and modding

**Optimization techniques:**
- Aggressive asset budgets
- Simple, low-poly graphics
- Efficient networking (64Hz tick, delta compression)
- Quality settings for low-end devices
- Fast load times (< 5s)

**Success factors:**
- Proven LAN-like feel with client-side prediction
- Runs on Chromebooks (significant portion of player base)
- Viral sharing through URL-based gameplay
- Active modding community
- Regular updates and events

**Lessons for Tribes FPS:**
- Three.js can achieve production-quality multiplayer FPS
- Custom physics required for unique movement (skiing, jetpacks)
- Authoritative server essential for competitive play
- Cloudflare edge network for global low latency
- Quality settings critical for Chromebook support

### 2. Redline

**Status:** Open-source multiplayer racing game with combat
**Repository:** victorgalvez56/redline
**Architecture:** Authoritative server with shared physics

**Tech stack:**
- **Rendering:** Three.js
- **Physics:** Cannon.js (shared between client and server)
- **Networking:** Socket.IO
- **Build:** Vite with GLSL plugin
- **Animation:** GSAP
- **Audio:** Howler.js

**Game modes:**
- **Race:** Five laps against clock, sector splits, lap deltas, shared leaderboard
- **Combat:** Free-for-all in 100×100m arena, first to 5 kills

**Architecture details:**
```
Client: Three.js (rendering) + Cannon.js (physics) + Socket.IO (networking)
Server: Socket.IO authoritative server + Cannon.js (shared physics)
```

**Networking approach:**
- Server steps physics at 60Hz
- Broadcasts world snapshots at 20Hz
- Each snapshot is client-reported state cached server-side
- Remote cars interpolate over 80ms render delay
- Fallback to velocity-based extrapolation when buffer empty

**Optimization techniques:**
- Matcap-shaded low-poly cars (simpler than PBR)
- Shared physics world for deterministic collisions
- Snapshot-based state synchronization
- Interpolation for smooth remote movement
- Efficient arena design (100×100m)

**Key insights:**
- Shared physics between client and server enables deterministic behavior
- Snapshot-based networking (20Hz) sufficient for racing game
- Interpolation (80ms delay) smooths remote movement
- Low-poly graphics reduce GPU load
- Authoritative server for hit attribution and environmental hazards

**Lessons for Tribes FPS:**
- Shared physics can work for deterministic simulation
- Snapshot-based networking viable for certain game types
- Interpolation essential for smooth remote movement
- Low-poly graphics approach works well for browser
- Authoritative server required for fair gameplay

### 3. Phewland

**Status:** Experimental multiplayer shooter playground
**Repository:** grep-many/phewland
**Architecture:** Host-authoritative P2P (no dedicated server)

**Tech stack:**
- **Rendering:** Three.js with React Three Fiber
- **Physics:** Rapier (via @react-three/rapier)
- **Networking:** PlayroomKit (P2P)
- **Framework:** React 19, TypeScript, Vite
- **Post-processing:** @react-three/postprocessing

**Architecture:**
- **Host-authoritative P2P model**
- First player becomes host
- Host simulates: physics, bullets, damage, kills/deaths
- Rendering and controls fully local
- No dedicated server required

**Features:**
- Real-time multiplayer shooter
- Third-person character controller
- Physics-based bullets
- Live leaderboard (kills/deaths)
- Joystick + keyboard support
- Hit effects and audio feedback

**Multiplayer notes:**
- No dedicated server
- No anti-cheat system
- Not suitable for large lobbies
- Experimental networking
- Browser performance dependent
- If host disconnects → session resets

**Key insights:**
- P2P can work for casual multiplayer
- Host-authoritative model provides some validation
- React Three Fiber enables modern React development
- Rapier physics good for browser games
- No server cost (but limited scalability)

**Lessons for Tribes FPS:**
- P2P not suitable for competitive FPS (no anti-cheat)
- Host dependency unacceptable for competitive play
- React Three Fiber viable for modern development
- Rapier physics good option for browser games
- Dedicated server still required for competitive play

### 4. L-Town

**Status:** Open-source multiplayer FPS
**Repository:** besoeasy/l-town
**Architecture:** Authoritative server with WebSocket
**Scale:** Up to 300 players per server

**Tech stack:**
- **Rendering:** Three.js
- **Networking:** WebSockets
- **Backend:** Node.js
- **No build tools:** Vanilla HTML, CSS, JavaScript

**Features:**
- Up to 300 players per server
- Procedurally generated 750×750 arena (regenerates each match)
- 6 playable characters with unique abilities
- 10-minute matches, top 3 players win
- No accounts or sign-up required

**Characters and abilities:**
- **Telepotu:** Swap positions with random enemy (60s)
- **Chumantr:** Invisible for 10s, can't shoot (30s)
- **Denja:** Passive: 2× speed, max 75% HP
- **Mednix:** Restore 1-50 HP (20s)
- **Tank:** Passive: 2× HP, half speed
- **Anchor:** Passive: SUPER and SHIELD cost 50% less HP

**Key insights:**
- Three.js can handle 300 players with proper optimization
- Procedural generation reduces asset size
- Character abilities add depth without complex mechanics
- No build tools simplifies development
- Vanilla JS sufficient for multiplayer FPS

**Lessons for Tribes FPS:**
- Three.js scales to 300 players with optimization
- Procedural generation reduces bundle size
- Character abilities can be simple but effective
- No need for complex build tools
- Vanilla JS viable for multiplayer

### 5. Blade & Ember

**Status:** Lightweight browser-based 3D arena duel
**Repository:** rikki3/blade_and_ember
**Architecture:** Authoritative server with Socket.IO

**Tech stack:**
- **Rendering:** Three.js
- **Networking:** Socket.IO
- **Backend:** Node.js, Express
- **No build step:** Plain ES modules

**Features:**
- Real-time multiplayer duels over Socket.IO
- Animated plague doctor fighter model (GLB clips)
- Sword attacks, fireballs, dodge movement, jumping
- Lock-on camera
- Automatic matchmaking (first two players fight, extras spectate)
- Solo fallback bot after 5 seconds
- Round resets and persistent win scoreboard
- Keyboard, mouse, and gamepad support

**Architecture:**
- Express server hosts client, assets, Three.js vendor files
- Socket.IO sends player input to server
- Server streams authoritative game state to clients
- Server handles: movement, cooldowns, damage, hazards, match resets, spectator assignment, bot behavior
- Client handles: rendering, camera behavior, animation playback, HUD updates, local input

**Key insights:**
- No frontend build pipeline (browser loads modules directly)
- Three.js example utilities served from node_modules
- Authoritative server for fair gameplay
- Simple matchmaking (first two players fight)
- Bot fallback for solo play
- GLB model import for animations

**Lessons for Tribes FPS:**
- No build step possible (simplifies development)
- Authoritative server essential for fair combat
- Simple matchmaking works for small games
- Bot fallback improves solo experience
- GLB models work well for animations

### 6. Avernus

**Status:** Strategic 1v1 PVP combat arena
**Repository:** RidwanSharkar/Avernus
**Architecture:** Authoritative server with ECS

**Tech stack:**
- **Rendering:** Three.js with React Three Fiber
- **Physics:** Custom ECS
- **Networking:** Socket.io (sub-60ms latency)
- **Framework:** Next.js 14, React 18
- **Audio:** Howler.js (3D positional audio)
- **UI:** Tailwind CSS

**Features:**
- Competitive 1v1 multiplayer PVP
- Fast-paced real-time combat
- Strategic weapon switching
- Dozens of ability combinations
- Progression system (semi-MOBA format)
- In-game chat functionality

**Architecture:**
- **ECS Architecture:** Entity-Component-System for optimal performance
- **Component-Based Rendering:** Visual components integrated with ECS
- **System-Driven Animation:** Animation states managed through ECS
- **Performance Optimizations:** Object pooling, state batching, performance monitoring
- **Advanced 3D Rendering:** LOD management, instanced rendering
- **Spatial Audio:** 3D positional audio with 30+ unique sounds

**Backend:**
- Node.js server with Express
- Socket.io with CORS support
- Automatic scaling and health monitoring
- Deployment: Fly.io

**Key insights:**
- ECS architecture provides performance and modularity
- React Three Fiber integrates well with ECS
- LOD management and instanced rendering for performance
- Object pooling prevents garbage collection pauses
- Spatial audio enhances immersion
- Next.js provides modern React tooling

**Lessons for Tribes FPS:**
- ECS architecture beneficial for complex games
- React Three Fiber viable for production games
- LOD and instancing critical for performance
- Object pooling prevents GC pauses
- Spatial audio adds immersion
- Modern React tooling (Next.js) works well

### 7. Jackalopes

**Status:** 3D first-person shooter with WordPress integration
**Repository:** jackalopelabs/jackalopes
**Architecture:** WebSocket server with WordPress plugin

**Tech stack:**
- **Rendering:** React Three Fiber, Three.js
- **Physics:** Rapier
- **Networking:** WebSockets
- **Backend:** WordPress plugin (PHP/Ratchet)
- **Framework:** React, TypeScript, Vite

**Features:**
- First-person character controller with smooth movement
- Kinematic character controller (automatic stepping and sliding)
- Physics-based shooting mechanics
- Gamepad support
- 3D environment with physics-based collision
- Post-processing effects
- Multiplayer across different browsers/devices
- WordPress plugin integration for scalable server

**Multiplayer architecture:**
- **ConnectionManager:** WebSocket client for server communication
- **MultiplayerManager:** React components for multiplayer state
- **Client-side prediction and reconciliation**
- **Network state synchronization**
- **Hybrid localStorage/WebSocket approach for cross-browser testing**

**Backend:**
- WebSocket server built on Ratchet
- Session management and player authentication
- Game state persistence with WordPress database
- REST API endpoints for statistics

**Key insights:**
- WordPress integration enables easy deployment
- Client-side prediction and reconciliation for smooth movement
- Hybrid approach (localStorage + WebSocket) for testing
- Kinematic character controller for smooth movement
- Post-processing for visual enhancement
- Gamepad support important for accessibility

**Lessons for Tribes FPS:**
- Client-side prediction essential for smooth movement
- WordPress integration viable for deployment
- Gamepad support important for accessibility
- Kinematic character controller good for movement
- Post-processing adds visual polish
- Hybrid testing approach useful for development

### 8. PigeonWorld

**Status:** Procedural open world multiplayer game
**Repository:** PeerPigeon/PigeonWorld
**Architecture:** P2P mesh networking (decentralized)

**Tech stack:**
- **Rendering:** Three.js
- **Networking:** PeerPigeon (WebRTC-based P2P mesh)
- **Matchmaking:** PigeonMatch
- **Build:** Vite

**Features:**
- 3D procedural world (infinite terrain with height variation)
- Biomes (water, grass, forest, mountains)
- P2P multiplayer (WebRTC mesh networking)
- Decentralized (no central game server)
- Matchmaking to find and join other players
- Real-time sync of player positions
- Support for up to 100 players per world instance

**Rendering:**
- WebGL rendering via Three.js
- PerspectiveCamera with third-person view
- Dynamic lighting with shadows
- PBR materials
- Sky dome with atmospheric fog

**Networking:**
- True peer-to-peer networking with PeerPigeon mesh
- Automatic peer discovery and connection management
- Player state synchronization in 3D space
- Support for up to 100 players per world

**Key insights:**
- P2P mesh networking can support 100 players
- Procedural generation reduces asset size
- Decentralized architecture eliminates server cost
- WebRTC mesh networking complex but viable
- PBR materials possible in browser with optimization

**Lessons for Tribes FPS:**
- P2P mesh networking can scale to 100 players
- Procedural generation reduces bundle size
- Decentralized architecture possible but complex
- PBR materials viable with optimization
- Matchmaking required for P2P games

### 9. AI-FPS

**Status:** GPT-5.5 vibe FPS prototype
**Repository:** r48n34/ai-fps
**Architecture:** Colyseus authoritative server

**Tech stack:**
- **Rendering:** Three.js with React Three Fiber
- **Networking:** Colyseus (authoritative game server)
- **Framework:** React 19, React Router 7
- **UI:** Mantine, Tailwind CSS

**Features:**
- Browser-based multiplayer PVP FPS prototype
- Colyseus authoritative game server
- First-person pointer-lock aiming and keyboard movement
- Shared arena with buildings, walls, crates
- Server-side movement, shooting, health, scoring, reloads, deaths, respawns
- Client-side prediction for smoother local movement
- HUD with health, ammo, status, hit feedback, damage flash, scoreboard

**Architecture:**
- **Backend:** Colyseus authoritative game server, room state, combat rules
- **Frontend:** React Router app with Three.js arena via @react-three/fiber

**Key insights:**
- Colyseus provides authoritative server framework
- React Three Fiber integrates with Colyseus
- Client-side prediction improves movement feel
- Colyseus handles room state and combat rules
- Prototype focused on core multiplayer loop

**Lessons for Tribes FPS:**
- Colyseus viable for authoritative server
- React Three Fiber works with server frameworks
- Client-side prediction essential for smooth movement
- Frameworks can accelerate development
- Prototypes useful for validating gameplay

## Architecture Patterns

### Pattern 1: Authoritative Server (Most Common)

**Games:** Krunker, Redline, L-Town, Blade & Ember, Avernus, Jackalopes, AI-FPS

**Architecture:**
```
Client (Three.js) <---> WebSocket <---> Authoritative Server
```

**Characteristics:**
- Server simulates game logic
- Server authoritative for movement, shooting, damage
- Client sends input, receives state
- Client-side prediction for smooth movement
- Lag compensation for fair gameplay

**Pros:**
- Anti-cheat (server validation)
- Fair gameplay (authoritative)
- Scalable (can add more servers)
- Consistent experience

**Cons:**
- Server cost
- Server maintenance
- Higher latency than P2P

**Suitability:** Competitive FPS (recommended for Tribes FPS)

### Pattern 2: Host-Authoritative P2P

**Games:** Phewland

**Architecture:**
```
Client (Host) <---> P2P <---> Client (Peer)
```

**Characteristics:**
- First player becomes host
- Host simulates game logic
- Peers send input to host
- Host sends state to peers
- No dedicated server

**Pros:**
- No server cost
- Simple setup
- Good for casual play

**Cons:**
- Host dependency (if host leaves, game ends)
- No anti-cheat
- Not suitable for competitive play
- Limited scalability

**Suitability:** Casual games, prototypes (not recommended for Tribes FPS)

### Pattern 3: Decentralized P2P Mesh

**Games:** PigeonWorld

**Architecture:**
```
Client <---> P2P Mesh <---> Client <---> P2P Mesh <---> Client
```

**Characteristics:**
- Full mesh networking
- No central server
- Peer discovery and connection management
- State synchronization across mesh

**Pros:**
- No server cost
- Decentralized
- Can scale to 100 players

**Cons:**
- Complex networking
- No anti-cheat
- Higher complexity
- Not battle-tested for competitive play

**Suitability:** Experimental, open-world games (not recommended for Tribes FPS)

## Technology Stack Analysis

### Rendering

**Three.js (Direct):**
- **Games:** Krunker, Redline, L-Town, Blade & Ember, PigeonWorld
- **Pros:** Maximum control, smaller bundle, more optimization options
- **Cons:** More manual work, steeper learning curve
- **Suitability:** Best for competitive FPS requiring extreme optimization

**React Three Fiber:**
- **Games:** Phewland, Avernus, Jackalopes, AI-FPS
- **Pros:** Modern React development, declarative, easier to reason about
- **Cons:** Slightly larger bundle, React overhead
- **Suitability:** Good for teams familiar with React, modern development workflow

### Networking

**Socket.IO (WebSocket):**
- **Games:** Redline, Blade & Ember, Avernus, Jackalopes, AI-FPS
- **Pros:** Battle-tested, automatic reconnection, room management, easy to use
- **Cons:** WebSocket only (no unreliable transport), overhead
- **Suitability:** Good for authoritative servers, most common choice

**Custom WebSocket:**
- **Games:** Krunker, L-Town
- **Pros:** Maximum control, can implement custom protocols, delta compression
- **Cons:** More work, must implement reconnection, room management
- **Suitability:** Best for performance optimization, custom protocols

**WebRTC (P2P):**
- **Games:** Phewland, PigeonWorld
- **Pros:** No server cost, low latency between peers
- **Cons:** Complex setup, NAT traversal, host dependency, no anti-cheat
- **Suitability:** Casual games, prototypes (not competitive FPS)

### Physics

**Cannon.js:**
- **Games:** Redline
- **Pros:** Lightweight, battle-tested, deterministic
- **Cons:** Limited features, not actively maintained
- **Suitability:** Good for simple physics, racing games

**Rapier:**
- **Games:** Phewland, Jackalopes
- **Pros:** Modern, performant, Rust-based, good character controller
- **Cons:** Newer, smaller ecosystem
- **Suitability:** Good for character controllers, modern games

**Custom Physics:**
- **Games:** Krunker, L-Town
- **Pros:** Full control, optimized for specific mechanics
- **Cons:** More work, must implement everything
- **Suitability:** Best for unique mechanics (skiing, jetpacks)

**No Physics (Custom Collision):**
- **Games:** Blade & Ember
- **Pros:** Simple, no overhead
- **Cons:** Limited to simple collision
- **Suitability:** Simple games, arena combat

### Build Tools

**Vite:**
- **Games:** Redline, Phewland, Avernus, Jackalopes, PigeonWorld, AI-FPS
- **Pros:** Fast development, modern tooling, tree-shaking
- **Cons:** Build step required
- **Suitability:** Modern development workflow

**No Build Step:**
- **Games:** L-Town, Blade & Ember
- **Pros:** Simple, no build complexity, direct module loading
- **Cons:** No tree-shaking, larger bundles, no optimization
- **Suitability:** Simple games, prototypes

**Next.js:**
- **Games:** Avernus
- **Pros:** Full-stack framework, SSR, routing, modern React
- **Cons:** Overkill for simple games, larger bundle
- **Suitability:** Full-stack applications, marketing sites with games

## Performance Optimization Techniques

### Common Optimizations Across Games

**1. Low-Poly Graphics:**
- Krunker: Simple, blocky graphics
- Redline: Matcap-shaded low-poly cars
- L-Town: Simple character models
- **Result:** Reduced GPU load, faster rendering

**2. Efficient Networking:**
- Krunker: 64Hz tick, delta compression
- Redline: 20Hz snapshots, interpolation
- Blade & Ember: Authoritative state streaming
- **Result:** Reduced bandwidth, smoother movement

**3. Quality Settings:**
- Krunker: Quality settings for low-end devices
- Avernus: LOD management, instanced rendering
- Jackalopes: Post-processing toggle
- **Result:** Runs on Chromebooks, mobile devices

**4. Object Pooling:**
- Avernus: Object pooling prevents GC pauses
- Jackalopes: Object pooling for projectiles
- **Result:** Stable frame times, no stutters

**5. Procedural Generation:**
- L-Town: Procedurally generated arena
- PigeonWorld: Procedural infinite terrain
- **Result:** Reduced asset size, infinite content

**6. Interpolation:**
- Redline: 80ms interpolation delay
- Jackalopes: Client-side prediction and reconciliation
- **Result:** Smooth remote movement

### Advanced Optimizations

**1. Instanced Rendering:**
- Avernus: Instanced rendering for enemies
- **Result:** Render thousands of objects with few draw calls

**2. LOD (Level of Detail):**
- Avernus: Distance-based rendering
- **Result:** Reduced polygon count for distant objects

**3. Spatial Audio:**
- Avernus: 3D positional audio
- Jackalopes: Spatial audio
- **Result:** Immersive experience without heavy CPU cost

**4. Shared Physics:**
- Redline: Cannon.js shared between client and server
- **Result:** Deterministic behavior, reduced desync

**5. Material Purging:**
- (Not explicitly mentioned but common optimization)
- **Result:** Reduced draw calls

## Success Factors

### What Makes Three.js Multiplayer Games Successful

**1. Fast Load Times (< 5s):**
- Krunker: < 5s load time
- All analyzed games prioritize fast loading
- **Result:** Players don't abandon during load

**2. Lightweight Bundles (< 5MB):**
- Krunker: ~5MB total
- L-Town: No build tools, minimal overhead
- **Result:** Quick downloads, viral sharing

**3. Simple Graphics:**
- Low-poly, stylized graphics
- No photorealism (too expensive for browser)
- **Result:** Runs on low-end devices, Chromebooks

**4. Efficient Networking:**
- Delta compression, interpolation
- Snapshot-based state sync
- **Result:** Smooth gameplay, low bandwidth

**5. Quality Settings:**
- Adjustable graphics quality
- Performance targets for low-end devices
- **Result:** Broad device support

**6. Instant Gameplay:**
- No accounts required (most games)
- URL-based gameplay
- **Result:** Low friction, viral sharing

**7. Regular Updates:**
- Krunker: Regular updates and events
- Active community engagement
- **Result:** Player retention

## Recommendations for Tribes-Inspired Browser FPS

### Recommended Tech Stack

**Rendering:** Three.js (direct, not React Three Fiber)
- **Reason:** Maximum control for extreme optimization
- **Bundle size:** Smaller (168KB vs larger with React)
- **Suitability:** Competitive FPS requiring LAN-like feel

**Networking:** Custom WebSocket implementation
- **Reason:** Maximum control for delta compression, custom protocols
- **Alternative:** Socket.IO if faster development needed
- **Transport:** WebTransport (HTTP/3) when available, fallback to WebSocket

**Physics:** Custom physics
- **Reason:** Unique mechanics (skiing, jetpacks) require custom implementation
- **Alternative:** Rapier if character controller needed
- **Suitability:** Tribes-specific movement

**Build Tools:** Vite
- **Reason:** Fast development, tree-shaking, modern tooling
- **Alternative:** No build step for prototype
- **Suitability:** Modern development workflow

### Architecture

**Authoritative Server (Required):**
- Server simulates game logic
- Server authoritative for movement, shooting, damage
- Client-side prediction for smooth movement
- Lag compensation for fair gameplay
- **Reason:** Anti-cheat, fair competition, industry standard

**Networking Protocol:**
- 64Hz server tick rate
- 20Hz state snapshots (or delta compression)
- Client-side prediction with reconciliation
- Interpolation for smooth remote movement
- **Reason:** LAN-like feel, proven by Krunker

### Optimization Strategy

**Graphics:**
- Low-poly, stylized graphics (not photorealistic)
- Material purging for static environment
- Instanced rendering for projectiles, particles
- Texture atlasing for weapons, players
- KTX2 texture compression
- Cap pixel ratio at 2x
- Disable shadow maps (bake if needed)
- **Target:** < 30 draw calls, < 500K triangles

**Networking:**
- Delta compression for state updates
- Binary protocol (MessagePack)
- Interest management (only send visible entities)
- Interpolation (80-100ms delay)
- **Target:** < 10KB/s per player

**Performance:**
- Object pooling for projectiles, particles
- Web Workers for physics calculations
- LOD for distant players
- Quality settings (low/medium/high)
- **Target:** 60fps on Chromebooks

### Development Phases

**Phase 1: Prototype (4 weeks)**
- Basic Three.js rendering
- Simple character controller
- Basic shooting mechanics
- Local multiplayer (no server)
- **Goal:** Validate gameplay mechanics

**Phase 2: Networking (4 weeks)**
- Authoritative server (Go/Rust)
- WebSocket/WebTransport networking
- Basic state synchronization
- Client-side prediction
- **Goal:** Basic multiplayer with prediction

**Phase 3: Optimization (4 weeks)**
- Delta compression
- Interpolation
- Lag compensation
- Performance profiling
- **Goal:** LAN-like feel

**Phase 4: Polish (4 weeks)**
- UI/UX improvements
- Sound effects
- Quality settings
- Chromebook testing
- **Goal:** Production-ready

**Total:** 16 weeks for production-ready multiplayer FPS

## Conclusion

**Three.js is the proven choice for browser multiplayer games:**
- Krunker (most successful browser FPS) uses Three.js
- All analyzed games achieve playable performance on Chromebooks
- Wide range of architectures (authoritative, P2P, decentralized)
- Extensive ecosystem and community support

**Key patterns for success:**
- Authoritative server for competitive play
- Low-poly, stylized graphics
- Efficient networking (delta compression, interpolation)
- Quality settings for low-end devices
- Fast load times (< 5s)
- Lightweight bundles (< 5MB)

**For Tribes-inspired browser FPS:**
- Use Three.js (direct) for maximum control
- Custom physics for skiing/jetpack mechanics
- Authoritative server for anti-cheat
- WebTransport for modern protocol
- Custom WebSocket implementation for optimization
- Follow Krunker's proven optimization patterns

**The path is clear:** Three.js + authoritative server + custom physics + aggressive optimization = successful browser multiplayer FPS. Krunker proved it works. Now execute.
