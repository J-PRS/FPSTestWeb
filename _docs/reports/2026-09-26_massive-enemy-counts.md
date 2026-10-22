# Massive Enemy Counts — Feasibility

Goal: hundreds of simultaneous enemies on screen. Current architecture status: **feasible, one real refactor + three cheap wins**. Nothing fundamental blocks it — your enemies are procedural primitive-mesh builds, which is the best possible starting point for instancing.

## Where the cost actually lives today

Measured against the codebase:

1. **Draw calls / render state — THE wall.** Every enemy builds its own `THREE.Mesh` parts (~5–15 meshes per enemy across the roster: body, head, gun, fins, shadow blob, telegraph rings, gizmos). At 50 enemies ≈ 300–750 draw calls; at 300 enemies ≈ 2000+. WebGL dies around ~1000–3000 draw calls on midrange GPUs regardless of geometry complexity. This caps you around ~100 enemies today, and it's pure GPU submission cost — not fill rate.
2. **CPU update loop — second wall.** Each species runs a per-frame `update(dt)` doing AI (vector math, telegraphs, timers) + writing transforms to scene-graph nodes. ~O(n) with a decent constant. Fine to ~500 enemies in JS if kept allocation-free; becomes a GC source if any per-frame allocs exist.
3. **Scene-graph overhead.** Each part is a child node → matrix dirty propagation per node per frame. 300 enemies × ~10 nodes = 3000 node updates — meaningful but fixable with instancing (instance matrices upload in one shot).
4. **Geometry allocation.** Most species create geometries per enemy — same shape rebuilt 300×. Cheap fix regardless.

## The plan, ordered by cost/benefit

### Tier 1 — hours, no architecture change
- **Shared geometry per species**: build each species' geometries once, share across instances. Free, immediate.
- **Cull telegraphs/gizmos**: debug rings and telegraph meshes skipped beyond a distance or when count > threshold.
- **Kill the blob-shadow meshes** at high counts — replace with a single projected-quad instanced pass, or drop entirely past ~100 enemies (nobody reads shadows in a swarm fight).

### Tier 2 — the refactor that matters (1 session)
- **InstancedMesh per species-part.** Convert each enemy's rigid parts into one `InstancedMesh` per (species, part): e.g. "Crawler body", "Crawler head", "Rakk wings". Each enemy owns a compact state record (pos, rot, anim phase); per frame, write `setMatrixAt(i, m)` for its instances. Three.js uploads each InstancedMesh's matrix buffer once — draw calls become **parts-per-species** (~10–15 total for the whole swarm), not parts-per-enemy.
- Roster suitability: **excellent**. Your enemies are low-poly primitive builds with whole-part animation (bob, tilt, wing flap) — no skinning. Whole-part transform animation maps 1:1 onto instance matrices; Crawler crouch-telegraph = scale its instance, Seeker dart = move its instance.
- Expected result: ~10–20 draw calls for the entire swarm → **500–2000 enemies** GPU-side, easily.
- Cost: a `SpeciesRenderer` abstraction per species (~100 lines each); the entities keep their AI/behavior code, they just stop owning meshes and write to a shared instance slot instead. `targetIds` + hit testing switch to per-instance id lookup (three.js raycast supports instanced picking, or do it analytically — you already compute sphere distance server-side anyway).

### Tier 3 — cheap scaling tricks when Tier 2 lands
- **AI time-slicing / LOD**: far enemies update AI at 10Hz, mid at 30Hz, near at full. AI doesn't need 60fps to look alive — Rakks already glide most of the time.
- **Spatial hash for hits**: projectile-vs-enemy checks are currently a linear scan per projectile per frame — fine at 50, O(n·m) pain at 1000. Uniform grid on the flat terrain = trivial to add, you already have a shared constants layer for cell size.
- **Burst spawn amortization**: waveDirector currently can dump a wave in one frame; spread spawns over frames to avoid hitches (matters when spawning 200 with object pool warm-up).
- **Object pooling**: never allocate/free enemies mid-wave — recycle into a per-species pool keyed to the instance slot index.

### Tier 4 — only if you're going >1000
- GPU-driven skinning irrelevant (no skinned meshes), but you could push anim into instance attributes + vertex shader (phase → flap in shader) — removes per-frame matrix writes entirely. Premature until Tier 2 ships.
- Web Worker for enemy AI — likely unnecessary; LOD time-slicing buys more for less complexity.

## The real ceiling estimate

| Stage | Cap | Bottleneck |
|---|---|---|
| Today | ~80–120 | draw calls |
| + shared geometry, cull debug | ~150 | draw calls + node updates |
| + InstancedMesh refactor | ~1500–3000 | CPU AI (fixable with LOD) |
| + AI LOD + spatial hash | ~3000–5000 | bandwidth of instance buffers / gameplay readability |

Note the last row: **above ~500 enemies the gameplay stops being readable anyway** — at that point swarm feeling is better served by shader-crowd tricks (distant enemies as a single flocking mass, e.g. a "Rakk murmuration" drawn as one particle system) than real entities.

## Recommendation

Do Tier 1 + Tier 2. It's a bounded refactor (one `SpeciesRenderer` interface, convert species one at a time, keep old path behind a flag), gets you into the thousands, and — bonus — it also cleans up the last big rendering debt item. The species are already clean enough that each conversion is mechanical. Highest-risk part is hit detection switching from mesh raycast to instance/analytic testing, but the server already validates hits analytically so the client change is low-stakes.
