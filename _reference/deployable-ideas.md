# Deployable ideas — what we don't have yet

Companion to `shared/deployItems.ts` (the belt-item registry) and the
base-asset roster (generator / sensor / baseturret). The current pack
covers offense (sentry, mortar, chaingun, mine), support (station, drone,
nugget, beacon) and defense (shield). The gaps are **intel, movement
counterplay, area denial, and synergy**.

## Belt items (throwable, `cap > 0`, cost belt charges)

These are planted by the player. Adding one means: a `DeployKind` + row in
`DEPLOY_ITEMS`, an entity class, a server tick + remote replica, and a
HUD counter. The facts table is mechanical; the behavior is the work.

### Intel / recon
- **Spotter beacon** — a thrown sensor. Reveals enemies in a radius on the
  minimap for its lifetime. Cheap intel tool; the base `sensor` is
  map-authored only, so there's no player-driven recon today.
- **Tripwire alarm** — no damage, pings the owner (and VGS) when crossed.
  Recon without the mine's lethal commitment; good for flanking routes.
- **Decoy / hologram** — a fake player that draws creature aggro and enemy
  fire. Classic Tribes tool; lets you bait a sentry or a turretter.

### Movement counterplay (the game's core is skiing; nothing counters it yet)
- **Caltrops / spike strip** — slows ground movement and chips feet. Forces
  a jet or a detour; the first real anti-ski tool.
- **Stasis field** — slows everything in a bubble (skiing, bolts, rockets).
  Hard counter to a base rush; high value, high cost, short lifetime.
- **Smoke screen** — blocks LOS so turrets and players can't see through.
  Counter to the chaingun's suppression and sentry rockets.

### Area denial / support
- **Wall segment** — a flat cover wall, distinct from the shield dome.
  Build a firing lane or plug a corridor.
- **Resupply crate** — burst ammo/energy on pickup (vs. station's
  continuous trickle). Rewards a push; different timing.
- **Turret overclock** — a small deployable that buffs nearby turrets'
  fire rate / range. Synergy: turns a sentry farm into a real threat
  instead of just more targets.

### Anti-air
- **Flak turret** — a sentry variant tuned for airborne targets (wider
  lead, airburst). Nothing specifically punishes jetpackers today except
  raw bullets.

### High-impact / high-cost
- **Teleporter pair** — two pads, instant travel. Strategic, expensive,
  cap 1 pair. Changes map flow.
- **Ammo turret** — fires healing/ammo bolts at friendlies. Support
  emplacement for a siege push.

## Base assets (map-authored, `cap: 0`)

These are NOT throwable — they only exist via the map spec's `deploys`
block. A "base flak turret" or "base spotter tower" is a variant of
these, authored per-map.

- **Spotter beacon** straddles both: a throwable *recon* beacon (belt
  item) vs. a map-authored *sensor* tower (base asset). Genuinely
  different things; both have value.

## Recommended first batch

1. **Smoke screen** — pure counterplay, no new fire loop, just a LOS
   blocker + visual. Low risk, high gameplay value.
2. **Caltrops** — small, self-contained, no server tick beyond a slow
   aura. Anti-ski is the biggest missing counter.
3. **Stasis field** — the hard counter; pairs with smoke.
4. **Turret overclock** — synergy piece; makes existing sentries
   interesting instead of just more of them.
5. **Spotter beacon** (belt) — fills the intel gap; cheap to build on
   the sensor's existing scan logic.

Defer teleporter (flow-changing, needs careful map design) and flak
(needs a new projectile family).

## Implementation notes

- New kinds go in `DeployKind` union + `DEPLOY_ITEMS` row. `PACK_KINDS`,
  `DEPLOY_MAX`, `DEPLOY_HP` derive automatically.
- Belt items need: entity class (with `unfold`/`dispose`/`hurt`/`v`),
  server tick in `deployTicks.ts` + `RoomDeployables`, remote replica in
  `remoteDeployables.ts`, HUD counter, and (for turrets) a fire loop +
  rocket/bolt spawn.
- Base assets need: a `remoteDeployables.ts` branch + map-spec entry +
  `roomStructures.ts` handling.
- Gunlab preview: add an `ITEMS` entry so the new silhouette is
  inspectable; call `bakeWearOnly` on the proxy for visibility.
- Collision: set `bodyR`/`bodyH` and add to `deploySolid` (or
  `NOSOLID`) so prediction matches.