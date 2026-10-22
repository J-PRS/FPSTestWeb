# Unifying offline vs multiplayer entity logic

**Status (2026-10-17):** all wire-visible species + balls converted.
Offline entities now ride the same shared sims the network replays —
the parallel hand-rolled physics/AI paths are deleted, not kept.

## The shape

Every converted entity owns **one sim instance** created in its
constructor:

```ts
// ctor — local authority default
this.sim = makeSimCrawler(this.id, { x, y, z }, uber, this.id, 'scarab');
this.health = this.sim.health;
this.maxHealth = this.sim.maxHealth;
```

`bindNet()` **overwrites** `this.sim` with a wire-bound sim when a server
creature claims the id — one field, two owners, never both.

`update()` splits once:

```ts
if (this.netDriven && this.sim) { this.updateNet(dt, terrain); return; }
// local authority leg
if (s) {
  commitTarget(s, 'local', playerPos);          // live pos — no link lag
  const ev = updateLocalSim(this, dt, terrain, stepCrawler, playerPos);
  if (ev === 'bite') { this.onBite?.(this); }
  if (s.dead) { this.dead = true; return; }
}
```

- **`updateLocalSim`** (`client/src/game/netMelee.ts`) — sibling of
  `updateNetSim`. Steps the shared fn with `authoritative=true` + live
  target, mirrors `pos`/`vel`/`yaw`/`health`/`dead` back to the entity,
  returns the sim event (`'bite'`, `'detonate'`, `'fire'`, …). Optional
  `{ grounded: true }` derives `airborne` from terrain height.
- **`commitTarget(s, 'local', playerPos)`** — offline has no committed-
  snapshot lag; the target is just the live position each frame.
- **Events → callbacks**: sim events fire the entity's existing callbacks
  (`'bite'`→`onBite`/`onNip`/`onStrike`, `'pounce'`→`onDive`,
  `'fire'`→`onSimFire` + local beam resolve, `'detonate'`→`detonate()`).
- **Damage** goes through `applyXDamage(sim, damage)` — health, stun-pin,
  intangible-blink checks live in the sim, not the entity.
- **Knockback/pull** write `s.vx/s.vy/s.vz` + `s.stunTimer` directly —
  writing entity `vel` alone gets overwritten by the sim mirror next
  frame.

## Converted

| Entity | Sim | Entity-side leftovers |
|---|---|---|
| Baneling | `makeSimBaneling`/`stepBaneling` | belly-drop/punt ballistic leg (sim pins to terrain), roll/glow |
| Crawler | `makeSimCrawler`/`stepCrawler` | emerge sink, windup squash pose, matriarch brood hook |
| Scarab | same family, `species='scarab'` | `biteCd` callback gate, emerge |
| Roller | `makeSimRoller`/`stepRoller` | blast-punt airborne leg (sim rides surface) |
| Snake | `makeSimSlither`/`stepSlither` | trail/spine pose, `windup`/`lunge` render flags, emerge |
| Gnat | `makeSimFlyer`/`stepFlyer`, `'gnat'` | `cloud` field kept for flyers.ts lifecycle only |
| Rakk | `stepFlyer`, `'rakk'` | `state` pose mirror, bank/pitch dressing |
| Totem | `makeSimTotem`/`stepTotem` | `materialize` grow-in (no sim state), `blastFizzle` (spends shot budget → sim relocates itself), foot conform |
| Ball | `makeSimBall`/`stepBall` via `netS.sim` | `dressSegment` maps `SegmentKind`→burst/keyframe; `ballRage.ts` is emissive dressing only |

Deleted wholesale: `totemFsm.ts`, `totemBeam.ts`, ~240 lines of
`ballRage.ts` physics, and each entity's parallel update internals.

## Flags that moved to shared

`BALL_ENRAGE_ENABLED`/`setBallEnrage` moved into `shared/ballSim.ts`
(the `?mode=classic` docile rule — `groundContact` gained
`authoritative`+`rand` for the teleport fallback). `config.ts`
re-exports them — same callsites work. Same pattern as `setBallSlide`.

## Deliberate behavior deltas

- Gnat nip pacing: cloud-wide `nipGate` → sim's seeded per-gnat
  `diveCooldown`.
- Rakk `attackHeldBy` "one diver at a time" token removed — the wire has
  no such lock; seeded cooldowns space dives.
- Scarab's offline-only uber dash gone (sim doesn't model it).
- Offline target = live playerPos every frame (zero lag by design);
  wire entities still chase committed `tp` snapshots — aim staleness on
  the wire is intentional.

## NOT unified (honest edges)

- **Seeker, Strifer, Grub, Tumbleweed, Nugget** — no `SPECIES` registry
  row, no wire contract. Offline-only by design; making them wire-capable
  is a feature decision (new rows + edge vocab), not unification.
- **Bot bodies** — offline `GameBot` drives `RemotePlayer`; server bots
  drive `MoveSim` shadows via `ServerBots`/`botDrive`/`botMpc`. Shared
  `BotBrain` already unified; the body/driver split needs real decisions
  (prediction feel, blast response). Biggest remaining item.
- **Projectiles** — `Projectile.ts` is intentionally cosmetic; server
  `RoomProjectiles` + `shared/projSim.ts` is wire truth with documented
  simplifications. Low value to merge.
- **Damage funnel** — offline `botHit` resolves locally (no claim→
  adjudicate→ledger); deliberately different pipeline, same constants.

## Recipe for a new species

1. Add a `SPECIES` row (`family` picks the sim module).
2. Entity ctor: `makeSimX(...)` + health/maxHealth off the sim.
3. `bindNet` → `bindNetSim`; `applyNetEdge` → `applyNetEdgeSim`.
4. `update()`: netDriven → `updateNetSim`; else `commitTarget` +
   `updateLocalSim`; map returned events to entity callbacks.
5. `takeDamage` → `applyXDamage`; knockback → `s.v*`/`s.stunTimer`.
6. Delete the old physics/steering/timer internals. Keep only: visual
   dressing, spawn/emerge presentation, callbacks, and any ballistic leg
   the sim genuinely doesn't model (document why in a comment).

Verify: `cd client && tsc --noEmit && vitest run`; `cd server_bun &&
bun test` when `shared/` moves.
