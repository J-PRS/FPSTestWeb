# Minimizing per-room overhead for many small matches (1v1 … 16v16)

Goal: host the maximum number of concurrent matches on a single box by
cutting the fixed cost paid per `Room` per tick.

## Where the overhead is today

`TickLoop.startTickBroadcast` runs **one** interval that walks
`this.rooms.values()` and calls `tickRoomGuarded(room)` for each. So all
rooms already share a single cycle — the cost is **per-room**, not
per-player:

| Phase (per room) | What it does | Typical cost |
|---|---|---|
| `cmd` | `drainCommands()` | O(commands this tick) |
| `sim:*` | balls, creatures, bots, pickups, deploy, proj, move, health | O(entities in room) |
| `auth` | shadow-sim lead for humans | O(humans) |
| `records` | `fanout.buildRecords` — encode once per player needing update | O(players) |
| `fanout` | `fanoutRecords` + `flushOutboxes` | O(players × recipients) |

A 1v1 room pays the full `drainCommands` + `buildRecords` + `flushOutboxes`
tax for 2 players. At 1024 players in 32 full rooms the event loop already
sat at **107 ms p50**; at 320 players in 20×16 rooms it was **29 ms**.
Room count, not player count, is the driver.

## Levers (ordered by impact)

### 1. Multi-match rooms (biggest win)

Run N independent matches inside **one** `Room` instance with partitioned
player sets and per-match state arrays. Removes N−1 copies of:

- `drainCommands` / command buffer
- `checkMatchClock`, hibernation checks
- `buildRecords` + `fanoutRecords` + `flushOutboxes` scaffolding
- interval bookkeeping and metrics rollup

Cost: `Room` must become match-aware — scoring, spawns, sim, and fanout
all need a `matchId` dimension. This is the only lever that removes the
per-room tax instead of trimming it.

### 2. Gate per-room sim phases

Most small modes don't use balls/creatures/deployables/pickups. Add cheap
feature flags on `Room` (`hasBalls`, `hasCreatures`, `hasDeployables`,
`hasPickups`) and skip the corresponding `sim.tick()` calls when false.
The `sim:*` phases are the largest slice for modes that do use them.

### 3. Flatten the per-room tick path

- Pre-allocate per-match buffers; no `new` in `tickRoom`.
- Encode records once and only re-encode on change (delta-only fanout).
- Merge command-drain → sim → fanout into a single pass over players
  instead of three.
- Avoid `Map`/`Set` iteration where a flat array suffices.

### 4. Hibernation for idle matches

Already implemented for bot-only rooms (`audience = humanCount > 0`).
Extend to 1v1s: freeze sim and stop ticking when both players are gone for
>N seconds; wake on reconnect. Costs nothing for active matches.

### 5. Shard across processes (fleet)

Per-room overhead is fixed, so spreading rooms across workers scales
linearly with cores. `TickLoop` already ticks all rooms in one interval,
so vertical scaling = more workers behind the matchmaker. This is the
existing production path; it doesn't reduce per-room cost but multiplies
throughput.

## What NOT to do

- **Don't put all players in one giant room.** It breaks match isolation
  (scoring, spawns, rewind buffers) and turns every fanout into an
  O(total players) broadcast.
- **Don't skip ticks for "quiet" rooms** — the client's loss metric reads
  arrival cadence; a silent stream reads as ~100% loss. Empty frames must
  still ship (already enforced).
- **Don't move sim to workers per room** — the overhead of cross-thread
  marshalling exceeds the per-room tax for small rooms.

## Recommended order of attack

1. Profile which phase dominates for a 2-player room (`phaseMs` from
   `/metrics`) — usually `fanout` or `sim:move`.
2. Add feature flags (lever 2) — cheap, no isolation risk.
3. If still room-count limited, implement multi-match rooms (lever 1).
4. Shard with fleet for horizontal scale (lever 5).

## Evidence

- 32 rooms × 32 players: 107 ms event-loop p50, 1024 players.
- 20 rooms × 16 players: 29 ms event-loop p50, 320 players.
- Mix (2+10+16+24+32): 10 ms event-loop p50, 84 players.

Smaller rooms are healthier; the per-room tax is the remaining lever.