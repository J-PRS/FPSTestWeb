# InstancedMesh2 rig pilot — honest ROI report

## The problem it addresses

Every remote player is 3 `SkinnedMesh` draws — `mesh_0` (armor),
`mesh_1` (dark), `mesh_2` (accent) — three body-part materials per rig.
At 10-15 remotes that's 30-45 draw calls *just for player bodies*, plus
the per-draw program-resolution churn: `getParameters`/`getProgram`/
`setProgram` measured ~655ms/10s self-time on the CPU flame — three.js
re-resolving program state each draw, amplified by draw count.

## The fix

`@three.ez/instanced-mesh` (`InstancedMesh2`) — native skinned
instancing. One instanced mesh draws N same-class rigs in a single draw
call: shared geometry, shared bone *texture* on GPU, each instance writes
its own bone matrices into its slice. A room of 8 brawlers becomes ~1
draw per part instead of 24. Draws: ~30 → ~6.

## What it does NOT fix (important)

CPU bone-matrix math — `applyBoneTransform` — still runs per instance.
`Skeleton.update` is CPU-side per bot regardless of the draw path; the
shared texture only removes the *upload+draw* redundancy. Anim-LOD
(throttle near/mid/far + offscreen freeze, already built) is the real
CPU fix — it stays the load-bearing piece. This item is draws+churn only.

## Honest ROI

- ~30 draws out of ~437-611 total = **~6% of draw calls** — real but
  not dominant
- Program churn ~655ms/10s = **~6.5% of frame CPU**
- On this box (vsync floor, RenderPass ~4ms): invisible win
- On chromebook/weak-driver targets: draw-call CPU+driver overhead is
  exactly the bottleneck the campaign targets — pays more there

## The surgery (why it's not a swap)

`PlayerModel` produces one `SkeletonUtils.clone` scene per remote with
own material swaps (mannRev, gunmetal bake, rearm). Instancing needs:

- The rig's 3 parts split into 3 instanced pools per armor class
  (armor/dark/accent each a shared InstancedMesh2)
- Each remote writes its skeleton pose to 3 slots (one per part)
- Material swaps become per-instance uniforms, not per-mesh materials
- `loadGltfCached` + `mats.rearm` + `PlayerModelLod` all rework
- Screenshot-verify identical lighting before expanding beyond brawler

## Verdict

Real but bounded — the third item on the true cost list. `w:player`
anim-init staging (~30ms × N joins) and `quarks.update` (~965ms CPU)
are both bigger on the same axis. Worth landing for the chromebook
audience where draws matter most, but not the headline fix.
