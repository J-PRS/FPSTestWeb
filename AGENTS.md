# KRIBES — Agent Guide

Browser multiplayer FPS: **Tribes gameplay, Krunker performance and
accessibility**. Skiing, jetpacks, spinfusor combat, base assets — in a
browser tab, fast enough for any laptop. Three.js client, Bun server
(WS/WebTransport/RTC), shared deterministic sims.

## Commands

```bash
cd server_bun && bun test                        # server tests — must stay green
cd server_bun && bun test tests/scenarios/       # gameplay scenario tests
cd client && ./node_modules/.bin/tsc --noEmit    # client typecheck
cd client && ./node_modules/.bin/vitest run      # client tests
cd client && npx -y oxlint src                   # lint
bun _tools/e2e/all.ts                            # headless E2E (locked-PC safe): smoke/duo/p2p/lobby/reconnect/perf
bun _tools/e2e/perf.ts --compare _tools/e2e/baseline.json   # perf regression vs baseline
# bun: export PATH="$HOME/.bun/bin:$PATH"   (Windows, Git Bash)
```

## Layout

- `shared/` — sims + protocol used by BOTH ends (deterministic: no
  `Date.now()`/IO/unseeded random in sim code).
- `server_bun/src/` — authority: Room, CombatHandler claims, CreatureSim/
  BallSim, ServerBots, RoomMoveSim.
- `client/src/` — render, prediction, HUD/menus, netHandlers, instanced species.
- `maps/` spec JSONs · `_tools/` soaks + headless capture · `ROADMAP.md`
  is the living manifesto (read first, keep current) · `changelog.txt`
  prepend `YYYY-MM-DD - <summary>` ASCII.

## Rules of the road

- Server owns every interactive outcome; clients send claims/intents.
  Client-only interaction is decor or a bug.
- Non-player objects never stream positions — broadcast state EDGES +
  committed snapshot; both ends replay the same sim.
- Cheap is a feature: events over streams, distance-tiered sends, staggered
  AI buckets, only provably-safe skips (no unfair misses).
- Comments say WHY, not WHAT. No secrets. No push. Commit per settled
  topic only. Windows+Git Bash: `cmd //c "taskkill /F /PID <pid>"`.
- Scenario tests: one file per scenario under `tests/scenarios/` using
  `harness.ts`. Sim-time ≠ wall-clock — `pin()` clears spawn protection,
  drive sims via `step(dt)`.
