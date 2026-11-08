# Architecture — KRIBES

High-level map of how the game fits together. This is a **living pointer
file**, not a full spec — the deep dives live in `_docs/` and the code.

## The three layers

- **`shared/`** — deterministic sims + protocol used by **both** ends.
  - `shared/worldModel.ts` declares every entity kind's wire shape (new
    fields go here, not hand-built payloads).
  - `shared/movement.ts` — the sim both client prediction and server
    authority run.
  - `shared/botLines.ts`, `shared/botMoves.ts`, `shared/botGraph.ts`,
    `shared/botBrain.ts`, `shared/botTuning.ts` — bot AI (route/corridor,
    movement legs, pathing, brain context, tuning table).
- **`server_bun/src/`** — authority. Server owns every interactive outcome.
  - `Room.ts` + `room*.ts`/`Room*.ts` — match container + sim cluster.
  - `CombatHandler.ts` + `combat*`/`envClaims`/`hitLedger`/`killFeed` —
    outcome adjudication.
  - `moveClaims`/`moveJudge`/`rewind`/`claimLedger`/`validation` —
    movement-claim adjudication (rewind + judge).
  - `bot*.ts`/`ServerBots`/`serverSenses`/`serverAttacks` — bot army.
  - `TickLoop`/`tickHelpers`/`tickRecords`/`simClock` — tick pipeline.
  - `MessageHandler`/`ConnectionManager`/`SessionManager`/`Rtc*`/`Wt*` —
    transports.
  - `BallSim`/`CreatureSim`/`creature*` — ambient entity sims.
- **`client/src/`** — render, prediction, HUD/menus, netHandlers, instanced
  species. Never an authority on interactive state.

## Key references

- `_docs/INDEX.md` — full doc catalog (living vs. archived).
- `_docs/2026-10-15_CAPPER_STRIKE.md` — capper reference (scoreboard,
  mechanics, physics budget, landmines).
- `_docs/2026-10-18_NETCODE_OVERHAUL.md` — netcode overhaul;
  `_docs/2026-10-18_NETCODE_DEEP_DIVE_2.md` …
  `_docs/2026-10-19_NETCODE_DEEP_DIVE_9.md` +
  `_docs/2026-10-27_NUCLEUS_NETCODE_REFERENCE.md` — the follow-on
  research that drove the Oct–Nov wire hardening wave.
- `_docs/2026-10-31_CAPACITY_KNEE.md` /
  `_docs/2026-10-23_DUEL_CAPACITY.md` — seat/process limits + 1v1
  economics.
- `_docs/traps/` — gotcha writeups; read before touching the area.
- `concepts/netcode.md`, `concepts/movement.md`, `concepts/skiing.md` —
  design philosophy.
- `client/reports/architecture-review.md` — client architecture review.
- `client/src/demo/FORMAT.md` — `.demo` file format.

## Rules of the road (see AGENTS.md for full)

- Server owns every interactive outcome; clients send claims/intents.
- Non-player objects never stream positions — state EDGES + committed
  snapshot; both ends replay the same sim.
- Deterministic sims: no `Date.now()`/IO/unseeded random in sim code.
- Cheap is a feature: events over streams, distance-tiered sends.

## Filename prefixes (clusters)

`bot*` bot brains · `Room*`/`room*` match sim · `combat*`/`envClaims`/
`hitLedger`/`killFeed` damage funnel · `moveClaims`/`moveJudge`/`rewind`/
`claimLedger`/`validation` claim adjudication · `Player*`/`player*` local
player assembly · `*Config.ts` weapon tables · `creature*` species sim ·
`tick*`/`TickLoop`/`simClock` tick pipeline.