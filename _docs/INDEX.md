# Documentation index — KRIBES

The project produces a lot of documentation. This file is the map.
**Read this first** before digging in `_docs/` (140+ files).

## Canonical / living (keep current)

| Doc | What it is |
|---|---|
| `AGENTS.md` (root) | Agent guide — commands, layout, rules of the road |
| `client/AGENTS.md` | Client-specific agent guide |
| `server_bun/AGENTS.md` | Server-specific agent guide |
| `ROADMAP.md` | Living manifesto — read first, keep current |
| `changelog.txt` | Prepended `YYYY-MM-DD - <summary>` per settled topic |
| `TASKS.md` | Project development context |
| `NOTES.md` | JP's world notes |
| `TEST_PLAN_bots.md` / `TEST_PLAN_demo.md` | Test plans |
| `_docs/2026-10-15_CAPPER_STRIKE.md` | **Living capper reference** — scoreboard, mechanics, physics budget, landmines, measured history |
| `_docs/2026-10-16_CAPPER_REACTIVE_LIMITS.md` | Capper reactive ceiling + TAS floor |
| `_docs/2026-10-16_TEAMSOAK_WARP.md` | Themed team matchups + warp collapse |
| `_docs/2026-10-17_TERRAIN_COMPILE_STALL.md` | The 40s browser hang |
| `_docs/2026-10-18_ADDING_MODES_AND_PICKUPS.md` | Blast surface for new modes/pickups |
| `_docs/2026-10-18_CTF_BOT_BRAIN_PUG_AUDIT.md` | CTF bot brain vs PUG guide audit |
| `_docs/2026-10-18_NETCODE_OVERHAUL.md` | Netcode overhaul (2026-10-18) |
| `_docs/2026-10-21_NETCODE_GAP.md` | Netcode gap analysis vs production shooters |
| `_docs/2026-10-22_GRIND_LEADERBOARD.md` | Grind leaderboard design |
| `_docs/2026-10-22_SPECTATE_RELAY.md` | Spectator relay / OBS-server reference |

## Agent memory (append-only, one line each)

- `.agents/memory/corrections.md` — "got this wrong → rule"
- `.agents/memory/decisions.md` — "chose X over Y because Z"

## Concepts (design philosophy — mostly stable)

`concepts/` — 14 files: `movement.md`, `skiing.md`, `bots.md`, `netcode.md`,
`demo-system.md`, `enemies.md`, `feel-vfx.md`, `footprint-conforming.md`,
`projectile-inheritance.md`, `proxy-hitbox.md`, `skills.md`,
`terrain-gen.md`, `turretter.md`, `ballistic-solver.md`. Mostly 2026-09-27
baseline; `terrain-gen.md` updated 2026-10-16.

## Traps (gotchas — read before touching the area)

`traps/` — 5 files: bloom black frames, T2 map porting, updateRanges
first-shot-only, bloom composite is raw, filter-repo eats worktree.

## Workflows

`workflows/beta-launch.md`, `workflows/robustify-round.md`.

## Client design reports

`client/reports/` — 8 files: architecture-review, decoupled-sim-rate,
demo-anti-tampering-design, demo-system-robustness-plan, hybrid-demo-format-design,
lean-anti-tamper-validation, server-side-recording-efficiency. Plus
`client/src/demo/FORMAT.md` (the .demo file format).

## _docs/ research archive (point-in-time, NOT current)

`_docs/` holds ~140 files. **Treat anything dated before the latest
session as historical research, not ground truth** — the living docs above
supersede them. Subdirectories:
- `_docs/GAMES/`, `_docs/OLD/`, `_docs/ROBUSTIFY/`, `_docs/UPHEAVAL/` — archived batches
- `_docs/reference/` (incl. `tribesxt/`) — external reference material
- `_docs/2026-06-*.md` … `2026-10-*.md` — dated research reports and session notes

Highlights still worth reading: `NETCODE_DEEP_DIVE_2..9`, `BOT_NAV_ORBITS`,
`BOT_EVOLUTION_RESEARCH`, `JET_ENERGY_ECONOMY`, `TERRAIN_COMPILE_STALL`,
`UNIFY_OFFLINE_NET`. The `SESSION_*.md` and `2026-06-*` files are the
most likely to be stale.

## Reference / external

- `_reference/tribes-physics`, `_docs/reference/tribesxt` — Tribes physics reference
- Tribes installs on disk (see AGENTS.md "Tribes reference installs")

## _tools/

`_tools/README.md` (pipeline vs scratch), `io_dif/README.md`,
`animpacks/README.md`. The rest of `_tools/` is scripts + scratch output
(mostly gitignored: `devin_scratch/`, `sweeps/out/`, `e2e/shots/`, etc.).

## _zzz/

Archived reference projects (babylon, rundot, sprunk, colyseus, fastapi) —
not part of the game.

## Missing / known gaps

- **No master index existed before this file** — that's why it was added.
- `concepts/` and `client/reports/` have no "current vs superseded" markers.
- `docs/SESSION_2026-10-01.md` and `SESSION_2026-10-10.md` are stale
  session notes superseded by the living docs and changelog.
- `NOTES.md` and `TASKS.md` are loose scratchpads; prefer ROADMAP.md +
  `_docs/2026-10-15_CAPPER_STRIKE.md` for current state.