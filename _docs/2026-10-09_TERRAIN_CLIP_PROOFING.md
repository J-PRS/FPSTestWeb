# Terrain clip-proofing — audit + best practices

Question: after `bodyGroundLift`, are player models actually clip-proof at the feet?

## What we shipped

`client/src/entities/bodyGround.ts` — render-only lift: samples terrain at
the body footprint (center + 4 axial probes at 0.62m), plants the mesh's
feet on the highest sample. Caps at 1.4m (a probe higher than that hit a
wall beside the body, not ground under it). Skips the ring >2.5m above
ground. Snap-up instant, ease-down ~120ms. Applied at all three placement
sites: live remotes (`remoteAnim.tickModel`), corpses (`tickDead`), local
third-person (`updateModelAnim`).

## What it fixes — and what it provably does NOT

### Fixed

- **Slope burial (the dominant bug).** The sim guarantees only the feet
  *point*; the mesh is a rigid column. On a 45° face a heavy (r=0.8)
  buried ~0.8m of leg uphill. Now the mesh rides the footprint max —
  worst case is a slight hover, never burial.
- **Remote netcode dips.** `interp()` copies Hermite samples (dips under
  crests between snapshots); `convergeStep` has no clamp; only DR's
  `simStep` clamped — and only at center. The lift self-heals all of it.
- **Corpse tumble** on slopes, same mechanism.

### Known residual clips (honest list)

1. **Diagonal slopes undersample ~29%.** Four axial probes measure the
   steepest ascent at cos45°≈0.71 of true for a diagonal slope → a 45°
   diagonal face can still bury ~0.2m at the ring edge. Cheap fix: add
   the 4 diagonal probes, or scale the ring to class capsule radius and
   probe 8-way.
2. **No epsilon pad.** GPU terrain vertices sample the same heightmap
   bilinear, but the rendered *triangle chord* can sit a few cm under the
   sampled quad patch (triangulation vs bilinear saddle). Feet land
   exactly at logical height — a 1-2cm nick is possible on rough cells.
   Cheap fix: `+0.03` pad on the lift.
3. **The 1.4m cap reintroduces clip beside tall ledges.** Standing flush
   against a >1.4m berm leaves legs inside its face — correct behavior
   for *walls* (lifting reads as levitation), wrong for steep *berms*.
   The real fix for that case is horizontal push-out, not lift.
4. ~~**Structures aren't sampled.**~~ **Fixed** — `structureSpecs` now
   keeps a live `SolidWorld` and registers `structureTopAt` into
   `bodyGround` via a registration seam (direct import cycled
   remoteAnim → structureSpecs → botBrain → RemotePlayer). Deck lips
   and dome caps get the same lift as terrain slopes; tops are capped
   at `feetY + MAX_LIFT` so a ceiling never reads as floor.
5. **Foot geometry vs slope.** We lift the root but never rotate the
   foot/body to the terrain normal: toes clip the uphill face a bit,
   heel floats downhill. Below ~20° it's invisible; on steep faces it's
   the remaining "feet in the hill" read. Real answer is slope-lean or
   per-foot IK.
6. **Swing-leg overshoot.** A run stride or jet-landing leg reaches past
   the footprint ring — the foot can dip into rising terrain even with
   the root lifted. Only per-foot IK fully solves this.

## What industry does (the standard stack)

From Vulkan Docs' foot-IK tutorial, ozz-animation's foot_ik sample, UE's
HumanIK floor-contact, ARK's ground-conform rig, and the gamedev canon:

- **Per-foot raycast from *above* the foot** (never from the foot — a
  clipped foot starts under the surface and the ray misses). Ray length
  ~leg length. Layer-masked to walkable surfaces.
- **Pelvis adjusts to the lowest foot** — pushing feet down without
  dropping the root = feet sink one side, hover the other (exactly the
  failure mode we patched at the root level).
- **Foot rotates to the contact normal** — toe/heel conform to the slope.
- **Temporal smoothing of IK targets** — feet ease to the solution over
  several frames; raw per-frame IK snaps.
- **Phase gating** — IK only while the foot is planted/in-approach;
  disabled during swing (and several shipping games gate it to
  idle/slow states entirely — at locomotion speed nobody reads it).
- **Distance LOD** — skip the raycasts for far NPCs; nobody can see
  their feet anyway.

Our footprint-max lift is essentially the *pelvis* half of that stack,
at ~5 heightfield reads per body per frame (≈nothing). It's the right
90/10 for this game: Tribes-speed play makes per-foot IK mostly
invisible, and our remotes are LOD-tiered already.

## Ranked recommendations

1. **Do now (cheap, kills the residual cases):**
   - `+0.03m` epsilon on the lift (rendered-triangle chord slop).
   - 8-way ring (add the 4 diagonals) — kills the 29% undersample.
   - Ring radius from `classCapsule(armorClass).radius` instead of a
     fixed 0.62 — heavies need 0.8.
2. ~~**Next:** fold structure tops~~ — done (see above).
3. **Later, if feet-on-slopes still read badly:** slope-lean (tilt the
   model a few degrees toward the terrain normal when grounded+idle —
   we already have `setBodyLean` for jets, same channel), or gated
   per-foot IK for idle/walk only.
4. **Not worth it:** full-time per-foot IK during skiing/jetting —
   motion is too fast for anyone to read, and it's the most expensive
   option for the least visual gain.
