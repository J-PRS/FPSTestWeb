# Weapon Duel Simulation Report — 2026-10-03

Seeded bot-vs-bot duels through the real server stack: real `Room`, real
`ServerBots` brains (target acquisition, band weapon select, humanized aim
scatter/lead, volley cadence), real `RoomProjectiles` flight, authoritative
`applyDamage` deaths. Two harness modes:

- **Pinned** (`pin()` each tick): stand-and-deliver — isolates weapon
  efficiency at a controlled range.
- **Free** (`_freeduel.ts`): pin once at spawn, brains own the bodies —
  measures the real duel including dodges, disengages, and chip-through.

Scratch runners: `server_bun/tests/scenarios/_cgduel.ts`,
`_mrvduel.ts`, `_freeduel.ts`. Draw = 20 sim-s of damage inactivity
(hard cap 180 sim-s / 10s realtime guard).

## Honest accuracy (shotId correlation)

`playerHit` now carries `shotId` — the server projectile id (`proj_N` /
`sp-N`) joining each damage event to its `projectileCreated`. A "connect"
= a shot that produced ≥1 damage event, so a 6-bomblet MRV volley counts
once, not six. Prior per-damage-event counting inflated volley weapons.

Plumbed through: `protocol.ts` playerHit field → `applyHit` opts →
`hitLedger` broadcast; `serverHit`/`botAttack`/`serverBlast`/`processAOE`/
`splashOne` all pass `ctx.shotId`; `RoomProjectiles.detonate` supplies
`proj.id`; claim paths resolve the ledger id from `msg.projectileId ??`
`idForClientShot(msg.shotId)`; `aoeCluster` bomblets credit the carrier.

## Server-side cluster fix (found + fixed this session)

`RoomProjectiles.detonate` never ran the bomblet scatter — `aoeCluster`
only lived on the client `aoeShot` claim path, so **bot-fired MRV and
ClusterBomb shipped only the weak carrier pop** (MRV: 30 direct / ~11
splash). Fixed: detonate now scatters `cluster.count` bomblet
`serverBlast`s on the burst plane, seeded by `room.rng` — identical shape
to `aoeCluster`, deterministic under scenario seeds.

MRV 25m damage per duel jumped 310 → 1341 post-fix.

## Results

### Chaingun vs PlasmaGun (pinned, 8 seeds/dist)

| Dist | CG | PG | | CG acc | PG acc |
|---|---|---|---|---|---|
| 10m | 0 | 8 | | | |
| 25m | 0 | 8 | | | |
| 43m | 0 | 8 | | | |

Clean sweep. CG ~89 dps @ 0.5m wake vs PG ~108 dps @ 1.2m wake + 2.5m
pop. Pinned targets erase CG's only edge (flight time vs movers).

### Chaingun vs Sprinkler (free movement, 8 seeds/dist)

| Dist | CG | SP | CG acc | SP acc |
|---|---|---|---|---|
| 10m | 1 | 7 | 42% | 71% |
| 25m | 0 | 8 | 34% | 50% |
| 50m | 0 | 6 | 19% | 25% |
| 75m | 0 | 7 | 17% | 23% |
| 100m | 0 | 7 | 11% | 18% |

Sprinkler wins every band even vs moving targets. CG's accuracy decays
faster with range; its per-hit payoff (~10.8) doesn't cover connecting
half as often. **CG needs a niche**: `directDamage` 8→9 and/or `hitMax`
0.5→~0.9 would show directly in the acc column.

### Mortar vs MRV (pinned, pure loadouts, 8 seeds/dist)

Mortar buffed to 120 direct / 100-80-40 splash (`aoeScales`
[0.833,0.667,0.333] on 18m) + bombardier perk. MRV numbers pre-date the
server bomblet fix — its long-range bomblets airburst too high to reach
deck-level targets anyway.

| Dist | MOR | MRV | MOR acc | MRV acc |
|---|---|---|---|---|
| 25m | 6–8 | 0–2 | 70% | ~50% |
| 43m | 1 | 7 | 89% | 45% |
| 75m | 2 | 6 | 83% | 56% |
| 100m | 0 | 8 | 81% | 71% |

The paradox: mortar out-connects AND out-damages MRV at 43m+ yet loses
the win column. Diagnosis: kill timing — mortar's 2.0s cadence dribbles
damage (regen eats between-shell progress) while MRV's steadier blast
cycle lands inside the kill window. It's burst-vs-dribble, not accuracy.

## Open questions / candidates

- Mortar cadence 2.0→1.6s or speed 55→65 to convert its accuracy lead.
- Server MRV bomblets scatter at burst-point altitude — a grounded
  bomblet *fall* sim (real child projectiles) would extend its reach
  past airburst-height limits. Currently claim path and sim path both
  blast on the burst plane — consistent, but high airbursts waste rain.
- Class tier locks (HEAVY_ONLY / MEDIUM_ONLY / LIGHT_ONLY exact-class)
  now gate every claim path; `tierLock.test.ts` covers the matrix.
