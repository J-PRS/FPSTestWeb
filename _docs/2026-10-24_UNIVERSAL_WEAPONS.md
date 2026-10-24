# Universal (non-class-locked) weapon rundown

Reference for the shared arsenal — every weapon **not** in
`HEAVY_ONLY_WEAPONS` / `MEDIUM_ONLY_WEAPONS` / `LIGHT_ONLY_WEAPONS`
(`shared/botClasses.ts`). Companion to `2026-10-24_CLASS_WEAPON_LOCKS.md`:
the tier ladder governs slot-gun caliber; this pool is the baseline every
class stands on. All numbers verified against `shared/weaponRows.ts` and
`shared/weapons.ts` (2026-10-24).

Two shared economies matter for reading the rows:

- **Belt pool** (`weapons.ts`): `BELT_MAX 5`, `BELT_THROW_COST 1` per toss,
  Satchel costs 2. Every belt throw and pack deploy draws the same nuggets.
- **Airtime scaling** (`weapons.ts`): BoltLauncher, Disc, Implodisc,
  BeltDisc and Javelin pay `direct × min(4, 1 + airtime)` — +50% per 0.5s
  of flight, 4× cap at 2.0s. Direct line only; splash stays flat.

## Slot weapons

### BoltLauncher (0) — the spinfusor bolt

50 direct + 15@8m, 120 m/s, arced, airtime-scaled. The icon and the alpha
skill shot — a led bolt at 2s pays up to 200.

- **Why universal:** the game's signature. Gating it behind a tier would
  gate the genre itself.
- **Pro:** every class shares the alpha threat; the duel grammar (lead,
  arc, MA discipline) transfers everywhere.
- **Con:** so central that other primaries read as "not the bolt" — the
  universal pool's own slots compete with it for attention.

### Disc (1) — the disc-jump launcher

50 + 15@10m, kb45 — strongest launcher shove, flat flight, airtime-scaled.

- **Why universal:** it's a movement lever first. Blast-jumping is core
  tech; gating it breaks the mobility economy for two thirds of the
  roster.
- **Pro:** the skill-expressive weapon — its ceiling is the player's
  movement, not the damage row.
- **Con:** picked for mobility, so its *damage* slot quietly competes
  with the player's own jump tech. kb45 also means disc-jumps are equally
  strong on the 200hp anchor — heavy discs uphill almost as well as light.

### Chaingun (3) — the honest spray

8/slug ≈ 89dps, hitscan-easy; forgiving wake (hitMax 2 → 1m proxy by
~125m), 375m reach.

- **Why universal:** the shared DPS floor — every class needs a reliable
  duel gun that doesn't ask for arc math.
- **Pro:** the consistency anchor; it's the yardstick niche sprays are
  measured against.
- **Con:** if it's too reliable it eats the niche tiers' lunch — Flak and
  PlasmaGun exist to beat it *situationally*, and lose their reason if
  they can't.

### GrenadeLauncher (5) — the skipping shell hose

50 + 20@13m, 60 m/s, skips off dirt (restitution 0.55), `bodyArmTime 0` —
pops on a body at any age, needs 1s of terrain-cooking to airburst.

- **Why universal:** the "loose" AoE — corridor spam and jumpshot lobs
  are a baseline verb, not a class privilege.
- **Pro:** high-variance fun; bounce chaos rewards geometry reads.
- **Con:** the classic mobility-hose precedent — GL + light skiing is the
  combo to watch (same watch-condition as Sprinkler).

### Sprinkler (25) — the arced bolt hose

12 + 5@3m per bolt at ~10/s — ~140dps on paper, every bolt arcs under
gravity in a slight cone. Saturation, not precision.

- **Why universal:** area-denial niche, dodgable bolts keep it honest —
  gated only if hose+mobility proves oppressive (see
  `2026-10-24_SPRINKLER_CLASS_GATING.md`).
- **Pro:** gives light/medium a denial tool without touching heavy's
  ordnance monopoly.
- **Con:** paper DPS is the highest sustained in the pool — if arc
  dodging isn't enough counterplay, it's the first universal that becomes
  a lock candidate.

### Sticky (18) — the chain-detonation glue launcher

80 direct + 35@11m, 0.8s cadence, 3s fuse, sticks on contact. **The chain
is the weapon:** a detonation cooks every live sticky in radius — at 0.8s
cadence a player stacks ~3 before the first pops, so a cluster is one
triple-strength overlapping blast.

- **Why universal:** trap/siege utility open to all frames.
- **Pro:** the setup weapon — pre-planted stacks reward foresight, and
  the chain makes geometry (doorways, stands) matter more than aim.
- **Con:** the most borderline universal in the roster — an 80dmg
  ordnance-flavored gun on every class. A light that pre-stacks a route
  then chains it on contact plays heavy's denial game at light speed.

## Sidearms

### Pistol — 14dmg panic slug. The honest fallback; exists to not be
picked. Dead design space unless it has a draw-speed niche.

### Revolver — 34dmg hand cannon, ~3 hits to kill at slow cadence. The
alpha sidearm. Competes with Shocklance for the "one big pocket hit"
niche.

### Shotgun (13) — 10 pellets × 7 ≈ 70 point-blank, tighter cone than
Flak's lob. The mid-band scattergun to Flak's doorway — and the *reason*
Flak can be medium-locked: the universal shotgun is the floor so
non-mediums aren't disarmed.

## Melee & skills

### Melee (10) — power punch, 55 cone @3.2m. Universal disrespect button.
Note: punch damage doesn't scale with class mass — punch-heavy is
secretly good.

### Shocklance (38) — pull-out zap, 70dmg hitscan at 18m, 2s cadence
(`LANCE_RANGE`/`LANCE_CADENCE_S` shared constants). The pocket
obliterator on cooldown. Weakest "universal-feeling" fit — if it ever
gets an energy economy it migrates naturally to light.

### Slam (8) — Q-skill ground AoE (35dmg, 9m). A skill, not a slot —
universal by construction.

## Belt throws (BELT pool, 1 nugget each)

### Grenade — 50 + 20@13m, 1.5s fuse that **never arms** (armTime ==
lifetime): bodies phase through, dirt only bounces it. The honest timed
explosive — timing skill, never a panic pop.

### ClusterBomb (19) — belt MRV: carrier 30+15@8m pops at 1.6s and
scatters 5 bomblets (15+12@6m each) in a 9m footprint. Denial rain from
the belt — asymmetric by class (heavy's version is a slot, light's is a
toss), which is the right asymmetry.

### Javelin — 60 direct, no splash, 120 m/s, kb26, airtime-scaled. The
trick-shot throw — the skill IS the payload. Belt-priced bolt for
everyone.

### ImpactGrenade (21) — contact-fused blast: 60 + 20@5m, **kb45 = the
biggest shove in the belt**. A real kill tool whose shove is the bonus —
the row is heavier than its "low damage" table comment suggests.

### RemoteRailgun (24) — capacitor slug, NOT remote-triggered: flat 40 m/s
flight (`inherit: 0` so the beam goes where you pointed), then at 0.4s
discharges a hitscan rail down its velocity line — 70 + 25@7m, 160m ray.
The readable cap-to-discharge window is the counterplay. Belt-priced
railgun with a dodge window.

### ArmorGrenade (27) — 40 sting @10m, plates **everything** it catches
with 50 armor — including enemies. Arming the enemy is the explicit cost
of plating your own push; misthrows are self-owning.

### HealGrenade (31) — 12 sting @6m to enemies, **60 flat heal** to allies
caught. The support burst; pairs with HealBeam (0 dmg hitscan, ~40hp/s,
costs the healer's jet energy — 6/tick).

### ProxyGrenade (32) — 35 + 30@6m, 1s fuse, proximity bubble inflates
0→4m over its life — the closer to the pop, the wider the net.
Toss-and-zone: cooks off the moment anyone wanders in.

### SatchelCharge (33) — the objective killer: **150 + 130@17m**, kb75 —
the biggest belt blast and the overall damage record (bigger than
Bombard's 140). Speed 10 = hand-plant only, `hitMax 0` (no wake — sticks
on true contact), 4s fuse, **costs 2 nuggets**. You have to BE there —
that's the counterplay.

### Concussion (34) — T2 conc: tiny sting (15+8@9m) but **kb55**, strips
the flag, drains 40 jet energy. Never arms — phases through bodies. The
blast is a strip, not a kill: the fumble and the tank-bite are the
payload.

### EMP (39) — 0 damage @12m, drains ALL jet energy + strips shield. Never
arms, timer-only so it can't be a contact weapon. On light it's the hunt
tool — jets off a fleeing target is a kill sentence.

### Implodisc (11) / BeltDisc (40) — the belt disc pair: same 50+15@10m,
80 m/s flat flight as the launcher disc, but belt-priced with a 0.25m
contact-only proxy and airtime-scaled direct. Implodisc pulls (kb25 pull
into the blast — the setup throw), BeltDisc pushes. Two textures of the
same shell.

### BeltSticky (36) — hand-lobbed glue bomb: 45 direct (weaker than the
launcher's 80) + 35@11m, speed 20 — a third of muzzle velocity so it
*hangs catchable*: `rides: true` means your own shell can swallow it
mid-flight and carry it to the target (the Painkiller combo). Its own
WeaponType so the wire can charge the toss.

### Hook (37) — rope dart, 0 damage: body hits reel the victim toward you,
terrain hits reel you to the anchor. kb18 flat pull ≈ half a good disc
jump, 110 m/s, 0.45s life ≈ 50m of rope. The movement-grapple on every
frame; victim-reel + shotgun/lance is the gank combo to watch.

### Repair — hitscan weld, 6dmg sting vs creatures, real payload is
`REPAIR_HEAL_PER_TICK` (5/tick ≈ 50hp/s) into friendly deployables,
overflow banking to 2× base hp as armor. Technician is a role, not a
class. Watch: heavy+repair turtle loops on stands.

## Placement rules (for future weapons)

1. **Slot guns land by caliber** — see the class-lock doc. Universal slot
   candidates are signature weapons (Bolt), shared-DPS floor (Chaingun),
   mobility levers (Disc), or deliberately loose/utility shapes (GL,
   Sprinkler, Sticky).
2. **Belt throws are universal by default** — the nugget economy is the
   shared pool; a belt item has to *prove* it belongs to a tier.
3. **Watch-condition for every universal:** does it combine with mobility
   or with the wrong class's fantasy? GL/Sprinkler/Implodisc/Hook/EMP all
   live under "universal until proven abusive." Sticky is the standing
   borderline — ordnance damage on every frame.
4. **Support tools stay universal** — Repair/HealBeam/ArmorNade/HealNade
   are roles; locking a role to a class makes the class mandatory.
