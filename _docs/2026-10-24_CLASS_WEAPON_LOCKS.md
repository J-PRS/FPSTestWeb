# Class weapon-lock review — the caliber ladder

Reference writeup of the 2026-10-24 design review of
`shared/botClasses.ts` tier locks. Governing model: **your armor class
IS your caliber** — the ladder is payload size, not precision-vs-ordnance
as first assumed.

## The ladder

- **Light** = precision, no payload (Railgun, Lightning)
- **Medium** = mid ordnance (Flak, Cannon, PlasmaGun)
- **Heavy** = siege ordnance (Mortar, PlasmaCannon, RocketLauncher,
  MRVLauncher, Bombard)
- Everything else = universal (BoltLauncher, Disc, Chaingun, GL,
  Shotgun, Sprinkler, sidearms, melee, tools, Implodisc/BeltDisc)

Two lock shapes: heavy is a **floor** lock (heavies keep everything
below them minus the other exact-class sets); medium + light are
**exact-class** locks — a heavy can NOT shoulder a mid-size Cannon or a
light railgun. That rule is the load-bearing choice.

## Per-weapon rationale

### HEAVY_ONLY {4,7,15,28,35}

- **Mortar** — stand-anchor barrage. Pro: cements heavy identity.
  Con: heavies leaning on mortar spam get one-dimensional at range.
- **PlasmaCannon** — fat-bolt direct-fire siege. Pro: heavy gets lob
  AND punch. Con: 5.5m splash at close quarters is oppressive in
  brawls; may crowd Bombard.
- **RocketLauncher** — flat placement missile: steep ring pays at the
  feet, kb30 is the rocket-jump tool ("the tool IS the movement").
  Pro: heavy's blast AND mobility lever in one. Con: double-duty
  (siege+jump) makes it the utility default — variety risk is in slot
  pressure, not power.
- **MRVLauncher** — airburst carrier: fuse pops ~80m in, rains 6
  bomblets into a 16m denial field. Pro: zoning vs Mortar's precision
  ring — distinct lob shapes. Con: denial fields on heavy can stack
  with Mortar's ring for degenerate stand-turtling; watch inner
  overlap when both run at once.
- **Bombard** — the honor-duel cannon: direct-hit only, biggest
  recoil/flash. Pro: heavy's SKILL weapon — payoff scales with aim, not
  carpet; the anchor wins fights by hitting, which is the tier's most
  honest identity. Con: the edgelord pick — punishes a bad aim day;
  players who can't land direct hits should take Mortar instead, so
  its niche is real but narrow by design.

### MEDIUM_ONLY {6,14,23} — exact-class

- **Flak** — mid-size shotgun-flak. Pro: medium's brawl answer.
  Con: a hulk with a flak cannon is theme-natural — locking it off
  heavy feels arbitrary until players see the caliber ladder.
- **Cannon** — the bouncing iron ball: GL's rowdier bigger brother,
  perfectly-elastic skips + 0.5s cook-off after first bounce, 70+25
  AoE. Pro: "the comedy is the ball" — mid ordnance with a personality.
  Con: skips+pop reads close to GrenadeLauncher's job — the tier read
  must stay "fat ball, not bouncing-shell spam" or players just see a
  slower GL.
- **PlasmaGun** — mid sustained DPS repeater. Pro: sustained lane.
  Con: ~140dps paper peak on the mid-mobility frame could be
  meta-defining rather than niche.

### LIGHT_ONLY {9,12} — exact-class

- **Railgun** — precision flagship; class pays 25hp for twitch, the
  reward is aim-scaled damage. Pro: perfect incentive alignment —
  a 200hp rail sniper is unfun (Tribes heritage: laser rifle = light).
  Con: glass cannon pairs badly vs chaingun/flak spam; non-light
  players lose the weapon type entirely.
- **Lightning** — beam-tracker precision, the other aim shape. Pro:
  LG on a heavy = immovable turret — wrong fantasy. Con: weakest
  thematic rung — "precision" is about the PLAYER not the weapon, so
  the lock is feel, not caliber.

## The load-bearing choice: exact-class, not floor

A heavy cannot fire any of the five non-heavy exclusives.
- **Pro:** class = caliber, clean identity, no "heavy with everything"
  collapse, medium/light kits stay distinct.
- **Con:** least intuitive rule in the system — players will try to
  shoulder a mid-size cannon on a hulk and hit a wall the theme didn't
  prepare them for.

## Placement rules for future weapons

- Land by **size**: bombard-adjacent → heavy; deliberately mid-sized →
  medium; precision/twitch → light; otherwise universal.
- Non-oppressive niches stay universal (Sprinkler, Implodisc) —
  gating is for must-picks or class-identity breaks, not flavor.
- Watch condition (from the sprinkler writeup): if a universal weapon's
  *mobility* is what makes it abusive (hose+ski, implodisc-drag at
  speed), gate to medium as a support tool — not to light, which would
  amplify the mobility problem.

Related: `_docs/2026-10-24_SPRINKLER_CLASS_GATING.md`.
