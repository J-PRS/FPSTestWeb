# Time To Shoot (TTS) and Data To Shoot (DTS) - reference report

Date: 2026-10-26.
Scope: cold-boot performance from URL entry to the first fired shot, and the
bytes downloaded before that shot. Covers the current measured state and the
realistic improvement levers.
Status: measurement/reference. No gameplay behavior is changed by this doc.

## 1. Definitions

- **TTS (Time To Shoot):** `performance.now()` at the moment the first
  projectile spawns, minus navigation start. In other words, the wall-clock
  time a fresh client needs before it can fire its first shot.
- **DTS (Data To Shoot):** total `transferSize` of the navigation document
  plus every resource whose `startTime` is before the first shot. This is
  the cold-cache download volume that must complete (or at least start)
  before a shot is possible.
- **Ready:** the moment the canvas appears / the first frame is presented.
- **Veil drop:** the moment the session veil is removed and input is
  unfrozen. Shots are ignored until this happens.

## 2. How it was measured

Primary tool: `_tools/e2e/tts.ts`.

Command (networked, non-debug, cold cache, real GPU):

    $env:E2E_GPU='1'; bun _tools/e2e/tts.ts "http://localhost:5500/?room=loadt&tts=1" --runs 3

What the script does:

- Launches headless Chrome with a fresh user-data dir per run.
- Disables the disk cache (`--disk-cache-size=0`, `--media-cache-size=0`,
  `--disable-gpu-shader-disk-cache`, `--disable-application-cache`) and
  calls `page.setCacheEnabled(false)`.
- Waits for the canvas, then clicks repeatedly until a shot registers.
- Reads `window.__ttsShot`, which is stamped once in
  `client/src/game/combat/fire.ts` (`spawnProjectile`) on dev hosts or when
  `?tts=1` is present. The stamp is `performance.now()` and is invisible
  (no debug overlays, no wireframes).
- Collects `performance.getEntriesByType('mark')` and
  `performance.getEntriesByType('resource')` for the breakdown and DTS.

Milestone marks come from the existing `LoadProfiler` in
`client/src/utils/profiling.ts` (`profiler.markTime(...)` produces
`load:<name>` marks) plus two added marks:

- `load:terrainSwapped` in `client/src/game/net/mapAssets.ts`
  (`applyTerrain` finally block).
- `load:veilDropped` in `client/src/game/net/world.ts`
  (`dropSessionVeil`).

The server was the local dev server on :8000; the client was the Vite
preview on :5500 serving a production build.

## 3. Current state - networked (room=loadt)

Representative run (the one with the full mark chain):

| Phase | Time (ms) | Duration |
|---|---:|---:|
| `load:initStart` | 186 | - |
| `load:networkConnectStart` | 192 | - |
| `load:heightmapLoaded` | 201 | - |
| `load:terrainCreated` | 224 | - |
| `load:effectsCreated` | 226 | - |
| `load:playerCtor` | 227 | - |
| `load:viewmodel` | 242 | - |
| `load:entities` | 407 | - |
| `load:playerCreated` | 408 | - |
| `load:networkInit` | 408 | - |
| `load:hudCreated` | 411 | - |
| `load:initComplete` | 416 | - |
| `load:savedMapApplied` | 423 | - |
| `load:playerModelLoaded` | 1843 | 1.42 s (overlaps) |
| `load:networkConnected` | 1957 | 1.76 s |
| `load:terrainSwapped` | 4600 | 2.64 s |
| `load:veilDropped` | 8065 | 3.47 s |
| `tts:shot` | 8372 | 0.31 s |

**TTS = 8.37 s** in that run. Across three runs the TTS values were
6.95 s, 7.26 s, and 8.37 s (median 7.26 s). The spread comes from the
veil-stability window, which is frame-time dependent.

### 3.1 Offline (no room) for comparison

Without a server (solo mode, `?tts=1` only):

- Non-debug TTS: 4.09 s, 4.17 s, 4.18 s (median 4.17 s).
- Debug mode (`?debug=1`): 4.19 s, 5.31 s, 4.19 s (median 4.19 s).

So the network path adds roughly 3 s over the offline path, and almost all
of that is connection (1.8 s) + terrain swap (2.6 s) + veil (3.5 s).

## 4. DTS - data to shoot

Measured on the same networked run, cold cache, `transferSize` summed for
the document plus every resource whose `startTime` is before the shot.

**DTS = 2.90 MB (24 requests).**

| Type | Size (KB) | Share |
|---|---:|---:|
| GLB (player model) | 1703 | 57% |
| JS (bundle) | 912 | 30% |
| BIN (heightmap) | 263 | 9% |
| WebP | 43 | 1% |
| WOFF2 | 16 | <1% |
| ICO | 15 | <1% |
| CSS | 9 | <1% |
| Document | 2 | <1% |
| **Total** | **2900** | **100%** |

### 4.1 Predicting TTS on worse networks

DTS sets a download floor (server processing and veil stability are
additive on top):

| Link speed | Time to download 2.9 MB |
|---|---:|
| 50 Mbps | 0.5 s |
| 25 Mbps | 0.9 s |
| 10 Mbps | 2.3 s |
| 5 Mbps | 4.6 s |
| 2 Mbps | 11.5 s |
| 1 Mbps | 23 s |

On the dev box the measured TTS is ~7.3 s even though the download floor
is ~0.5 s. On a 5 Mbps link, expect roughly
`download floor (4.6 s) + server/veil overhead (~6 s) = 10-11 s`.
On 2 Mbps the download dominates and TTS is 11 s+.

## 5. Where the time goes (current state)

1. **Network connect: 1.8 s.** WebSocket open + join handshake + server
   gameState. On localhost this is unexpectedly long; the server's join
   path and the size of the gameState payload are the suspects.
2. **Terrain swap: 2.6 s.** Heightmap bin, albedo texture, and skybox
   faces are fetched and swapped. This blocks `sessionVeilReady`, so the
   veil cannot even start its stability window until it finishes.
3. **Veil stability: 3.5 s.** The veil waits for 45 consecutive sub-26 ms
   frames. The first frame compiles shaders (`renderer.compile`), but later
   material/texture uploads keep hitches above the threshold, so the veil
   holds for ~3.5 s (up to the 8 s escape timer).
4. **Input acceptance: 0.3 s.** Once the veil drops, the first click fires
   within ~10-30 ms. No input-latency problem.

## 6. Improvement levers (ordered by payoff)

1. **Precompile the full material/shader set during load.** The veil
   already calls `renderer.compile` on frame 0, but new materials appear as
   the terrain swaps. Compiling them up front (or before the veil) could
   cut the 3.5 s stability window to under 1 s.
2. **Cache and shrink the terrain assets.** The heightmap bin (263 KB),
   albedo, and skybox (43 KB WebP + sky faces) are re-fetched on every
   cold boot. Aggressive caching (versioned filenames, long
   `Cache-Control`) and smaller/quantized heightmaps would cut the 2.6 s
   swap and reduce DTS.
3. **Reduce the gameState payload.** Structures, pickups, deployables, and
   flags are sent in full on join. Diffing against the boot map or sending
   only deltas would shrink both the 1.8 s handshake and DTS.
4. **Optimize the server join path.** Profile `SessionManager` seat
   assignment and spawn-hold. The 1.8 s connect time on localhost suggests
   server-side work, not network.
5. **Defer the player model load.** `playerModelLoaded` lands 1.4-1.6 s
   after init and overlaps the connect, so it is not strictly critical
   path, but it competes for bandwidth with the terrain fetch. A
   low-poly placeholder that swaps in later would reduce contention.
6. **Tune the veil stability gate.** The 45-frame / 26 ms threshold is
   conservative. Measuring the actual frame-time distribution could justify
   a lower count or a slightly higher per-frame budget without hurting
   the "no first-frame hitch" goal.

## 7. Instrumentation added (for future runs)

- `client/src/game/combat/fire.ts`: stamps `window.__ttsShot` and
  `performance.mark('tts:shot')` on the first shot (dev hosts or
  `?tts=1`).
- `client/src/game/net/mapAssets.ts`: `performance.mark('load:terrainSwapped')`
  in the terrain-swap finally block.
- `client/src/game/net/world.ts`: `performance.mark('load:veilDropped')` in
  `dropSessionVeil`.

The existing `LoadProfiler` in `client/src/utils/profiling.ts` already
emits `load:<name>` marks for every boot milestone.

## 8. Reproduction commands

Networked (with marks and DTS):

    $env:E2E_GPU='1'; bun _tools/e2e/tts.ts "http://localhost:5500/?room=loadt&tts=1" --runs 3

Offline (no server, no overlays):

    $env:E2E_GPU='1'; bun _tools/e2e/tts.ts "http://localhost:5500/?tts=1" --runs 3

Debug mode (with overlays, for comparison):

    $env:E2E_GPU='1'; bun _tools/e2e/tts.ts "http://localhost:5500/?room=loadt&debug=1" --runs 3

## 9. Open questions

- Is the 1.8 s connect time dominated by the net worker startup or by
  server-side join processing? A server-side timestamp in the join
  response would settle it.
- How much of the 2.6 s terrain swap is the heightmap bin versus the
  albedo/skybox? Per-resource `duration` from the Performance API would
  split it.
- Can the veil stability window be shortened without reintroducing
  first-frame hitches on low-end GPUs?
- Would HTTP/2 or preloading the terrain assets cut the swap time more
  than caching alone?
