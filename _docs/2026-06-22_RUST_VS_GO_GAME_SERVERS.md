# Rust vs Go for Multiplayer Game Servers at Scale

## Overview

This document compares Rust and Go for multiplayer game server development, analyzes what large-scale multiplayer games use, and provides recommendations based on industry research.

## Rust vs Go Performance Comparison (2026)

### Benchmarks

**CPU-Bound Workloads**:
- **Rust**: 2x faster than Go for JSON parsing, binary tree traversal, matrix operations
- **Fibonacci benchmark**: Rust 22ms vs Go 39ms (77% speed advantage for Rust)
- **Throughput**: Rust 160,000 requests/sec vs Go lower on 2 CPU cores
- **Memory**: Rust 20% lower memory consumption than Go

**I/O-Bound Workloads**:
- **Go**: Highly optimized goroutine scheduler for thousands of concurrent connections
- **Rust**: Async/await with tokio, but Go's goroutines are more mature for I/O
- **Web APIs**: Go performance adequate for database queries, HTTP proxying, message queues
- **Network bottleneck**: When bottleneck is network/disk I/O, Rust vs Go difference shrinks

**Latency**:
- **2026 benchmarks**: Rust delivers 40% lower latency than Go in backend rewrites
- **Tail latency**: Rust better for tail latency at scale
- **Frame time**: Critical for game servers (Valorant target: 2.34ms per frame)

### Memory Management

**Rust**:
- **Ownership model**: No garbage collection, compile-time memory safety
- **Zero-cost abstractions**: No runtime overhead
- **Memory efficiency**: ~2KB per goroutine-equivalent (much lower than Go's ~100KB per connection)
- **Predictable**: No GC pauses (critical for real-time games)

**Go**:
- **Garbage collection**: Automatic, but GC pauses can cause latency spikes
- **Goroutines**: Lightweight (~2KB stack), but GC overhead exists
- **Memory per connection**: Higher than Rust due to GC overhead
- **Trade-off**: Easier development vs occasional GC pauses

### Concurrency Models

**Rust**:
- **Async/await**: tokio async runtime (mature, but complex)
- **Async closures**: Stabilized in Rust 1.83 (major ergonomic improvement)
- **Ownership**: Prevents data races at compile time
- **Learning curve**: Steep (borrow checker, lifetimes)

**Go**:
- **Goroutines**: Extremely lightweight, easy to use
- **Channels**: Built-in communication between goroutines
- **Scheduler**: Highly optimized for concurrent I/O
- **Learning curve**: Low (simple concurrency model)

### Ecosystem

**Rust**:
- **Game frameworks**: ggez, bevy (growing but less mature)
- **Networking**: tokio, tokio-tungstenite (WebSockets)
- **Serialization**: serde (excellent, fast)
- **Maturity**: Growing rapidly, but less mature than Go

**Go**:
- **Game frameworks**: Ebiten (2D), less for 3D
- **Networking**: gorilla/websocket (mature, widely used)
- **Serialization**: encoding/json (adequate)
- **Maturity**: Very mature, especially for web services

### Developer Experience

**Rust**:
- **Compilation**: Slower (compile-time checks)
- **Development**: Harder (borrow checker, lifetimes)
- **Debugging**: Harder (compiled, no hot reload)
- **Salary**: $178,000 average (12% YoY growth)

**Go**:
- **Compilation**: Faster (simpler compiler)
- **Development**: Easier (simple syntax, GC)
- **Debugging**: Easier (dynamic, hot reload possible)
- **Salary**: $165,000 average (8% YoY growth)

## Large-Scale Multiplayer Game Server Technologies

### What Major Games Use

**Roblox**:
- **Engine**: C++ (custom engine)
- **Scripts**: Lua (game logic)
- **Infrastructure**: 24 edge data centers, custom global network
- **Scale**: Millions of concurrent players, 4 billion join combinations/second
- **Architecture**: Hybrid cloud (physical + virtual edge data centers)
- **Key insight**: C++ for performance-critical engine, Lua for game logic

**Valorant**:
- **Engine**: Unreal Engine (C++)
- **Tick rate**: 128-tick servers (2.34ms frame budget)
- **Optimization**: Heavy engine modifications for performance
- **Architecture**: Riot Direct (custom ISP), global edge network
- **Scale**: Competitive shooter, low latency critical
- **Key insight**: C++ with Unreal Engine, heavily optimized for 128-tick

**New World (Amazon Games)**:
- **Engine**: Custom (C++)
- **Infrastructure**: AWS EC2, custom "hub" architecture
- **Tick rate**: 30 updates/second (vs 5 for traditional MMO)
- **Architecture**: Session-based modes, AWS Lambda for microservices
- **Scale**: Seamless MMO, massive world
- **Key insight**: Custom C++ engine, AWS cloud infrastructure

**Palia (Singularity 6)**:
- **Engine**: Unreal Engine (C++)
- **Infrastructure**: AWS EKS (Kubernetes), ScyllaDB
- **Architecture**: Cross-regional, auto-scaling with Karpenter
- **Scale**: Shared world MMO
- **Key insight**: Unreal Engine + Kubernetes for orchestration

### Pattern Analysis

**Large-Scale Games Use C++**:
- **Reason**: Maximum performance, zero GC pauses, direct hardware control
- **Engines**: Unreal Engine, Unity (C#), custom C++ engines
- **Scale**: Millions of concurrent players
- **Latency**: Critical (Valorant 2.34ms frame budget)

**Rust/Go Use Cases**:
- **Supporting infrastructure**: Matchmaking, analytics, caching
- **Web services**: APIs, authentication, databases
- **Not core game servers**: Rarely used for core game logic at scale

**Why C++ Dominates**:
- **Performance**: Unmatched for CPU-intensive tasks
- **Maturity**: Decades of game development tooling
- **Ecosystem**: Unreal Engine, Unity, custom engines
- **Control**: Direct hardware access, no runtime overhead

## Browser FPS Server Technologies

### What Browser FPS Games Use

**Shell Shockers**:
- **Server**: Node.js
- **Scale**: 10,000+ simultaneous players, 300K-350K DAU
- **Revenue**: $1M-$3M/year
- **Key insight**: Node.js sufficient for browser FPS scale

**Krunker.io**:
- **Server**: Node.js/Express
- **Scale**: 200M total players, 50K peak concurrent
- **Revenue**: $200K-$500K/year pre-acquisition
- **Key insight**: Node.js handles massive browser game scale

**War Brokers**:
- **Server**: TypeScript monorepo
- **Scale**: 16-player limit per match
- **Key insight**: TypeScript for code sharing with client

**Other Browser FPS**:
- **open-browser-fps**: Node.js + Socket.IO
- **Defense of the Artifacts**: Node.js + Socket.IO
- **game-sync**: Node.js + Express

### Why Node.js Dominates Browser FPS

**Code Sharing**:
- JavaScript/TypeScript can be shared between client and server
- Reduces development time
- Easier to maintain consistent logic

**WebSocket Ecosystem**:
- Mature WebSocket libraries (ws, Socket.IO)
- Optimized for browser connections
- Well-documented patterns

**Sufficient Performance**:
- Handles 10,000+ concurrent players (Shell Shockers)
- I/O-bound (WebSocket), not CPU-bound
- Browser games have lower tick rates than competitive shooters

**Development Speed**:
- No compilation step
- Hot reload possible
- Easier debugging

**Talent Pool**:
- Easier to find JavaScript/TypeScript developers
- Lower learning curve than Rust/Go

## Rust vs Go for Game Servers

### When Rust is Better

**Use Rust if**:
- **CPU-intensive tasks**: Physics, hit detection, AI
- **Latency-critical**: Competitive shooters, tick rate > 60
- **Memory constraints**: Limited memory per server
- **No GC pauses**: Real-time requirements
- **Team knows Rust**: Learning curve is steep

**Rust Advantages**:
- 40% lower latency than Go (2026 benchmarks)
- 2x faster for CPU-bound workloads
- No garbage collection (predictable performance)
- Memory efficient (2KB vs 100KB per connection)
- Compile-time safety (no data races)

**Rust Drawbacks**:
- Steep learning curve (borrow checker, lifetimes)
- Slower development (compilation, debugging)
- Less mature game ecosystem
- No code sharing with JavaScript client

### When Go is Better

**Use Go if**:
- **I/O-bound tasks**: WebSocket handling, database queries
- **Concurrent connections**: Thousands of connections
- **Development speed**: Faster iteration needed
- **Team knows Go**: Easier than Rust
- **Cloud-native**: Kubernetes, microservices

**Go Advantages**:
- Excellent goroutine scheduler for concurrency
- Simple concurrency model
- Mature ecosystem (CNCF projects)
- Faster development than Rust
- Good enough performance for I/O-bound workloads

**Go Drawbacks**:
- Garbage collection (occasional latency spikes)
- Higher memory usage than Rust
- Slower than Rust for CPU-bound tasks
- 40% higher latency than Rust (2026 benchmarks)

### Hybrid Approach

**Architecture**:
- **Node.js**: WebSocket handling, I/O-bound tasks
- **Go/Rust**: CPU-intensive tasks (physics, hit detection)
- **Communication**: gRPC, shared memory, or message queue

**Benefits**:
- Best of both worlds
- Keep JavaScript/TypeScript for client compatibility
- Offload CPU work to Go/Rust
- Scale independently

**Drawbacks**:
- More complex architecture
- Two languages to maintain
- Network overhead between services

## Recommendations for Your Project

### Current Assessment

**Your Stack**:
- **Client**: TypeScript + Three.js
- **Server**: Node.js + TypeScript
- **Protocol**: WebSocket
- **Scale**: Development phase

**Alignment with Industry**:
- ✅ Node.js is industry standard for browser FPS
- ✅ TypeScript matches client (code sharing)
- ✅ Sufficient for browser game scales (<10K concurrent)
- ✅ Development speed prioritized

### When to Consider Rust

**Switch to Rust if**:
- CPU utilization consistently >80%
- Hit detection/physics is bottleneck
- Need 128-tick servers (competitive shooter)
- Player count >10,000 concurrent per server
- Team knows Rust or willing to learn

**Rust Benefits for Your Project**:
- Lower latency (40% better than Go)
- No GC pauses (predictable performance)
- Memory efficiency (more players per server)
- Compile-time safety (fewer runtime bugs)

**Rust Challenges for Your Project**:
- No code sharing with TypeScript client
- Steep learning curve
- Slower development iteration
- Less mature browser game ecosystem

### When to Consider Go

**Switch to Go if**:
- Need better concurrency than Node.js
- Want simpler language than Rust
- Team knows Go
- I/O-bound workload (WebSocket, database)

**Go Benefits for Your Project**:
- Better concurrency than Node.js
- Simpler than Rust
- Mature ecosystem
- Good enough performance for I/O-bound workloads

**Go Challenges for Your Project**:
- No code sharing with TypeScript client
- GC pauses (latency spikes)
- Slower than Rust for CPU-bound tasks
- Still requires learning new language

### Recommended Path

**Phase 1: Stick with Node.js (Current)**
- Node.js is sufficient for browser FPS scale
- Code sharing with client is valuable
- Development speed is priority
- Industry standard for browser FPS

**Phase 2: Optimize Node.js (<1K players)**
- Profile for bottlenecks
- Optimize WebSocket performance
- Implement spatial partitioning
- Add object pooling

**Phase 3: Consider Go for CPU tasks (1K-10K players)**
- If CPU is bottleneck, offload physics to Go
- Keep Node.js for WebSocket handling
- Communicate via gRPC or message queue
- Hybrid architecture

**Phase 4: Consider Rust for extreme scale (>10K players)**
- If still CPU-bound after Go optimization
- Rust for physics/hit detection
- Keep Node.js for I/O
- Maximum performance

## Conclusion

**Rust is peak efficiency** for CPU-bound game server tasks, delivering 40% lower latency and 2x faster performance than Go. However, **large-scale games (Valorant, Roblox, New World) use C++**, not Rust or Go, for core game servers.

**For browser FPS specifically**, Node.js dominates (Shell Shockers, Krunker, War Brokers) because:
- Code sharing with JavaScript client
- Sufficient performance for browser game scales
- WebSocket ecosystem maturity
- Development speed

**Rust is overkill for most browser FPS games** unless you're building a competitive shooter with 128-tick servers (like Valorant) or hitting 10,000+ concurrent players per server.

**Recommendation**: Stick with Node.js + TypeScript for your browser FPS project. Only consider Rust if you hit performance bottlenecks at 10,000+ concurrent players or need 128-tick servers for competitive play.

## References

- [Rust vs Go 2026 Benchmarks](https://tech-insider.org/rust-vs-go-2026/)
- [Valorant 128-Tick Servers](https://technology.riotgames.com/news/valorants-128-tick-servers)
- [Roblox Infrastructure](https://about.roblox.com/newsroom/2025/06/roblox-infrastructure-supporting-record-breaking-games)
- [New World Architecture](https://aws.amazon.com/blogs/gametech/the-unique-architecture-behind-amazon-games-seamless-mmo-new-world/)
- [Palia on AWS EKS](https://aws.amazon.com/blogs/gametech/how-singularity-6s-palia-conquered-cross-regional-gaming-with-amazon-eks-and-karpenter/)
- [Server Architecture](./SERVER_ARCHITECTURE.md)
- [Browser FPS Genre Overview](./BROWSER_FPS_GENRE_OVERVIEW.md)
