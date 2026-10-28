# Lag compensation / WYSIWYG reference (2026-10-28)

Status: reference doc. Covers what the industry does, what this codebase does, what was
measured, and what's still improvable.

## Goal statement

The goal is **not** `rg = 0` everywhere — that's physically impossible, because the
rendered position (interpolated, smoothed, wall-clock) and the server's rewound ghost
(quantized, server-time) are different kinds of truth. The goal is:

- `rg` < hitbox radius in the normal case — every honest shot registers.
- `rg` ≈ 0 at low speeds — stationary/slow remotes should be pixel-consistent.
- Bounded divergence at high speed — a design tradeoff (rewind cap), not an accuracy bug.

## Industry best practices (sources)

1. **Client stamps the view time; server never guesses.** Valve's Source formula:
   `Command Execution Time = serverNow − packet latency − client view interpolation`.
   Riot/Valorant sends the simulation frame the client was looking at. Guessing costs
   jitter-dependent error.
2. **Rewind the same interpolation the renderer used.** Netick: the server resolves hit
   queries against the same `(From, To, Alpha)` triple the client was visually
   interpolating — not the nearest history tick. A tick-snap costs up to one tick of
   position error (~5m at 300 m/s at 20Hz).
3. **Adaptive per-client render delay.** Better than Source's fixed `cl_interp 0.1`:
   the shooter's actual buffer settles on a delay the server should use verbatim.
4. **Cap the window as policy, not physics.** Valorant's rewind cap is 140 ms (was 200).
   Beyond it, legitimate rewinds truncate and hits land ahead of the crosshair —
   "shot behind cover" complaints are the counter-pressure. Colyseus suggests
   `renderDelay + RTT + one tick` as the minimum sane window; Unity's docs suggest
   250–500 ms of history.
5. **Bound client claims server-side.** The view-lag claim is a hint, not evidence:
   the ceiling is what the server measures on the path (the favor-the-cheater window).
6. **Extrapolation windows have no rewindable epoch.** When the client's buffer starves
   and it dead-reckons, no server-time truth exists to rewind to. Consensus: clamp the
   window or degrade the validation — you cannot rewind a position that was never in a
   snapshot.

## What we do (pipeline tour)

### Client — `client/src/entities/`

- `remoteSnapshots.ts` — per-remote snapshot buffer. Render position interpolates
  between two straddling snapshots with **Hermite (velocity-aware)**, with an overshoot
  guard (bulge < 0.25×chord + 0.35 else linear fallback). `sampleAt(t)` answers the
  linear history query; `viewEpochT` is the server-time of the last drawn frame —
  "the shooter's literal view instant". `interpDelay` adapts to arrival jitter.
- `remoteInterp.ts` — dead reckoning and converge. On starvation (arrival interval ×
  2.5, min 350ms max 1500ms) the remote free-runs the last estimated velocity; on resume
  it steers back (converge), never snaps. `viewLagMs` converts a behind-drift to time
  during sim episodes (there's no rewindable epoch — reports drift/speed instead).
- `ghostTrace.ts` — **the WYSIWYG instrument.** Every 100ms samples rendered ↔ wire ↔
  ghost for each remote: `rw` (interp lag), `wg` (lag-comp projection), `rg` (what you
  see vs what the server judges — the hit-feel number). Percentiles + worst-5 via the
  Alt+Q `ghosts` diag; dumped headlessly through `window.__trailDump()`.
- `clientStats` — the client reports `renderLagMs` (aggregate) and a `renderLag`
  per-target map via the periodic uplink, fresh ~every few seconds.

### Server — `server_bun/src/`

- `rewind.ts` — `pushRewindSample` appends `{t, x, y, z, vx, vy, vz}` per player to a
  1200ms history (`REWIND_MS`) at ~25Hz. `renderLagOfTarget` resolves the shooter's
  claimed per-target view lag; `renderLagBoundOf` caps the claim at
  `RENDER_LAG_MS(200) + 2×transit + 3×jitter`, floored 350, ceiling 800.
- `claimLedger.ts` — `rewindPos(target, backMs)` interpolates history at `now − backMs`
  using **cubic Hermite with velocity** (added 2026-10-28 — matches the client's curve
  instead of the chord, same overshoot fallback). `clampPing` caps reported RTT at
  400ms; `shooterTransitMs` prefers the measured one-way uplink over RTT/2.
- `projContact.ts` / `combatBlast.ts` / `beamSweep.ts` — `ghostBack`:
  `back = shooterTransit + renderLagOfTarget − targetTransit`. One-way hops only —
  the target's own downlink transit is subtracted because the rewind history rides its
  uplink; a full-RTT term would land ~RTT/2 behind the ghost.
- `PlayerManager.ts` — history is cleared and reseeded at spawn so corpse samples can't
  survive a respawn.

### Aha: why `rg` can never be 0

Rendered = smooth client-time filter; ghost = the server's lerp between its own history
samples at a stamped view lag. They're only equal when the render instant happens to
land on a ghost sample. In the normal case they drift by a few centimeters constantly —
the meaningful contract is `rg < capsule radius`, not `rg = 0`.

## Measured

`_tools/e2e/ghostsoak.ts`, 120s wall, 12 bots, CTF lagoon, WS lane, E2E_GPU=1:

```
n = 6000 samples (trailing ~60s)
rw p50 1.95m   p95 7.91m   max 27.5m   (interp lag you see)
wg p50 1.93m   p95 7.78m   max 27.5m   (lag-comp projection)
rg p50 0.00m   p95 0.42m   max 5.6m    (view vs judged)
worst: BOT-OZONE-07 rg=5.6 @330m/s (fast mover, ~17ms of view error)
       BOT-MARA-03   rg=3.9 @0m/s    (stationary drift — suspicious)
```

Reading: p95 sub-capsule = decent; the suspicious class is `rg>2m @ <5m/s` — a
stationary remote should agree exactly. That points at converge/seat-handoff edges
(the same class as `seat without begin` errors), not physics. The 51m `ghosts.max`
note was WebTransport — a wt-lane soak is the still-missing comparison.

## What was improved 2026-10-28

- **Velocity-aware rewind** — `rewindPos` lerps with Hermite over velocity-carrying
  samples, matching the client's render curve. Server history used to plain-lerp on
  the chord while the client curved; during turns the ghost sat meters off the render.
  ~20 lines in `rewind.ts`/`claimLedger.ts`, sample shape + test fixtures updated.

## What could still improve, ordered by accuracy gain

1. **Per-shot viewLag (wire change, biggest jump).** `renderLag` rides periodic
   clientStats — stale by up to a few seconds between reports. Sending the target's
   viewLag *inside the shot/intent* makes "what you literally saw" exact per claim.
   The claim is still bounded by `renderLagBoundOf` either way.
2. **Kill the stationary-drift episodes.** `rg>2m @ <5m/s` is a bug class (converge
   holdover, seat handoff, `teleported` buffer-clear racing a re-seat). Reproduce in a
   controlled soak, trace which phase leaves rendered stale. Not a rewind-math fix.
3. **`targetTransit` symmetry assumption.** `ghostBack` subtracts the target's
   downlink transit measured on its uplink — asymmetric routing lands ±half the
   jitter. Minor; fixing needs per-direction SRTT, hard to get.
4. **History sample rate.** Samples land at broadcast-record rate (~20–25Hz), so
   interpolation granularity is ~40–50ms. The samples could carry the target's
   *tick-simulated* state at 20Hz broadcast fidelity already; raising rate costs
   memory for marginal gain — not worth it.
5. **`MAX_REWIND_MS=400` + `renderLagBoundOf ceiling 800`.** The buffer covers the
   claim ceiling; if the bound's ceiling ever tightens (Valorant's 140ms lesson is
   player-pain-based, not technical), `REWIND_MS` must shrink in step or deep claims
   clamp at the buffer floor.
6. **`rg` soak as a CI gate.** `ghostsoak` output is percentiles — a regression gate
   (p95, max, stationary-rg) would catch netcode edits that break the contract.
   Needs a baseline plus a wt-lane variant.

## Related docs

- `_docs/2026-10-23_REMOTE_THREE_TRUTHS.md` — rendered/wire/ghost model
- `_docs/2026-10-22_NET_RESIDUALS_PLAN.md` — parity/ghost divergence plan
- `deployment/known-issues.md` — `ghosts.max` 51m on WT, state-hash desync on death edges
