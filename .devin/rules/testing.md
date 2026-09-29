---
trigger: glob
globs:
  - server_bun/tests/**
  - client/tests/**
---

# Test rules

- `cd server_bun && bun test` is the gate — keep all tests green. Client:
  `cd client && ./node_modules/.bin/vitest run` plus `tsc --noEmit` before
  committing code.
- Scenario tests live one-per-file under `server_bun/tests/scenarios/`,
  sharing `harness.ts` (`mkRoom`, `pin`, `step`, `watch`). Never a single
  mega file — the catalog grows.
- Sim-time ≠ wall time: hundreds of sim ticks run in milliseconds, so
  `Date.now()`-based gates (spawn protection, interval timers) never lapse
  inside a test. Clear them explicitly (`pin()` clears `protectedUntil`)
  and step sims via `step(dt)` hooks instead of real timers.
- Tap the right pipe: `connections.broadcast` catches broadcasts, but
  tiered fanout (crawlEvt etc.) rides `sendTo` per-player sends — assert on
  the observable outcome (damage, roster state) when edges go tiered.
- Pin via `room.moveSim.resync` + position + `protectedUntil=0` — writing
  `position` alone is stomped by moveSim integration; brains roam to
  objectives on the first think otherwise.
- Server-bot brains stomp `status` every think — a bot can't hold a manual
  cloak/mend bit. Status-dependent scenarios (cloakSafety, botCloak,
  stationHeal) use `room.players.addPlayer('P1')`, a brainless player.
- Tests that fail are evidence: debug via the harness's `watch()` counters
  and one-off dbg tests, don't guess. A test failure that points at real
  behavior beats an adjusted expectation.
