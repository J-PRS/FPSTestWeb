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
- `CombatHandler.ts` — outcome adjudication (intents, respawn, killFeed).
  Combat claims are refused on dedicated (`claimsAccepted=false`); the
  residual `claimLedger` path stays for P2P hosts + ambient heals.
- `RoomProjectiles/BallSim/CreatureSim/RoomMoveSim/RoomFlags/RoomPickups/
  RoomDeployables/ServerBots` — the authoritative sims; edges out.
- `MessageHandler/connections` — validation → sim → broadcast.
- `wire.ts` + `shared/worldModel.ts` — every entity kind declares its
  wire shape once; emits generate, inbound packets/intents/envelopes
  shape-check at dispatch. New fields go in the declaration, not
  hand-built payloads.
- `tests/scenarios/` + `harness.ts` — one staged interaction per file.

## Rules

- Every damage/despawn path funnels through one place — no private
  health writes; `applyDamage` is silent, callers emit the wire events.
- Sims step deterministically: no `Date.now()`/wall-clock decisions;
  tests drive `step(dt)`. Respawn timers are the known wall-clock edge.
- `bun --watch` does NOT reload `../shared/` — restart for shared edits.
