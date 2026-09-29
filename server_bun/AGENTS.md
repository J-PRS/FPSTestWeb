# server_bun — Agent Guide

The authority. If a client's claim and the sim disagree, the sim wins.

## Commands

```bash
bun test                    # gate: must stay green before commit
bun test tests/scenarios/   # staged gameplay interactions
bunx tsc --noEmit
bun src/server.ts           # run (FPS_PORT, FPS_MAP, FPS_SBOTS,
                            # LOG_LEVEL, FPS_MOVE_AUTHORITY, FPS_ICE_SERVERS)
```

## Map

- `Room.ts` — match container; wires sims + the damage funnel.
- `CombatHandler.ts` — every player-claim validator → `claimLedger`.
- `RoomProjectiles/BallSim/CreatureSim/RoomMoveSim/RoomFlags/RoomPickups/
  RoomDeployables/ServerBots` — the authoritative sims; edges out.
- `MessageHandler/connections` — validation → sim → broadcast.
- `tests/scenarios/` + `harness.ts` — one staged interaction per file.

## Rules

- Every damage/despawn path funnels through one place — no private
  health writes; `applyDamage` is silent, callers emit the wire events.
- Sims step deterministically: no `Date.now()`/wall-clock decisions;
  tests drive `step(dt)`. Respawn timers are the known wall-clock edge.
- `bun --watch` does NOT reload `../shared/` — restart for shared edits.
