# Local projectile spawn: live muzzle vs rewind-mirrored

2026-10-23. Status: **decision doc** — live-muzzle spawn shipped; the
mirrored approach is documented here because it was tried, it worked for
one metric, and it broke feel. If trajDiv regressions force a revisit,
the last section names the correct fix.

## The mechanism (what shipped then reverted)

Server-simmed weapons (`serverSimmed(wt)` — disc/grenade/mortar class)
have *two* birth epochs:

- **Server**: `rewindPos(0.7·transit)` — where your *shadow* was when the
  fire claim plausibly left your machine — plus shadow-vel inherit
  (`CombatHandler`/`RoomProjectiles.spawn`).
- **Client (mirrored, ab22b488→86783855 era)**: `mirroredSpawn(
  localPosHistory, rtt)` = your own position `0.35·RTT` back, so the
  predicted shell and the authoritative shell shared an arc.
  `p.renderOffset` blended muzzle→rewind visually over ~150ms
  (τ=50ms exp decay in `Projectile.update`).

## Why mirroring existed

Without it, the predicted shell flew the live muzzle's arc while the
server's flew the rewound one — two shells diverging by `vel_inherit ×
0.7·transit`. Symptoms were `bind:-1` traj-outliers (the server echo
couldn't fuse with a local shell already on a different line) and
"numbers, no damage"-adjacent confusion on WAN links.

## Why it was reverted (the feel bug)

The mirror made the **spawn point a function of ping**:

| RTT | Ski speed | Sim spawn offset behind muzzle |
|---|---|---|
| 30ms | 10 m/s | ~10cm — invisible |
| 80ms | 30 m/s | ~0.85m — visible slide |
| 150ms | 40 m/s | ~2.1m — shell births at your back |

The renderOffset blend covers the pop but the shell still visibly slides
forward onto a different line during the first ~150ms of flight — reads
as "networking is touching my gun." Player report matched exactly.

## What's live now

`spawnProjectile` always uses `_spawnOrigin` (live muzzle + MUZZLE_LEAD)
— identical to the offline path. `p.mirrored` stays false.

**Retained deliberately:**
- `mirroredSpawn()` + `histAt()` — still used by
  `net/projectiles.ts` `sweepLocal` (remote shells judge *our* body at
  the ghost epoch) and `__tests__/mirroredSpawn.test.ts`.
- Server-side rewind birth is unchanged — the authority still does what
  it does; only the client copy stopped pretending.

## The trade to watch

Live-muzzle spawn reopens the divergence the mirror closed — resolved
later the same day by the claim-driven server birth: the authoritative
shell now spawns at the **claim's own `pos`** (bounded by `rewindNearest`
to ≤3m of a recorded body sample in the uplink window — teleported-muzzle
lies clamp, not pass) aged by the **measured uplink** (`lagS` =
`wallNow − fireAt`, already wired). No transit estimate survives in the
spawn path.

Watch `bind:-1` traj outliers / `traj-epoch` misses on WAN — if they
rise, both shells should now be *identical arcs modulo interpolation*,
so any residual is an echo-bind problem, not a spawn-epoch problem.

**`shooterTransitMs` + `sweepLocal` both fixed the same day:**
`shooterTransitMs` halved an already-one-way EMA — every lag-comp caller
(beamSweep/blast/body-sweep ghosts, melee origins) under-rewound by half
the real uplink; now the measured channel passes verbatim and only the
RTT fallback halves. The client's `sweepLocal` dropped `0.35·rtt`
entirely: the server's ghost-back for our body is
`shooterUplink + shooterViewLagOfUs − ourUplink`, which under symmetric
links reduces to **the shooter's viewLagMs — measured locally on that
remote** (fallback: own ping/2). `mirroredSpawn` is gone with it;
`histAt(hist, backMs)` is the exported epoch sampler its tests now pin.

**Instant-attack origins went claim-driven the same day:** the last
`rewindPos(shooterTransitMs)` estimate-shaped origins — melee sweep,
LG/lance `beamSweep` muzzles, `repairTarget` rays — now use
`CombatHandler.claimOrigin`: the claim's own `pos` bounded by
`rewindNearest` to ≤3m of a recorded body sample in the measured-uplink
window (`uplinkMsOf` = `wallNow − fireAt`, already stamped on every
`sendShotFired`), else clamped to history. The client sends `pos` on
melee + fan/beam `shotFired` intents (`fireAt` was automatic). The
shell-spawn site folds onto the same helper pair. `shooterTransitMs`
survives only where it belongs — victim-side ghost rewinds in
`combatBlast`/`projContact`/`beamSweep` judging what the *shooter saw*
of a *victim* (claims don't describe the victim). Pinned:
`server_bun/tests/claimOrigin.test.ts`.

## Pointers

- Spawn: `client/src/game/combat/fire.ts` `spawnProjectile` (~L96)
- Rewind mirror helper: `mirroredSpawn`/`histAt` in same file (~L68-86)
- Blend machinery (still used by remote shells + reanchoring):
  `Projectile.renderOffset`/`rendered`, decay in `Projectile.update`
- Remote-shell sweep ghost: `net/projectiles.ts` `sweepLocal` (~L223)
- Server birth/origin bound: `CombatHandler.claimOrigin` +
  `uplinkMsOf`; rewind helpers in `server_bun/src/claimLedger.ts`
- Commits: `ab22b488` (mirror in), `d86650e3` (blend), `cdcefaf2`+`86783855`
  (the +1.6 muzzle dance — now pos.y IS the eye per the crosshair spawn fix)
