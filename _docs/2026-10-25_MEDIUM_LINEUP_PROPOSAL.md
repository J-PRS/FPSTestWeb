# Medium lineup — proposal (2026-10-25)

Status: **proposal, nothing built yet.** Geometry only; animations are
reused from the shared kevdev pack (`sources: ['kevdev']` on `vexa`).

## Why medium is harder

Light and heavy each have a clear job: light is slim and fast, heavy is
massive. Medium sits between them, so a scaled light or a starved heavy
reads as neither. It needs its own identity, not a midpoint.

## Constraints found in the rig

- The medium GLB (`class_medium.glb`) is **not** on the 66-bone scout
  skeleton. It has 82 mannequin-named bones (`Base_HumanRUpperarm1`,
  `Base_HumanRCalf`, …) authored in centimeter scale.
- Measured joint map, meters relative to the pelvis, saved by
  `_tools/models/medium_joints.py`:
  - spine3 (0, −0.34, −0.02), neck (0, −0.48, 0.02), head (0, −0.61, 0.02)
  - shoulder R (−0.03, −0.46, −0.08), upper arm (−0.13, −0.47, 0.01)
  - forearm (−0.22, −0.25, 0.03), palm (−0.33, −0.07, 0.02)
  - thigh (−0.11, −0.02, −0.05), calf (−0.10, 0.34, −0.04), foot (−0.09, 0.91, 0.02)
- Bone frame: **up is −Y**, lateral is X, depth is Z and small (<0.1 m).
  Builders must convert to our Z-up frame before placing pieces.
- Figure height is about 1.5 m foot to head, versus scout's 1.9 m fit.
- `vexa` (the current medium) runs the shared locomotion pack.

## Proposed archetypes (4 + current)

Each is a distinct design rule, not a size change.

1. **Agile raider** — lean torso, light plates on fast joints, a visible
   backpack for mobility. Rule: silhouette reads as a moving target.
2. **Skirmisher** — balanced frame with asymmetric kit: one arm with a
   large gauntlet or shield, the other slim. Rule: one side is different.
3. **Walking shield** — broad chest shell and bulky forearms, a large
   front plate. Rule: the torso is the shield.
4. **Exo frame** — open exoskeleton: thin struts and a small core, armor
   only at joints and pelvis. Rule: the structure is visible, not the armor.

Lineup row: **current medium (vexa) | raider | skirmisher | shield | exo**,
using the same left-to-right reference convention as Heavy and Light.

## Build plan

1. Write one medium builder per archetype against the joint map, sharing a
   common joint-overlap and waist connector block (the same fix that
   removed gaps on the light rigs).
2. Verify each in gunlab from front and side before adding archetype detail.
3. Register each as a `medium_*` manifest entry with the same `sources`
   and `anims` as `vexa`, so motion stays shared.
4. Add the Medium Lineup row to gunlab.

## Open questions

- Confirm the four identities above, or swap any.
- Confirm the current medium stays as the leftmost reference.
- Later, not in this pass: medium-specific gait clips.
