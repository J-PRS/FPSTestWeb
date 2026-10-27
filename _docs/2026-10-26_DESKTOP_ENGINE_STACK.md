# Desktop engine stack — reference

> If KRIBES ever goes "purely desktop, tightest reasonable package": the
> verdict from the 2026-10-26 session. Reference, not a plan — the game
> ships on the web; this maps what a native port would look like and what
> already transfers.

## Verdict in one line

**Thin custom shell + library floor.** A full engine (Unreal/Unity/Godot)
buys features this game doesn't use and fights the one thing that matters
(Tribes movement feel). The codebase is already ~80% of that engine —
the port is mostly rendering + net transport, not game code.

## What already IS custom (transfers 1:1)

- **`shared/movement.ts` `MoveSim`** — hand-rolled kinematic controller,
  no physics engine. Contact is an analytic query (`MoveSurface.getHeight(x,z)`
  over the heightfield + structure hulls + body capsules), not a narrowphase.
  Skiing = friction toggle + taller ground snap (`skiTargetDistance`), jets =
  force/mass impulses with a forward-accel ceiling (`jetMaxFwdAccel`, the
  Unity RB_Controller rule), Quake-style `groundAccelerate`/`airControl`,
  T2 sputter lockout. Dependency-free math — ports verbatim to Rust/C++.
- **Deterministic shared sims** (`shared/` ball/movement/projectile sims,
  fixed-step, no wall-clock) — the hard part of any port is usually the
  netcode model; the right one (server-authoritative, event edges, replay
  both ends) is already built.
- **Netcode architecture** — events-over-streams, distance-tiered sends,
  QoS lanes. Transport-independent; survives a WS→ENet/QUIC swap.
- **Render strategy** — instanced species/balls/props, one shared geometry
  per kind, heightfield terrain, pooled VFX. Ports 1:1 to any instancing
  API.
- **Content** — glTF assets, heightmap bins, map spec JSONs. All
  engine-neutral formats.

## Renderer: "what draws frames pretty and fast"

The game's visual bar needs ~5 features: sun shadowmap, hemisphere/ambient,
instanced draws, HDR+bloom+tonemap, good AA. All shading work, none needs
an engine.

| Option | Lang | Size | Trade |
|---|---|---|---|
| **bgfx** | C++ | small | Boring-correct. Shipped-game-proven, one API over DX11/12/VK/Metal/GL, own shader dialect (shaderc). The pragmatic C++ pick. |
| **wgpu** | Rust | small | WebGPU native, Vulkan/Metal/DX12 done right, spec-tracked. The default if the port is Rust; occasionally unimplemented edges. |
| **sokol_gfx + sokol-shdc** | C | smallest | ~1k-line headers, zero abstraction weight. Tightest possible; you own the multi-backend shader plumbing. |
| Three.js | TS | — | Status quo: already this layer. A port gains native perf + netcode + binary size, NOT prettier pixels — pretty was always shaders + art direction. |

## Physics floor (the honest scope correction)

The controller is ~200 lines of feel; what Unity gave for free underneath
was PhysX narrowphase. Heightfield skiing stays analytic/cheap
(`getHeight` + push-out, already exists), but capsule-vs-arbitrary-mesh at
ski speed wants a real physics lib:

- **Jolt** (C++ — Horizon Forbidden West's physics, free, fast, character
  controller included you don't have to use)
- **Rapier** (Rust, deterministic, parallels well)

Stock *controllers* are a trap; stock *physics* isn't. Keep the 200-line
Tribes layer on top of Jolt/Rapier, not on PhysX-in-an-engine.

## Net transport

- **ENet** — the standard reliable-UDP lane for games (channels, sequenced
  + unreliable + reliable in one). Matches the existing WS/WT tier design.
- **yojimbo** — more structure (netcode.io lineage), C++.
- **quinn** — QUIC for Rust, if encryption/0-RTT matters.

Server stays server-authoritative; the wire model doesn't change.

## The honest "still reasonable" boundary

Thin custom wins on binary (~10-30MB), cold start (<1s), frame budget
ownership, and no fighting a stock controller. It loses the moment the
project needs:

- a level editor / real content pipeline (glTF→wgpu is plumbing weekends)
- platform ports beyond desktop (console = engine territory)
- more than ~1-2 devs who didn't write the engine

If any of those are on the roadmap, the answer flips to **Unreal** (only
option with production-grade replication + proven Tribes-likes like
Midair; still write the ski sim yourself — CMC fights Tribes physics).

Godot 4 sits between but its 32-player replication story is the least
proven. Bevy: tempting, multiplayer immature.

## Stack sketch

```
sim (shared/ → Rust/C++ port)      ← the port's actual core
renderer: wgpu | bgfx | sokol      ← pick by language
physics floor: Jolt | Rapier       ← capsule-vs-mesh only
net: ENet | quinn                  ← reliable+unreliable lanes
assets: glTF + heightmap.bin       ← unchanged formats
audio: miniaudio | kira            ← trivial layer
```

~20MB binary, sub-second cold start, and every ms of frame budget is
yours — same philosophy the codebase already runs: cheap is a feature.
