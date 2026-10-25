# Perf + netcode checklist — chromebook campaign

Verification: `E2E_GPU=1 bun _tools/e2e/perf.ts --bots 10 --secs 30 --cpu 10
--mode headhunt --map rimrock` — gpu:pass rows, drawcensus, cpuflame.

## Rule (locked)

Top-tier visuals are sacred. Every item is either **pixel-identical**
(re-architecture, instancing, merge, cache) or **tier-gated** (ladder
sheds that only fire below the user's baseline and restore on headroom).
Skinned-instancing must be screenshot-verified for identical
lighting/shadows before merge.

## Measured hotspots (real data, headhunt/rimrock, 10 bots)

GPU: `RenderPass≈3.4-4.5ms` (the wall), post chain `≈0.8ms` total,
bloom `0.31-0.87ms` (pmndrs mip-blur already), draws `≈350-600`,
tris `≈170-260k`.

CPU flame (`--cpu 10`, self-ms/10s):
- **`applyBoneTransform` 1284ms** — CPU skinning, 10 rigs — CPU #1
- **program resolution ~1300ms** — getParameters/getProgram/setProgram/
  getProgramCacheKey — three.js per-draw state resolution
- `three__quarks.update` 557ms — particle sim CPU
- `sampleHeightmap` 412ms — terrain height queries
- `renderBufferDirect` 376ms, `multiplyMatrices`+`getVertexPosition` ~400ms
- GC 128ms — allocation discipline holding

Census (steady): `mesh_0/1/2` skinned parts ~30 draws (brawler×4,
brute×3, scout×2 rigs × 3 parts), Sprite×24, Lambert×34 (bot weapons),
MeshBasicMaterial transients ~50 at combat peak only.

## Phase 1 — the rig problem (CPU #1 + draws #1, one fix)

- [x] ~~Anim LOD throttle~~ — ALREADY BUILT: `pickAnimCadence`
      (remoteAnim.ts:67) — offscreen=freeze, >120m=15Hz, >60m=30Hz,
      plus distal-bone LOD (line 241) and burst-accumulated far ticks.
      Verified in code.
- [ ] **InstancedMesh2 skinned rigs** (surgery, scoped): lib installed
      (`@three.ez/instanced-mesh`). Real design: each rig = 3 instanced
      pools (mesh_0/1/2 armor/dark/accent materials) per armor class;
      each remote keeps a hidden PlayerModel for mixer/skeleton (CPU
      anim work stays — anim-LOD already throttles it), its bones copy
      into slots. Win = ~30 draws + program-resolution churn only, NOT
      bone-matrix CPU. Needs loadGltfCached rework + mats.rearm/LOD
      rework + screenshot-verify identical lighting/animation.
      Files: RemotePlayer.ts, PlayerModel.ts, playerModelLod.ts.
      Bounded win — sequence AFTER confirming measured benefit.

## Phase 2 — CPU budget (iGPU boxes have weak CPUs)

- [ ] **`sampleHeightmap` call-volume audit** — 412ms/10s but the call
      itself is ~15 ops bilinear (already minimal). 187 call sites.
      Real fix = per-caller: settled objects (rested nuggets/debris)
      re-sample identical pos every frame — cache last height until
      moved. NOT a shared-memo fix (continuous domain).
- [ ] **quarks CPU batch/worker** — 557ms/10s sim; density cap at
      tier≥3 exists via setVfxQualityScale — extend harder, or move
      the batch sim to a worker.
- [ ] Program-resolution churn — mostly falls out of draw reduction
      (Phase 1). Remainder: three r165+ has lighter program caching.

## Phase 3 — GPU/draws

- [x] **Composite merge** (`42bcb647`) — sanitize2+dirt+aces+contrast
      fused into one GradePass: 4 roundtrips → 1. gpu:pass shows
      `GradePass avg=0.10ms` vs ~0.25ms across the old chain. Dirt gate
      moved to dirtIntensity uniform; deep-tier shed drops the fused
      pass (raw output, matching the old shed intent).
- [x] **Sprite batch** (`c5952778`) — nugget glow halos ride one
      GlowBatch InstancedMesh (camera-facing quads, per-instance
      center/size/alpha/color). Sprite count gone from drawcensus.
      Indicator sprites (DOM-side) still separate — separate item.
- [ ] **`?matcensus` combat-peak probe** — name the transient
      BufferGeometry×249 class (decals? impact quads?) then pool.
- [ ] Lambert×34 bot weapon meshes — verify owner first.

## Phase 3.5 — unaudited render settings (cheap checks, real wins)

- [x] ~~Remote `frustumCulled` + `matrixAutoUpdate`~~ — VERIFIED already
      handled: PlayerModel.ts recomputes skinned bounds (522,529,600)
      and preserves the root auto-update deliberately (415) — not
      per-frame sphere recompute.
- [x] ~~Pixel-ratio cap~~ — VERIFIED: `getPixelRatio = min(dpr,2) *
      resScale` (renderer.ts:592); the ladder's resScale already shrinks
      effective dpr at low tiers.
- [x] ~~dpr cap at deep tier~~ — VERIFIED redundant: RES_LADDER bottoms
      at 0.4 (loopPerf:205), so deepest tier already computes
      `min(dpr,2) × 0.4 = 0.8` effective — below 1 without a clamp.
- [ ] **Shadow map size/cascade count** — shadow pass ~0 measured, but
      resolution vs cascades unprofiled individually; a 2048→1024 tier
      cut is invisible if it's oversized.
- [ ] **KTX2/meshopt on GLB rigs** — 2.9MB game.js aside, model+texture
      wire size unmeasured; compression = load-time AND VRAM.
- [ ] **Small-texture atlas** — many small textures = GL bind churn;
      census texture count per frame.

## Phase 4 — floor + hygiene

- [ ] Seed-tier validation on real iGPU strings (Intel UHD / llvmpipe /
      Mali/Adreno) — extend gpuClassTier from live dumps.
- [x] **w:player spike** — rig-clone pool (`c752654c` + depth `53fa4314`):
      warmRig pre-clones 3 armor variants ×4 at boot; joins grab off the
      shelf. Measured: w:player 62→30ms (-51%), jsBusy -20pt, p95/p99 at
      vsync floor, >50ms frames -96%. Residual ~30ms = anim init, not clone.

## Done

- [x] GPU pass harness + census + cpuflame (`4397828a` `82914490` `3aeaa4ba`)
- [x] Beam instancing 27→1 (`83ef4102`)
- [x] GPU-class seed tier (`ad81dfed`)
- [x] Dirt shed at deep tier (`bbde6d4c`)
- [x] Exonerated: MeshBasicMaterial×51 (peak transients), gameLoop:826
      alloc (not hot), health bars (cheap divs), shader compile
      (rewarmT+compileAsync), bloom (already mip-blur)

## Deploy / ops

- [ ] **Drain deploys** — zero-disconnect releases via A/B builds:
      new process on port+1, old rooms marked `draining` (no new joins),
      exits when last match ends. Room lifecycle does the migration,
      no serialization needed. Writeup: DEPLOYMENT/drain-deploys.md.

## Netcode carryover (from earlier rounds)

- [ ] `kb-unpredicted` source breakdown (blast/grapple/disc) before any fix
- [ ] `trajBounced` vs `trajDiv` live dump — confirm grenade offM tail
      shrinks post ghostBodyPop
- [ ] `loaf` main-thread hitch repro (~2s stall correlated with stale echo)
