# Architectural Audit — 2026-10-07

Measured pass over the big smells. Evidence is concrete (counts, line
numbers) — not impressions.

## Verdict per earlier smell

### 1. Host-bag interfaces — REAL, and the top smell
17 `XHost` interfaces in `server_bun/src` each declare a slice of the
server they want: `AoeHost` (13 members), `BlastHost`, `DriveHost`,
`BeamHost`, `BallCombatHost`, `MoveHost`, `JudgeHost`, `SwitchHost`,
`ScoreHost`, `MatchHost`, `SpawnHost` ×2 (ballSpawn/creatureSpawn —
**same name, two different shapes**), `SpawnPickerHost`, `BrainHost`,
`RoomFactoryHost`, `ContactHost`.

Plus `EnvHost = CombatHandler & { lastHeal }` — the one file that
stopped pretending and just takes the whole handler. `CombatHandler`
itself is imported (type-level) by 5+ files; `MessageHandler` wires it
in as a runtime dep.

**Why it's a smell:** each Host is honest about reads but the object
passed is always the same mega-handler — the interfaces document
intent, they don't enforce a boundary. Adding a field to the shared
object silently widens every Host's real API. `SpawnHost` name
collision (two files, two shapes) is the concrete drift symptom.
**Fix shape:** this is already 80% good — the migration is to narrow
the *values passed* (pass `{ hb, reject, ledger }` structurally, not
`this`), which the types already describe. Medium effort, low risk.

### 2. Client dep bag — DOWNGRADED. Managed, not a smell
`GameContext` (context.ts) is 9 members with an explicit convention:
`lazy*` getter = "constructed later, call when needed", plain field =
safe at init. ~223 `deps.*` call sites funnel through it. EntitiesDeps
extends it for factory-specific extras instead of growing parallel
bags. This is the *fixed* version of the smell — keep it, don't
"improve" it. Watch item only: optional extras
(`deployEnemyBots?`, `nuggetCollectors?`) accreting on EntitiesDeps.

### 3. Three AI stacks — REAL
- `server_bun/ServerBots.ts` (702 lines) + `botArsenal/botBeam/botDrive`
- `shared/botBrain.ts` + `botHunt.ts` + `botMoves.ts` +
  `botDisposition.ts` + a dozen `client/src/game/bot*.ts`
- `server_bun/creatureBrain.ts` + client replay in `netCrawlers`

Targeting/cooldown/retarget idioms are re-derived per stack —
the retarget-skip bug had to be fixed in creatures AND balls
separately. Partially justified (authority vs prediction vs PvE), but
the *policy* layer (pick target, respect cooldown, say contact once)
could share a table/evaluator. **Fix shape:** extract shared
targeting/cooldown primitives; keep per-stack stepping. Large effort.

### 4. Shadow record — REAL and growing
`moveJudge.ts` `Shadow` = **32 fields**: sim + probe + divergence
history + severity windows + correction throttle + impulse grace +
energy model (6 fields) + seq tracking + WIP defer-window fields.
It's a state machine kept as a flat struct — each new grace window
(teleport, impulse, gap-defer) must hand-coordinate against the
others, and §2.39-class bugs live in the gaps. Your current WIP
already shows it: the defer window broke soakChaos because
`deferStreak` interacts with `severeT`/`lastCorrection` in ways the
struct can't express.
**Fix shape:** formalize as phase machine (seeded → tracking →
deferred(reason) → resynced) with per-phase allow-lists for what a
report may do. Medium-large; do it while the WIP is fresh, not after.

### 5. wire.ts — DOWNGRADED to watch item
557 lines, but it IS a registry: `validate` per type, one dispatch
table, documented exceptions (join, switchRoom). The smell isn't the
file, it's that every new message touches 4 concerns — but the table
shape already contains that. Leave it.

### 6. Three rosters — REAL but bounded
`rooms` (GameServer) + `playerRoom` + `specRooms` + room-internal
`players` + client `remotePlayers` (touched from ~70 client files).
Most stale-key fixes of past rounds trace to one collection being
forgotten on a removal path — all now evict on their paths, so the
shape is the smell: lifecycle is spread across 5 collections instead
of one "player left" funnel. **Fix shape:** a single
`departPlayer(id)` that every exit path routes through; medium effort,
removes a whole recurring bug class.

## New finds this pass

- **`serverSenses.ts` = 1045 lines** — biggest logic file on the
  server after `Room.ts` (1070). Both are over the ~900 ceiling the
  sizeWatch test guards; they're grandfathered, so growth is
  invisible. Sensory/radar/visibility concerns in one file.
- **`botTaunts.ts` = 1237 lines** — pure data table, exempt by nature.
- **`mapAssets.ts` = 846 lines (client)** — boot/terrain/map plumbing;
  approaching the ceiling.
- **40 distinct `fps-*` localStorage keys** — settings persistence is
  scattered; no single schema/migration owner. A rename or default
  change has no funnel.
- **`envClaims` EnvHost is the honest one** — `CombatHandler & {…}`.
  If the codebase ever defines a real `CombatHost` contract, envClaims
  is the file that will need the least work — it's already explicit
  about which god it prays to.

## Ranked fix order

1. **`departPlayer` funnel** — kills a recurring bug class, moderate
   effort, no behavior change.
2. **Shadow → phase machine** — do it alongside the WIP so the defer
   window lands *in* the machine instead of against it.
3. **Host narrowing** — pass structurally-typed slices, not `this`;
   the interfaces already exist.
4. **fps-* key registry** — one module owning the key list + defaults.
5. **Split serverSenses / Room** — only when they next need surgery.
