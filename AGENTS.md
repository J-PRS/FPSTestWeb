# KRIBES — Agent Guide

Browser multiplayer FPS: **Krunker movement + Tribes scale**. Three.js client,
Bun server (WS + WebTransport + RTC-DataChannel), shared deterministic sims.

## Commands

```bash
# Server (from server_bun/): bun src/server.ts   — env: FPS_PORT, FPS_MAP, FPS_SBOTS, LOG_LEVEL, FPS_ICE_SERVERS
cd server_bun && bun test              # ALL server tests — must stay green
cd server_bun && bun test tests/scenarios/   # gameplay scenario tests only
cd client && ./node_modules/.bin/tsc --noEmit   # client typecheck — must be clean
cd client && ./node_modules/.bin/vitest run     # client unit tests
cd client && npx -y oxlint src         # lint
# bun needs: export PATH="$HOME/.bun/bin:$PATH"  (Windows, Git Bash)
```

Verify before committing: server `bun test`, client `tsc --noEmit`, `vitest run`, `oxlint`.
Scenario tests run hundreds of sim-ticks in milliseconds — **wall-clock timers
(spawn protection, intervals) never lapse inside them.** Drive sims via their
`step(dt)` hooks and clear `protectedUntil` via the harness `pin()`.

## Layout

- `shared/` — code used by BOTH ends: protocol, weapons stats, mapSpec, heightfield, botBrain, creature* sims, damage/impulse math. **Deterministic:** given same inputs, same outputs on client and server. No `Date.now()`/IO/`Math.random` outside seeded RNGs.
- `server_bun/src/` — authority: Room (match/flags/pickups/deployables/combat claims), CreatureSim/BallSim (server-owned species), ServerBots, PlayerManager, ConnectionManager, MessageHandler, weaponstats.
- `client/src/` — rendering, prediction, interpolation, HUD/menus, netHandlers, species visuals (instanced meshes), game loop phases.
- `maps/` — map spec JSONs (terrain seed, bases, structures, creatures, ambient).
- `_tools/` — soak fleets (pvptest), headless capture (pvptest/fightshots.js), map bake (mapbake), demo render.
- `_reports/`, `_docs/` — audits and design docs. `ROADMAP.md` = living manifesto, read first, keep current. `changelog.txt` = prepend `YYYY-MM-DD - <summary>`, ASCII only.

## Architecture invariants — the wire is law

1. **Server owns all interactive state.** Positions, damage, scores, flags,
   creature brains. Clients send claims/intents; server validates and owns
   outcomes. If it's interactive it's shared — client-only interaction is
   decor (`ambient`) or a bug.
2. **Deterministic replay, not position streams.** Projectiles, balls, and
   creatures broadcast *edges* (spawn/retarget/land/die) plus a committed
   snapshot; both ends integrate the same shared sim locally. Never stream
   per-tick transforms for non-player objects.
3. **Damage has one funnel.** Every hit claim passes server validation
   (ledger provenance, range/LOS plausibility, spawn protection, team
   rules). Client-predicted damage is cosmetic until the server confirms.
4. **Committed snapshots over live positions.** Sims steer at the snapshot
   committed at decision time (tp field) — that's what makes client replay
   agree with the server. Tests must respect it: placing an entity off its
   committed path is a different test.
5. **Cheap is a feature.** Event-sourced objects, distance-tiered sends,
   staggered AI buckets, provably-safe collision skips. Optimizations must
   never cause unfair misses — skip work only when the outcome is provably
   identical.

## Boundaries — don't touch

- No secrets in code, logs, or commits. `.env`/certs/key files stay out.
- Don't weaken claim validation, spawn protection, or team damage rules to
  make a test pass — the test is wrong or the setup needs `pin()`/`step()`.
- Don't add position streaming for creatures/balls/projectiles — extend the
  edge/snapshot model instead.
- Don't leave binaries heavy: `screenshots_web` webp q82, ≤1200px.
- Windows + Git Bash environment — `cmd //c "taskkill /F /PID <pid>"` for
  kills; bun on PATH as above. Never push, never `git add .`; commit per
  settled topic only.

## Conventions

- Comments explain WHY, never WHAT (name/style tells what). No diff-
  narration comments ("now we also...", "fix for when...") — put that in
  the commit message or PR description.
- Match the leaf-module split pattern: extract a self-contained concern
  into `src/<thing>.ts` (e.g. claimLedger, botWatchdog, roomMatch), keep a
  thin delegate in the parent. Keep files reasonably sized.
- New species family ⇒ one shared sim core in `shared/creature*.ts`,
  species stats in a data table, wire edges behind the `crawl*` stream,
  client replay via `netMelee`-style shared helper.
- New scenario ⇒ new file under `server_bun/tests/scenarios/` using
  `harness.ts` (`mkRoom`, `pin`, `step`, `watch`). One behavior per file.
