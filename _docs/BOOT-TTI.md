# Boot Time / Time-to-Interactive — reference

Date: 2026-10-11. Everything below is measured via `performance.mark('load:*')`
marks mirrored from `LoadProfiler.markTime` — readable live:

```js
performance.getEntriesByType('mark')
  .filter(m => m.name.startsWith('load:'))
  .map(m => `${m.name}:${Math.round(m.startTime)}`).join(' ')
```

## Waterfall (warm F5, vite dev, wt transport)

| mark | ms | leg |
|---|---|---|
| nav → `initStart` | ~645 | vite module waterfall (dev-only — prod bundles collapse it) |
| `initStart` → `networkConnectStart` | +11 | socket opens almost immediately |
| `initStart` → `initComplete` | ~70 | heightmap, terrain, viewmodel, entities, HUD — the whole init block |
| first rendered frame | ~740 | loop starts pre-handshake; shader compile overlaps connect |
| `veilProbed` | ~14–430 | session-token `/rooms` ping (restore veil), capped 1.2s |
| `networkConnected` | ~1150 | handshake ~470ms, fully hidden inside init |
| `playerModelLoaded` | ~1150 | GLB lands mid-handshake, off the critical path |

**TTI ≈ 0.7s to pixels, ≈ 1.15s connected.** Before this pass: init alone
was ~2.4s, connected ~1.7s.

## The rule that did the work

Every fix was the same shape: **a serial await/block that didn't need to
be.** Boot is a dependency graph, not a sequence — anything that isn't a
hard predecessor of the next stage should be kicked and awaited later (or
never).

## Fixes, oldest first

### 1. `vmBaked.load()` synchronous AO bake — the 2.35s freeze (`8921acdc`)
`bakeVertexAO` (BVH build + hemisphere raycasts, ~100ms/weapon) ran for all
20 procedural weapons inside an `async` fn whose only `await` lived on the
unused baked-GLB path — so the whole bake blocked the ViewModel ctor. Now
`await yieldFrame()` per weapon: AO streams over the first ~2s while the
game is already up; `mat.vertexColors=true; needsUpdate=true` makes
late bakes recompile safely mid-flight.

### 2. `player.loadModel()` awaited before connect (`8921acdc`)
A ~0.4–0.6s GLB fetch+parse the **first-person camera never draws** was
awaited serially. Kicked at the Player ctor it resolves in the background;
`setVisible(false)` lands in the same microtask the load resolves, so it
can't flash rendered.

### 3. Frame loop started before connectPhase (`8921acdc`)
`gameLoop.start()` precedes `await connP` — first frames + shader compile
overlap the handshake. Safe because the terrain-swap machinery already
runs mid-game.

### 4. Socket opens at boot start (`84` insertions, main/wireIn)
`new NetworkManager()` + `connect()` moved from ~750ms into init to
+11ms. The blocker: handler deps (`h.*` hooks) bind during
`wireNetworkHandlers` — a worldstate landing on unbound hooks drops
silently → desync. `wireIn` has a ready-gate (`armEarlyQueue`/`markReady`,
512 cap) that queues inbound until the deps bind, then flushes in wire
order through normal dispatch. The session-veil `/rooms` probe kicks in
parallel. p2p/classic keep the late `connectServer` path (they need
signalling machinery built later — honest cutoff).

### 5. vite `server.warmup` (vite.config.js)
`clientFiles: ['./src/main.ts']` pre-transforms the boot chain at
dev-server start — an F5's import waterfall hits warm cache instead of
per-module transform latency. Dev-mode only; a prod bundle makes it moot.

## Bisect marks (left in — they cost nothing)

`playerCtor` `viewmodel` `entities` split the old opaque `playerCreated`
stage; `savedMapApplied` and `veilProbed` bisect the pre-socket leg of
`connectPhase`. If boot regresses, read the marks before guessing — the
one 9.9s stall we chased was a hung `/rooms` probe on a busy server, not
a code path.

## Evaluated, not worth it

- **DRACO/KTX2 asset compression** — the bottleneck was never bytes
  (local dev server; the GLB was already overlappable). File size fixes
  the wrong problem for F5.
- **Worker-side GLB parse** — ~0.5s off a path already off the critical
  one. Adds a serialization seam for no visible win.
- **Early-connect for p2p** — needs the signalling/loopback transports
  built first; `connectServer`'s p2p branch stays late by design.
- **Terrain/heightmap work off-thread** — heightmap load is ~25ms warm;
  not the bottleneck.

## If you're hunting the next stall

1. F5 → dump `load:*` marks.
2. Any stage >200ms that another stage doesn't strictly depend on → kick
   it earlier, await it later, or gate-queue its inbound like wireIn.
3. Anything network (probe/socket/asset) that can legally start at
   `initStart` → start it there; the wire is the cheapest thing to
   overlap because it never blocks the main thread.
