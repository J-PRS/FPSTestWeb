# Mech/power-armor silhouette techniques (2026-10-24)

Reference for the class-rig builders (`_tools/models/build_*.mjs`) —
what makes chunky armor read as designed rather than "roblox", distilled
from the canon (Halo Mjolnir, WH40k Space Marine, UT3, mech-design
literature) and two rounds of applied experiments on `build_juggernaut`.

## Construction philosophies (tried + researched)

| Technique | How | Verdict for us |
|---|---|---|
| Rigid plate kit | discrete primitives per plate, one bone each | **current** — right language for armor |
| SDF smooth-union (`_OG`) | weld primitives, surface-net | mushy, no edges for wear bake — shelved |
| Single-vocabulary (brick/wedge experiment) | one primitive type only | brick survived (chunky reads well), wedge = spike monster — vocabulary is not the design axis |
| Sculpt → decimate | continuous mesh + remesh | needs retopo tooling we don't have |

The real axis is **construction logic**, not primitive choice:

## The design grammar (what actually reads)

1. **Plates mounted on a techsuit** — Mjolnir is literally "interchangeable
   plates on a padded underarmor." Our dark-undersuit cores were
   accidentally right. Plates should be *smaller* than suit mass at
   joints, *larger* at torso.
2. **Armor distribution = hierarchy** — thick on vitals (chest, head,
   reactor/back), thin on limbs. Chest mass > pauldron > limb guards.
   Even thickness = "suit of tires" read.
3. **Big-medium-small + detail clustering** — large shapes say WHO,
   medium say ROLE, small are personality. Cluster detail (UT3 puts it
   on back/shoulders), keep belly/legs quiet. Even spread = texture soup.
4. **Landmarks** — 2-3 signature silhouette features per character
   (Space Marine: pauldrons + chest eagle + backpack vents). jugg
   currently has zero — reads as "generic big guy."
5. **Negative space** — gaps between arm/body and between legs break
   the blob. (og failed exactly here.)
6. **Asymmetry** — one oversized pauldron > two; reads soldier-with-gear
   and is arguably more realistic (lead-shoulder protection).
7. **The back is the main view** — UT3 lesson: players stare at the
   back. Backpack/kit/vents belong there, not a flat wall.
8. **Every part justifies itself** — improves silhouette, explains a
   connection, or separates materials. Otherwise it's noise.
9. **Floating geometry is fine** — detail riding over the base mesh
   costs nothing at joints; our whole approach is already floaters.
10. **Silhouette-first process** — lock front/side/¾ outline before
    detail; nothing should sit axis-parallel (the earlier "organic"
    pass rule still holds).

## Variant builders (gunlab 'jugg vs og' row)

- `juggernaut` — plates, current
- `juggernaut_og` — SDF welded
- `juggernaut_brick` — chamfered boxes only (kept: chunky works)
- `juggernaut_wedge` — cones only (failed; file kept, may drop lineup)
- proposed: `jugg_land` (landmark: backpack slab + asymmetric pauldron +
  chest relief) and `jugg_dist` (distribution: torso/pauldron +25%,
  slim limb guards)

Builders + GLBs are gitignored; wiring = `RIG_MANIFEST` entry +
`PlayerModelVariant` union + `previews.ts` CLASSES row.

Refs: `_docs/2026-10-24_GUNMETAL_BODY_BAKE.md` (the wear pipeline),
`_tools/models/build_juggernaut.mjs` header (why plates > SDF).
