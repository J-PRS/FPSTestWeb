# Boot waterfall — measured decode of TTS starvation

Date: 2026-10-28. Method: `performance.mark` chain through the whole
connect path, read via `_tools/e2e/tts.ts` (`?room=loadt&tts=1&net=auto`,
E2E_GPU=1, cache disabled). Committed `680e7469`.

## The mark chain (now permanent)

```
load:initStart → networkConnectStart → netWorkerCtor → netWorkerReady
→ entities → initComplete → warmupStart/Done → savedMapApplied
→ loopFirst → veilCompileStart/Done
→ rigParseStart/Done → rigCloneDone → modelSetupDone → playerModelLoaded
→ networkConnected → gameStateArrived → terrainApplyStart
→ terrainBin → terrainTex → terrainSky → terrainSwapped
→ terrainWarmupStart/Done → veilDropped → tts:shot
```

## Measured phases (representative run, heavily loaded box)

| Phase | Time | What it is |
|---|---|---|
| init → entities | ~0.9s | module eval + entity/HUD setup |
| netWorker boot | ~0.3-0.5s | worker module eval — **cheap, not the issue** |
| `renderer.compile` | **7-41ms** | suspected 2s block — actually free |
| **rigParse (GLB decode)** | **~1.7s** | meshopt WASM decode + scene build, one atomic sync block |
| rigClone + modelSetup | ~50ms | SkeletonUtils.clone + material setup — free |
| AO bake (`bakeVertexAO`) | not in this path | ~1s known cost, only fires for gunmetal rigs |
| networkConnected | resolves right after rigParse | the `up` msg was queued ~1.5-2.2s behind the parse |
| join→gameState | ~300ms | handshake is cheap once the queue drains |
| **terrainBin gap** | **~3.3-3.8s** | 263KB fetch's promise drain-starved behind per-frame spawn material compiles |
| tex/sky | ~0ms | this map has no albedo/cubemap |
| terrainWarmup | ~25-160ms | GPU-displacement clipmap — cheap |
| veil | ~3-5s | frame-stability gate (45 consecutive sub-26ms) |

## What the marks killed (bad hypotheses)

- ~~worker boot dominates connect~~ — 270-500ms
- ~~`renderer.compile` is the 2s block~~ — 7ms; `compileAsync` debate is moot here
- ~~wt probe timeout~~ — half-right: see below
- ~~join-from-worker needed~~ — handshake is only ~300ms once drained

## The WT cold-dial bug (fixed)

`wt.ready` measured: **first dial 2476-3163ms, subsequent 145-297ms** —
a one-time QUIC cost (no resumption ticket + self-signed cert path)
that the 3s probe cap was losing ~half the time → wt silently never
landed on first connect even on a healthy path. Raised to 4.5s
(`tiersWebTransport.ts`, `680e7469`). A boot-time "warm dial" was
implemented, measured, and **reverted**: it finishes at ~3s while the
real probe starts at ~0.9s, still cold — resumption only helps after a
*completed* handshake, so the warm dial just contends.

## The starvation model

Everything between `netWorkerReady` and `veilDropped` is one serialized
main-thread queue. The big blocks are atomic sync work — moving them
earlier doesn't help, only removing them from main does:

1. **GLB parse ~1.7s** — blocks the `up`/join/gameState drain. Remotes
   share it via `loadGltfCached` so it's once per variant; a second
   variant (~600-800ms) lands mid-veil for bot classes.
2. **Spawn/roster material compiles** — distributed per-frame cost that
   starves the bin fetch's promise ~3.3s. Not a single call — it's the
   veil frames compiling each new remote's materials on first draw.
3. **Veil ~3-5s** — real work (its frame-stability gate is the whole
   point), not dead time.

## Levers, honestly ranked

| Lever | Recovers | Effort | Verdict |
|---|---|---|---|
| wt probe cap 4.5s | wt lands on first connect | done | shipped `680e7469` |
| Workerize GLB parse | ~1.3-1.5s TTS | ~day (toJSON→ObjectLoader hop) | real, if TTS matters |
| LOD-boot (parse lod1 first) | most of the parse off the critical path | ~30 lines | real rig hot-swap exists — recommended next |
| join-from-worker | ~300ms handshake | ~30 lines | small, after bigger fish |
| AO-bake worker | ~1s for gunmetal rigs | small (transferable buffers) | targeted, real |
| Compile `lodUrl` rigs in worker | bot-class parses too | same as GLB parse | fold into the same work |

## What the veil actually pays for

The veil's job is "no hitchy first seconds" — and the stability gate is
correctly the last thing in the chain because every earlier block
*feeds* it: a frame can't be stable while a parse is running. The
fastest path to veil-drop is therefore "all the big blocks done early"
— which is why the GLB parse is the real TTS lever, not anything
about the veil itself.

## Reproduce

```
set E2E_GPU=1
bun _tools\e2e\tts.ts "http://localhost:5500/?room=loadt&tts=1&net=auto" --runs 2
```

Marks dump per-run; `playerModelLoaded`→`networkConnected` delta shows
the drain queue depth, `rigParse*` shows decode cost per variant.
