# Sprinkler class-gating decision — universal, not light-only

Reference writeup of the 2026-10-24 discussion. Decision: **Sprinkler
stays available to every class** — it is not gated to light.

## The weapon's profile

`shared/weaponRows.ts` `[WeaponType.Sprinkler]`:

- 12 direct + 5 AoE @ ~10/s ≈ 140dps *on paper*
- 120 m/s arced bolts in a slight cone, gravity on, 3m pop radius
- Practical profile: mid-range **saturation / area denial**, not a
  precision weapon — arcs mean real hit rate is far below paper dps.

## Why NOT light-only

Light's class fantasy is speed + alpha strikes — the loadout wants
precision burst (bolt, disc) or duel-shaped spray. A hose that pays off
by holding a lane and saturating a corridor rewards *holding ground* —
medium/heavy's job. Gating it to light would make light's third slot a
trap pick: the weapon shape contradicts the class it'd be exclusive to.

The "light only has two weapons" gap is real but is a *roster* problem,
not a gating argument — the missing light weapon is duel-shaped (fast,
precise), which is a different weapon than the sprinkler.

## Why universal

- **Niche, not oppressive.** Non-oppressive niche weapons don't need
  class gates — loadouts self-select. Gating is for must-picks or
  weapons that break a class identity.
- It earns its slot on medium/heavy: hosing a corridor to protect a
  stand, denying a chute — the archetype is support-shaped and fits
  them cleanly.
- Variety cost of gating: locking a non-oppressive weapon behind one
  class removes build options for zero balance gain.

## Watch condition — when to revisit

The unresolved threat is **hose + mobility**: a light skier spraying a
flag room on the way through could be oppressive for non-damage reasons
(bolt spam, forced repositioning) rather than kills. If that becomes the
meta play, gate the Sprinkler to **medium as a support tool** — not
light.

Soaks should tag sprinkler usage by class: if light-class sprinkler
carries >~2× the usage share of other classes' sprinkler picks, the
mobility-hose combo is the play and the gate question reopens.
