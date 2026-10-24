# Trap: converge/DR steering toward the *extrapolated* sample

Cost a full user-visible "remotes rubberband and warp everywhere" episode
and several wrong-first guesses. Written down so nobody re-derives it.

## The symptom that misleads

Solid remote model runs "lively" 20-70m ahead/elsewhere while the teal
wireframe (`lastServerPosition`) looks like it sluggishly follows behind.
Reads as "the ghost is late" — actually the model is *off truth*.

## The mechanism

`remoteSnapshots.sample()` returns an extrapolated coast when
`renderTime > newest.t` (starved buffer): newest record pos + stale
velocity × up to 2s. That path exists for *continuity of the interp
render* and is fine as a bounded fallback.

The bug was `remoteInterp.convergeStep()` calling the same `sample()` and
steering the body toward its output. During any starve the chase target
is a fabricated point seconds ahead — converge literally pulls the model
AWAY from wire truth, then stays off it (self-reinforcing: DR targets
DR's own projection). The teal ghost sits still because it's honest.

Fix: when `net.atExtCap`, converge targets `net.latestPos()` — the newest
received record — not the coasted sample. Model can then only sit at or
behind truth.

## The full chain that produced "warping"

1. `remoteInterp.predict()` ran remote knockback on a *client-fabricated*
   ballistic arc (net.clear() + sim for ~RTT), then resampled → hard
   40-70m one-frame `model:` jumps on every mortar hit. Local-style
   prediction applied to entities the client doesn't control — every
   netcode reference says don't do this.
2. Converge budget expiring mid-gap released straight into a `interp()`
   position write — same visible snap. Re-arm instead of releasing.
3. Converge chasing the extrapolated sample (above).
4. Server record cadence was distance-tiered only: a 50m/s skier got
   records every 300-400ms = ~19m travel between truths — no client
   technique renders truth inside a gap that big. Fixed server-side:
   `tickRecords` now caps send interval at 5m of travel
   (`speedTier = floor((5/spd)/tickDt)`).

## Diagnostics that split it

- `dbgghost-jump` `wire:` vs `adj:` vs `model:` columns isolate WHICH
  stage moved. `wire:0, model:60` = client-generated jump, wire is clean.
- `ghosts:` census: `rg` (render vs buffer-sample), `wg` (sample vs wire),
  `rw` (render vs wire). `rg≈0 + wg big` = intrinsic delay. `rg big` =
  model diverging from its own sample — the bug class above.
- `lagMs` under `sim:true` is NOT network lag — it's drift-converted-to-
  time (capped 1500) = "body is this far off the wire." Reads like a
  latency number, isn't one.
- `atCap:true` + `underruns` = buffer starving → everything past that is
  extrapolation, and anything steering toward the sample is steering
  toward fiction.

## Rules of thumb

- Interp/DR/steer may only target **received positions or the newest
  record** — never an extrapolated endpoint. Extrapolation is a
  render-path fallback, not a target.
- A "ghost behind the visual" complaint is the visual lying, not the
  ghost lagging — trust the newest-record marker first.
- When the stream starves, freezing at truth beats projecting fiction:
  honest stillness > plausible-looking wrongness, and it keeps the
  shooter's rewind anchor inside real server history.
- Still-open: WHY a 3ms-ping seat starves at all (worker coalescing /
  post-reconnect record lane). The visuals now degrade honestly when it
  happens, but the starvation root cause wasn't found yet.
