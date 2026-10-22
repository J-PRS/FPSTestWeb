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
bash _tools/check.sh --fastest                    # quick compile+lint probe (~30-60s); NOT the gate
# rootcheck (utils/_rootcheck.mjs) now also runs inside check.sh and gates
# on index_root.txt — a new/removed root entry fails until accepted or moved.
# Windows clean stack: .\devup.bat = reap stale dev procs (_tools/reap.mjs)
# + free :5400/:8000 + launch both. run_all.bat = same without the reaper.
E2E_GPU=1 bun _tools/e2e/all.ts                  # headless E2E — ALWAYS run with real GPU
# browser.ts GL backends: default SwiftShader is SLOW — GLB loads take
# 60-90s+, sim time crawls, and timing assertions flake. Never run
# browser tests on software rendering when the GPU is available:
# set E2E_GPU=1 for every e2e/soak/screenshot run (fast, still no
# window, works on a locked PC). E2E_HEADED=1 = visible Chrome + GPU
# (unlocked PCs only). Only fall back to SwiftShader when no GPU
# exists at all. Also launchClient's waitFor() gates on window.__test —
# pages that don't set it (posedump.html) must poll window.__ready via
# waitForFunction.
bun _tools/e2e/perf.ts --compare _tools/e2e/baseline.json   # perf regression vs baseline
bash _tools/check.sh                             # DEFINITION OF DONE — run before handing back
bash _tools/review.sh                            # dump diff + verifier prompt for a fresh-context review agent
# bun: export PATH="$HOME/.bun/bin:$PATH"   (Windows, Git Bash)
# Windows: plain `bash` is WSL and its git counts every CRLF file as
# changed, so check.sh aborts on its 100-file sanity cap. Use Git Bash:
# & 'C:\Program Files\Git\bin\bash.exe' -lc "bash _tools/check.sh"
```

**Definition of done:** `bash _tools/check.sh` exits 0. It lints+fixes
the changed files, typechecks the client, runs related vitest tests, and
runs `bun test` when `shared/` or `server_bun/` changed, and captures a
headless screenshot when scene code (`world|effects|structures|
projectiles|shaders|entities`) changed — READ that PNG, green tests do
not see the screen. The individual commands above are for debugging;
check.sh is the gate. Before committing a big diff, run `review.sh` and
hand its diff + prompt to a fresh-context verifier agent — the author
never grades itself. A git
`pre-commit` hook lint-fixes staged files — keep it fast, don't add the
suite to it.

Ports: game client (Vite) **:5400**, game server (Bun) **:8000**.
`:5173` is a different project's dev server — not the game.

## Layout

- `shared/` — sims + protocol (deterministic). `server_bun/src/` — authority.
  `client/src/` — render, prediction, HUD. `maps/` — spec JSONs.
  `_tools/` — soaks + headless capture. `ROADMAP.md` is the living
  manifesto (read first). `changelog.txt` prepend `YYYY-MM-DD - <summary>`.
  `_docs/INDEX.md` is the catalog of all 140+ docs — read it before
  hunting in `_docs/`. Full layer map: `ARCHITECTURE.md`.
- Filename prefixes are the clusters (flat dirs by design):
  `bot*` bot brains · `Room*`/`room*` match sim · `combat*`/`envClaims`/
  `hitLedger`/`killFeed` damage funnel · `moveClaims`/`moveJudge`/`rewind`/
  `claimLedger`/`validation` claim adjudication · `Player*`/`player*`
  local player assembly · `*Config.ts` weapon tables · `creature*`
  species sim · `tick*`/`TickLoop`/`simClock` tick pipeline.

## Rules of the road

- Server owns every interactive outcome; clients send claims/intents.
  Client-only interaction is decor or a bug.
- Non-player objects never stream positions — broadcast state EDGES +
  committed snapshot; both ends replay the same sim.
- Cheap is a feature: events over streams, distance-tiered sends, staggered
  AI buckets, only provably-safe skips (no unfair misses).
- `.agents/memory/` — read it, and append when you screw up or make a
  non-obvious call. `corrections.md` = "got this wrong → rule";
  `decisions.md` = "chose X over Y because Z". One line each, append-only.
- Drive-wide file lookup: `C:\Users\JPrice\bin\es.exe <pattern>` (Everything
  CLI — instant, indexed; use it instead of scanning drives for reference
  installs or tools).
- Tribes reference installs (real scripts, mine these for tuning values):
  T1 scripts `C:\Users\JPrice\Downloads\[Tribes 1]\Tribes 2015\base\scripts\`
  (e.g. chaingun `muzzleVelocity=425, inheritedVelocityScale=1.0`);
  T2 `D:\[Games]\Tribes2\GameData\` (base + `Classic\scripts\weapons\`);
  T:V `D:\[Games2]\VUGames\Tribes Vengeance\`; T:A
  `C:\Users\JPrice\Documents\My Games\Tribes Ascend\`;
  `D:\[Games]\Steam\steamapps\common\Tribes`;
  Legions Overdrive
  `C:\Users\JPrice\Downloads\[ARCHIVE]\2024.01.05\Legions\game\`
  (Torque datablocks under `server\game\dataBlocks\weapons\`). In-repo
  writeups: `_reference\tribes-physics`, `_docs\reference\tribesxt`.
- Comments say WHY, not WHAT. No secrets. No push. Commit per settled
  topic only. Pre-commit refuses commits under 50 changed lines — batch
  small fixes; a genuine one-liner uses `--no-verify` deliberately.
  Windows+Git Bash: `cmd //c "taskkill /F /PID <pid>"`.
- Scenario tests: one file per scenario under `tests/scenarios/` using
  `harness.ts`. Sim-time ≠ wall-clock — `pin()` clears spawn protection,
  drive sims via `step(dt)`.
