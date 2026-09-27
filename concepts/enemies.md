# Enemy bestiary — each pressures a different axis

All enemies implement `Targetable` (`pos`, `radius`, `takeDamage`,
`applyKnockback`, health-bar hooks) so every weapon and explosion hits them
through the same combat path — zero per-enemy plumbing.

| Enemy | Shape | Pressure axis | Counterplay |
|---|---|---|---|
| **Ball** | bouncy sphere | target practice | anything |
| **Elite ball** | big violet splitter | kill-close = swarmed by children | pop it at range — free loot |
| **Crawler** | ground chaser | closes distance, pounces | kill it before contact |
| **Turretter** | plant ↔ ballistic hop | shells at mid-range | airshot the hop (2× dmg) |
| **Roller** | big rolling boulder | homing physical hitbox | shove it airborne, pop it |
| **Seeker** | airborne skull-wasp | telegraphed dart sting | dodge the 0.4s telegraph, hit the drift-off |
| **Miner** | big slow flying dredge | zone denial — drops a mine trail while circling | huge slow target — shoot it down, or sweep its mines |
| **Totem** | peak-seeking obelisk sniper | long-range flat bolts with laser-sight telegraph | strafe perpendicular, rush it (blinks away), or hit it mid-materialize |
| **Rakk** | circling cliff-racer | fold-and-swoop gliding pass, one diver at a time | dodge the committed dive, pop it on the slow climb-out |

## Design rules that emerged

- **Honest physics everywhere.** Crawler pounces, Turretter hops, bolt arcs —
  all solved ballistic launches followed by real gravity. No steering cheats.
  If the solver aimed at where you were and you moved, it whiffs.
- **Bodies vs projectiles are different.** Bodies (hop, pounce) solve to land
  exactly — a whiffed repositioning move feels broken. Projectiles are fixed
  muzzle speed with solved elevation — dodgeable, physics-governed range, no
  invisible cutoffs.
- **Asymmetric vulnerability creates the skill moment.** Turretter takes
  0.5× planted / 2.0× airborne — the reward for reading the arc is the same
  shot the game trains you for everywhere else.
- **Terrain is a participant.** Rollers gain downhill speed; turretters seat
  by footprint-conforming to the lowest sample under their base; a blocked
  firing arc triggers a reposition hop instead of a wasted shot.

## Spawning

Ring spawn around the player (60–120m depending on type), capped population,
staggered attempt intervals. Persistent stalkers — they don't despawn, they
keep coming. Demo teardown disposes all of them through `demoLifecycle`.

## Ideas not built

- **Flocker/swarm ball** — small cheap targets in groups, chain-explosion
  fodder for airshot combos
- **Sniper totem** — stationary tall thing with a slow telegraphed beam;
  forces you to keep moving perpendicular to it
- **Mirror bot** — copies your weapon, chases with your movement rules; the
  "fight a worse version of yourself" dummy for aim warmup
- **Carrier** — big slow thing that periodically poops nuggets; farming
  target with risk/reward radius
