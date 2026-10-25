# wireIn early-queue QoS split — frozen-bots join bug

2026-10-25. Files: `client/src/networking/wireIn.ts` (`gate()`).

## Bug

Joining a busy room left bots frozen at spawn for up to ~53s. Log
signature: `wireIn dropped N early messages over the 512 cap`, then a
late `Remote roster:` heal.

Cause: the early queue (messages arriving before `markReady`) was a
single FIFO capped at 512. The connect burst — roster + gameState +
structures mixed with the live tick/motion stream — overflows it on a
populated room, and the drops were undifferentiated: must-deliver init
edges (playerJoined, gameState, structure/pickup spawns) died in the
same pool as latest-wins motion frames. The client then rendered
respawn edges but never got the position sources behind them → frozen
bodies until the periodic roster resync.

## Fix

Per-lane QoS in `gate()` — the shape GONet/yojimbo/Gaffer use:

- **JSON `ServerMessage`** (roster, gameState, joins, structure/flag/
  pickup edges): **never dropped**. Bounded by entity count (~hundreds),
  not by time — a one-time ~600ms burst.
- **Binary frames** (ticks, motion, hits — latest-wins, high-frequency):
  keep the 512 cap. A dropped tick is stale on arrival anyway; the next
  one supersedes it.

First fix was 512→4096 (a band-aid — moved the cliff). The lane split
is the actual fix: dropping motion frames is *correct*; dropping init
edges was the bug.

## Why this is the right shape

From the channel-QoS literature (GONet's 10-channel table, yojimbo's
reliable-ordered vs latest-wins channels): init/replication events are
facts — missing an entity CREATE leaves a permanent ghost; motion is a
stream — missing a frame just gets overwritten by the next. Treating
them with one cap was the design error, not the cap size.

## Residual

- Binary lane still carries some edges (jumps/kills decode from binary
  frames) — drops there are tolerated because they're per-moment events
  (a missed kill SFX heals on the next scoreboard tick). If a must-
  deliver edge ever moves to the binary lane, it must join the JSON
  class explicitly.
- If `earlyDrops` ever fires now, it's binary-only — read it as "join
  latency during heavy tick load," not roster loss.
