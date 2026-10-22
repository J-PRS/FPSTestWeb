# FPSWebTest Architecture Review

**Date:** 2026-09-27
**Scope:** Server (`server_bun/`), shared simulation (`shared/`), protocol design, anti-cheat posture, bandwidth model. Client surveyed at file level only.

---

## Executive Summary

This is a well-architected browser multiplayer FPS prototype that is **further along than typical for its stage**. The server is properly authoritative where it matters (combat), pragmatically client-trusting where it doesn't (movement), and the networking design — binary wire protocol, interest tiers, dead-reckoning suppression, deterministic segment-event creature replication — shows a real understanding of the constraints that killed every Tribes-like that came before.

**Verdict:** the engineering bets are the right ones for the "Krunkerized Tribes" thesis. Main risks are architectural drift (main.ts monolith, lenient claim paths that harden into exploits later) and the known structural problem — the project needs population from day one, which PvE creatures correctly hedge against.

---

## What Is Genuinely Good

### 1. Server-authoritative combat, client-authoritative movement — the right split
`CombatHandler`/`shared/combat.ts` implement projectile-tracked hit claims: the server records each spawned projectile (origin, velocity, spawnAt), then `validateHitClaim` checks that a claimed hit is ballistically reachable in the claimed airtime (v·t + ½g·t² + inheritance margin) and within the legal wake radius of the target capsule. `validateAoeClaim` does the same for detonation points.

This is meaningfully beyond what Krunker and Narrow.one shipped — both run largely client-trusting combat and are chronically plagued by cheaters. The tolerances are honestly labeled as anti-cheat slack (3m target slack, 0.5s airtime slack, 15m reach margin) rather than pretending to be correctness bounds.

### 2. The BallSim replication model is the standout design
`server_bun/src/BallSim.ts` + `shared/ballSim.ts`: balls are simulated once on the server, once on each client, against a shared heightfield, and the wire carries only **velocity-discontinuity events** (bounce/lunge/enrage/teleport/hit segments) plus periodic resync. ~2.4 KB/s for 40 creatures vs ~30 KB/s for a position stream. The RNG-bearing branch (teleport) is authority-only; predictors drift and snap on the next event — correct handling.

This is the same philosophy as lockstep/deterministic networking, and it's exactly right for browser transport (WebSocket, no UDP, bandwidth-precious).

### 3. Bandwidth engineering is measured, not guessed
`GameServer.startTickBroadcast` does delta compression against *client-side dead reckoning predictions* (skip records within extrapolation tolerance), distance-tiered interest management (150m / 400m / 1/10 rate), forced sends during knockback windows, stale-heartbeat handling, and — critically — a metrics rollup logging actual kbps so the optimizations report their real savings. Few indie multiplayer projects bother measuring this.

### 4. Session/reconnect lifecycle is handled correctly
Grace-period reconnect with server-issued session tokens (prevents slot hijack by playerId guessing), respawn timer re-arm on reconnecting dead players, projectile cleanup on *removal* not socket-close (rejoining players keep in-flight shots), idle reaper with double-removal guards. The comments document several previously-found desync bugs (correction ping-pong, stale-anchor rejection spirals) — the code carries its own history.

### 5. Position plausibility without false-reject spirals
`handlePosition` compares consecutive reports (not vs last-accepted), commits the anchor after sending a correction, and force-accepts after 10 rejects to resync. This is the textbook hard part of client-authoritative movement — done carefully.

### 6. Comment quality
Comments explain *why* (anti-cheat tolerance rationale, why a guard exists, what breaks without it), not what. No noise. This is rare and worth preserving.

---

## Issues and Risks

### Real bugs / weaknesses found

1. **`BallSim.pendingRespawns` is dead bookkeeping.** Declared, read in the spawn-capacity check (`this.balls.size + this.pendingRespawns < target`), never incremented or decremented. Either wire respawn scheduling through it or delete it — right now it lies about capacity intent.

2. **`creatureHit` validation is a documented hole.** `BallSim.handleHit` does a 600m plausibility clamp and a 60-unit impulse cap — deliberately lenient ("real validation is an anticheat-phase concern"). Fine as a PoC decision, but this lets a client kill any ball with any impulse from 600m away. Cheap fix exists: reuse `validateHitClaim` against a tracked projectile, since creatureHit already has the machinery. At minimum the damage claim isn't bound to a weapon or projectile — a forged 300-damage claim one-shots the elite.

3. **`handleEnvironmentDamage` / `handleHeal` are client-claimed self-modification.** Clamped (40 dmg / 25 heal per call) but unlimited in frequency — the only defense is the rate limiter. `heal` in particular: at the default rate limit a client can sustain near-continuous healing. If nugget pickups matter, the pickup event should be server-generated (server knows the pickup, grants the heal) rather than client-claimed.

4. **Projectile leak on owner disconnect-in-grace is asymmetric.** `onPlayerRemoved` drops projectiles; `onPlayerDisconnected` keeps them (intentional — rejoiners keep theirs). But if a reconnect happens *after* the 10s grace window, `removePlayerCompletely` already ran `onPlayerRemoved` — projectiles gone. Consistent, but a player whose socket flap lasts >10s loses live projectiles silently. Minor; verify intended.

5. **`resolveClaimedProjectile` fallback is exploitable in one edge.** When `projectileId` is absent, it returns the shooter's most recent projectile *of the claimed weapon type* — but the claim's `weaponType` is client-controlled. A cheater with an old projectile still tracked can keep re-claiming hits by varying weaponType? No — `proj.weaponType` is server-recorded; the fallback only matches real tracked projectiles, and the airtime check bounds them by spawn age. It's fine, but worth noting the fallback means an un-detonated long-life projectile can be "hit-claimed" repeatedly until lifetime expiry — the `projectiles.delete` on successful claim mitigates this only when the client echoes the id. **A client omitting `projectileId` could claim multiple hits off one tracked projectile** since the dedupe only runs `if (msg.projectileId)`. Fix: delete the resolved projectile regardless of which path found it.

6. **Rate limiter is window-quantized.** Fixed windows let a client burst 2× maxCount at a window boundary. At this scale fine, but per-type sliding windows or token buckets are ~15 lines more.

### Structural concerns

7. **`client/src/main.ts` is still the monolith** (537 lines) and `game/entities.ts`/`game/combat.ts`/`entities/Player.ts` are all 900–1100 lines. The same pattern GameTest reviews flagged repeatedly: orchestration files absorb complexity until they block refactors. The TASKS.md already notes this — prioritize before content work makes it worse.

8. **Protocol drift risk between `shared/` consumers.** `shared/weapons.ts` is single-sourced (good), but the client also has `projectiles/Projectile.ts` (732 lines) whose `hitRadius` getter must mirror `hitRadiusAt` in shared/combat — the header comment says "mirrors exactly," which means it can silently stop mirroring. A shared unit test pinning the two formulas together would be cheap insurance (the server already has `bun test`; the client doesn't).

9. **No client test coverage.** 88 server tests, zero client. The riskiest divergence is the shared integrator (`ballSim.stepBall`) run on both sides — a test asserting server/client parity on seeded scenarios would catch the highest-value desync class. Both sides are plain TS — the sim is testable without Three.js.

10. **Interest tiers apply to player records but BallSim broadcasts unconditionally.** `ballSegment` goes to all clients regardless of distance — a ball 5km away still costs events. Fine at 40 balls; will need tiering when creature count grows.

---

## Strategic Assessment (context: "Krunkerized Tribes" thesis)

The architecture correctly encodes the thesis's hard requirements:

| Requirement | Evidence in code |
|---|---|
| Chromebook/browser viability | Binary wire protocol, interest tiers, ~few KB/s creature budget, 20Hz tick |
| Noobs can compete | Balls/PvE = non-PvP participation; server-owned creatures mean solo players get a live world (population-independent) |
| Pros express skill | Projectile-physics combat (bouncy targets, lead shots), Tribes movement preserved, leaderboards-shaped score systems |
| Anti-cheat without a trust fund | Projectile tracking + ballistic validation — better than Krunker's actual posture |
| Cold-start resilience | `alive.length === 0 → freeze ecosystem`; balls scale with players; single-player still a game |

**The netcode bet is the right one.** Shared deterministic sim + event segments is how you survive browser transport. The thing most likely to kill this project is not architecture — it's that it stays a prototype (the GameTest repo pattern: excellent systems, perpetual analysis). This codebase is unusually shippable for its size (~33k lines, test coverage where it matters most).

---

## Recommendations (priority order)

1. Fix the `projectileId` omission dedupe gap (delete resolved projectile regardless of claim path).
2. Tie `creatureHit` to a tracked projectile via `validateHitClaim` — the machinery exists, it's ~30 lines.
3. Make heal grants server-issued (pickup server-side) or at least per-window rate-limited tighter than the default bucket.
4. Write client tests for the shared integrator — highest-value test surface, both sides run `stepBall`.
5. Split `main.ts` and the three ~1000-line client files before adding more content systems.
6. Remove or implement `pendingRespawns`.
7. Distance-tier ballSegment broadcasts when creature counts exceed ~60.

---

**Reviewed files:** `server_bun/src/*` (all 13 files), `shared/*` (all 7 files), `TASKS.md`, directory survey of `client/src` (121 files, ~29.6k lines — file-level, not deep-read).
