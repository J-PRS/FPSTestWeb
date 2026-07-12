# Narrow One - Technical Analysis

## Overview

Narrow One is a browser-based multiplayer FPS (5v5 capture-the-flag with medieval archery combat) developed by Pelican Party Studios (Jesper van den Ende and Jurgen Hoogeboom). Launched in 2021, it has achieved significant success with over 50 million gameplays.

## Technology Stack

### Engine: Renda
- **Renda** - Custom open-source WebGL/WebGPU engine (https://github.com/rendajs/renda)
- **WebGPU support** - Modern rendering capabilities
- **Zero dependencies** - Lightweight, minimal overhead
- **Bundle size scales with usage** - Only includes code you actually use
- **Renda Studio** - Online browser-based editor (https://renda.studio)

### Renda Engine Features

**Performance Optimizations**:
- **Engine defines** - Conditional compilation to remove unused features
  - Example: `ENABLE_WEBGPU_CLUSTERED_LIGHTS` can be disabled for unlit games
  - Bundlers completely remove code when defines are false
  - Tree shaking removes unused imports automatically
- **Flexible API for prototyping** - Multiple ways to perform operations (e.g., vector multiplication)
  - `Vec3.multiply(vectorA, vectorB)` - creates new instance
  - `vectorA.multiply(b)` - applies to self
  - `vectorA.multiply(1,2,3)` - multiply with new Vec3
  - Performance-focused alternatives available (e.g., `multiplyVector()`)

**Design Philosophy**:
- **Tight feedback loops** - Changes applied immediately, no save buttons
- **Live editing** - Change entity position while app runs, changes persist
- **Minimal concepts** - Reuse existing patterns (everything is asset/window/treeview/task)
- **Small project files** - Only store modified variables, reset removes entries
- **Low-level foundation** - Built from low-level concepts, high-level abstractions on top

**Asset System**:
- **Embedded assets** - Combine material, pipeline config, and shaders into single asset
- **Material maps** - Map properties across different renderers/plugins
- **Everything is an asset** - Consistent loading in editor and built applications

### Why Renda Over Three.js?
- **Purpose-built for web** - Optimized specifically for browser performance
- **WebGPU native** - Future-proof rendering pipeline
- **Editor integration** - Renda Studio provides Unity-like workflow in browser
- **Smaller bundles** - Engine defines remove unused code more aggressively than tree shaking
- **Zero dependencies** - No external library overhead

### Development Workflow
- **Renda Studio** - Browser-based editor for scene building
- **Code-based option** - Can use as library via npm, CDN, or Deno
- **Blender** - Still used for some modeling (likely character models)
- **Live updates** - Changes visible immediately across devices

## Server Infrastructure

### Hosting
- **DigitalOcean** servers
- **Cost**: $4/month per server (cheapest tier)
- **Capacity**: ~200 players per server

### Auto-Scaling System
- **Boot new server** when existing server reaches 200 players
- **Shut down server** when player count drops below 100
- **Monitoring app** tracks player counts and manages server lifecycle
- **Example**: 9 servers online for 1,023 players

### Server Dashboard
- Real-time overview of all active servers
- Per-game stats: player count, map, score, game duration
- Player Elo ratings displayed
- Geographic location tracking

## Networking & Matchmaking

### Custom Backend
- Custom networking backend (not off-the-shelf solution)
- Built for real-time multiplayer 3D in browser

### Elo Rating System
- Chess-style skill ranking
- New players start at 0
- Winning team gains points, losing team loses points
- Negative rating = below average skill
- Positive rating = above average skill

### Matchmaking Algorithm

**Scoring System**:
Each game receives points based on multiple factors:
- **Server location**: 20 points for nearby servers
- **Elo rating**: 50 points for similar skill
- **Map preference**: Avoid same map twice in a row
- **Player count**: Prioritize empty games, avoid full games
- **Game progress**: Don't join games near completion

**Pre-Join Groups**:
- Collect players after game ends
- Group by region and Elo rating
- Join games as groups instead of individually
- Improves matchmaking quality

**Optimization Challenge**:
- Comparing every player with every other is too slow
- Solution: Random initial grouping, then iterative improvement
- "Trading" system swaps players between groups to improve fit

## Game Design Philosophy

### Core Principles
- **Not cash grabs** - Games they would play themselves
- **Quality over speed** - Don't release unfinished games
- **Original IP** - No meme games or series-based content
- **Genuine enjoyment** - Passion for the craft shows in the product

### Technical Foundation
- Emphasis on fast loading (small file sizes)
- Low engine overhead
- Optimized for browser performance
- Runs well on Chromebooks

## Arrow/Projectile Mechanics

### Arrow Physics
- **Projectile-based combat** - Not hitscan like traditional FPS
- **Travel time** - Arrows have realistic flight time
- **Arrow drop** - Gravity affects trajectory, must aim higher for long-range
- **Lead targets** - Must aim ahead of moving enemies
- **Charge timing** - Bow draw time affects arrow speed/power

### Technical Implications
- **Client-side prediction** likely used for arrow firing (instant visual feedback)
- **Server validation** for actual hits (prevent cheating)
- **Projectile networking** - Arrows likely networked as position/velocity updates
- **Lag compensation** - Server may rewind to validate arrow hits from shooter's perspective
- **No instant hit** - Different rhythm than gun FPS, rewards prediction over twitch reflexes

### Possible Networking Approach
Based on industry best practices for projectiles:
1. **Client fires immediately** - Show arrow instantly
2. **Send fire command to server** - Include position, direction, timestamp
3. **Server spawns projectile** - May accelerate to catch up to client's projectile
4. **Spectators see delayed projectile** - Spawn when server confirms
5. **Collision on server** - Authoritative hit detection
6. **Bandwidth savings** - Don't network projectile movement each tick

## Rendering & Performance

### WebGL/WebGPU Pipeline
- **Custom engine** - Renda optimized for web performance
- **Low-poly aesthetic** - Stylized medieval style reduces polygon count
- **60 FPS on Chromebooks** - Optimized for low-end devices
- **Fast loading** - Small file sizes, minimal engine overhead

### Optimization Techniques (Inferred from Renda)
- **Engine defines** - Remove unused rendering features (e.g., clustered lights for unlit games)
- **Conditional compilation** - Bundle only what's used
- **Zero dependencies** - No external library bloat
- **Efficient asset system** - Embedded assets reduce file count
- **Material maps** - Reuse materials across renderers

## Key Learnings for Your Project

### Engine Choice
- **Custom engine (Renda)** provides better optimization than off-the-shelf solutions
- **Engine defines** allow aggressive code removal beyond tree shaking
- **WebGPU native** future-proofs rendering pipeline
- **Zero dependencies** reduces bundle size significantly
- **Browser-based editor** (Renda Studio) provides Unity-like workflow without installation

### Server Architecture
- **Auto-scaling is essential** for variable player loads
- **Cheap servers can work** with proper scaling ($4/month DigitalOcean)
- **Monitoring dashboard** is crucial for operations
- **Capacity planning**: ~200 players per low-end server

### Matchmaking
- **Multi-factor scoring** works better than single metric
- **Elo system** provides good skill-based matching
- **Group joining** improves experience over individual joining
- **Trading algorithm** optimizes groups iteratively (faster than O(n²) comparison)

### Development Workflow
- **Live editing** - Changes visible immediately while app runs
- **Tight feedback loops** - No save buttons, instant updates
- **Small project files** - Only store modified variables
- **Embedded assets** - Combine related assets to reduce file count

### Performance
- **Engine defines** - Remove unused features at compile time
- **Conditional compilation** - More aggressive than tree shaking
- **Zero dependencies** - No external library overhead
- **Low-poly aesthetic** - Reduces polygon count for better performance
- **60 FPS on Chromebooks** - Proven optimization for low-end devices

### Projectile Networking
- **Client-side prediction** for instant visual feedback
- **Server validation** for authoritative hit detection
- **Projectile acceleration** on server to catch up to client
- **Bandwidth savings** - Don't network projectile movement each tick
- **Lag compensation** - Server rewinds to shooter's perspective

## Comparison with Your Project

### Similarities
- Browser-based FPS
- Three.js rendering (client_three)
- Custom server implementation (three_server)
- Focus on responsive gameplay

### Differences
- Narrow One: Medieval archery (projectile-based)
- Your project: Likely hitscan weapons
- Narrow One: 5v5 CTF
- Your project: Unknown game mode

### Applicable Techniques
- Auto-scaling server architecture
- Multi-factor matchmaking scoring
- Elo rating for skill matching
- Pre-join grouping system
- Three.js for rendering

## References

- [Narrow One Developer Story - Poki](https://poki.com/blog/pelican-party-creators-of-narrow-one)
- [Narrow One Trade Secrets - Itch.io](https://pelicanparty.itch.io/narrow-one/devlog/536795/spilling-our-trade-secrets-narrow-one-updates-)
- [Narrow One History](https://narrow-one.io/narrow-one-history/)
- [WebGPU Showcase](https://www.webgpu.com/showcase/narrow-one-multiplayer-archery-webgl/)
