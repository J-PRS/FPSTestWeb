# Enemy archetype gaps — what the bestiary is missing

Reference doc: our roster vs. the canonical FPS creature taxonomy
(Doom, Half-Life, Quake, Serious Sam, Deep Rock Galactic, L4D, Zerg).
Purpose: pick future species by the *role they add to a fight*, not by
cool silhouette. An enemy is a verb the player must answer.

## Current coverage

| Archetype | Ours | The verb it demands |
|---|---|---|
| Melee swarmer | crawler, scarab | aim fast, don't get surrounded |
| Loot piñata | grub | free damage → reward |
| Ambusher/pouncer | snake | juke the committed lunge |
| Air harasser | gnat | track a small fast thing |
| Dive-bomber | rakk, seeker | look up, lead the dive |
| Strafing ranged | strifer | read the orbit, intercept |
| Charge tank | roller | sidestep the line, punish recovery |
| Suicide exploder | baneling | kill it at range, or kite the fuse |
| Sniper | totem | break the aim-beam LOS |
| Static gunner / trap | turretter, mine | route around, or spend a shot |
| Boss | overlord | sustained DPS + mechanics |

## The gaps (ranked by design value)

### 1. Ground spitter — the top gap

Canon: Doom imp, HL bullsquid, DRG webspitter/acidspitter, Serious Sam
scorpion. Every ranged creature we own flies or teleports; nothing
pressures a skiing player from the dirt.

- **Fight verb**: the mortar is *lobbed* — dodgeable at range, lethal in
  a landing zone. It denies ground the way a player's GL does, which no
  creature currently mirrors back at us.
- **Reads**: visible windup (throat swell), arcing projectile with a
  telegraphed landing splash — our projectile/impact pipeline already
  does arced shells + AOE telegraphs for free.
- **Family fit**: new row on an existing sim (stationary-ish variant of
  'hop', or a 'spit' family if it needs kite-back behavior). Attack is
  a bolt edge — same wire vocab the totem already uses.
- **Effort**: low. Bolt visuals exist (spawnBolt), arc sim exists,
  telegraph = splatDecal-style projected ring at the landing estimate.

### 2. Grabber/trapper

Canon: HL barnacle, L4D smoker, DRG cave leech, Quake vore (homing
spikes). Immobilizes or drags the victim.

- **Fight verb**: breaks the movement loop — the one thing the player
  is good at (skiing) gets *removed* until they free themselves.
  Nothing in the roster does that.
- **Reads**: a tongue/tendril tether, a visible struggle window, an
  escape mechanic (shoot the tether or the owner).
- **Family fit**: reuse `applyPull`/`applyKnockback` plumbing — the
  victim-facing mechanic exists already for mine/tether effects.
  Sim side needs a channel/grab state; the wire already supports
  STATUS bits (a GRABBED flag would be one new bit).
- **Effort**: medium — tether visual (RibbonTrail exists) + a sim
  latch state + server-side release rules.

### 3. Spawner/breeder

Canon: Doom pain elemental, DRG naedocyte breeder/Brood Nexus, HL
gonarch. Threat = it makes more enemies.

- **Fight verb**: *priority targeting* — the first enemy that punishes
  you for shooting whatever's closest. Changes fight math, not just
  fight shape.
- **Reads**: a slow armored carrier that periodically births a clutch
  of smalls (scarabs? gnats?) — the bloatgrub already proves the
  on-death-birth pattern; this is on-*life* birth.
- **Family fit**: spawn hooks already exist (elite split births via
  `onDeath`; creatureSim spawns eggs/clutches on map spec). A breeder
  is a slow 'hop'/'totem' variant whose wound-up "attack" emits spawn
  events instead of damage.
- **Effort**: medium — the hard part is pop-cap discipline (a breeder
  must respect the room's creature budget or it snowballs).

### 4. Support — healer/buffer/reviver

Canon: Doom arch-vile (resurrects the dead — the single most feared
enemy in its game), DRG warden (damage-buff aura), Medic-style healers.

- **Fight verb**: same priority-target pressure as the breeder, from
  the other direction: it undoes your work. Shoot it first or the
  scarabs never die.
- **Reads**: a visible link/beam to the creature it's buffing —
  RibbonTrail or the LG beam visual, already cheap. An aura ring is
  one projected fieldRing decal — that primitive exists too.
- **Family fit**: a fragile 'hop' that stands off at orbit range;
  sim just needs a `healTarget` step + wire edge (creature-heal is a
  new edge kind — one field on the existing creature-event vocab).
- **Effort**: medium-low. Highest design-per-dollar after the spitter.

### 5. Stalker

Canon: DRG stalker, L4D hunter (invisible-while-crouched reads),
predator archetype everywhere.

- **Fight verb**: threat you can't see — forces listening, checking
  shadows, watching the shimmer. Bots already can't aim what's
  cloaked (`STATUS.CLOAK` is on the wire and respected).
- **Reads**: cloaked stalk-circling at range, uncloak telegraph at
  pounce distance — the snake's lunge commit is the skeleton for the
  payoff half.
- **Family fit**: 'slither' or 'hop' + a cloak state + one sim rule
  (uncloak inside pounceD). Most of the machinery exists.
- **Effort**: medium. Needs a decent cloaked-render (fresnel shimmer
  or full skip) — the swarm already does per-instance color, so a
  low-alpha shimmer is cheap.

### 6. Wall/ceiling crawler — noted, not recommended yet

Canon: HL headcrab-on-ceiling, Quake spawn, DRG wall glyphids. Iconic
but needs interior/ceiling queries (hmHeight has no overhang model);
the open-terrain maps make it marginal. Revisit if interior-heavy
maps land.

## Recommended build order

1. **Spitter** — cheapest, fills the largest hole (ground-ranged).
2. **Support/healer** — smallest sim work for the biggest fight-math change.
3. **Grabber** — the scariest archetype; `applyPull` + RibbonTrail give it a head start.
4. **Breeder** — needs pop-cap rules before it's safe to ship.
5. **Stalker** — fun but the least load-bearing; cloak infra mostly exists.

## Wire/sim notes for whoever builds these

- New species = one `SPECIES` row (data, not class) + a `SWARM_SPECS`
  parts entry + pose module. A new *family* = one sim module +
  `SPECIES_FAMILY` entry — no if-chains (see species.ts header).
- Attack edges reuse the existing vocab (windup/pounce/bite/spawnBolt);
  grab/support need one new edge kind each — keep it data-shaped like
  the others.
- Every candidate above stays inside the instanced-swarm + state-edge
  rules: no position streams, no per-creature meshes, no client-owned
  outcomes.
