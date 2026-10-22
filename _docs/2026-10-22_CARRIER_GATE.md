# Capper Carrier-Gate Fix

**Status:** partial — Edit 1 + Edit 4 shipped; arrival deceleration abandoned (wrong tool)
**Owner:** capper strike (bot AI)
**Living doc — update as fixes land.** Companion to `_docs/2026-10-15_CAPPER_STRIKE.md`.

## Problem

The capper (flag carrier) can park 20–32 m short of home and drop the flag
instead of scoring. Soak autopsy (oasis s1): 90 s stalled at odHome 20–32,
move state `mv=---P` (parked, no ski/jet/jump). Across the 3 disjoint
seed sets the honest scoreboard is caps/run ≈ 0.82–0.85, grabV ≈ 20–22 m/s
mean (per-run 15–55) — roughly half the 50 m/s noob floor.

The stall-escape (`!ctx.running` → botLines stall escape) was already live
(measured: ctx.running is true on 225/225 carrying thinks, false otherwise).
The leak is elsewhere: the **park decision itself** does not distinguish a
carrier from a non-carrying runner, so a carrier can satisfy the park gate
and brake 20–30 m short of home.

## Research basis (revised 2026-10-22)

- **Craig Reynolds, "Steering Behaviors For Autonomous Characters" (GDC 1999):**
  - *Seek* drives through the target at full speed → "moth buzzing around a light bulb"
    overshoot/orbit. **This is the park↔jump churn.**
  - *Arrival* (ramp velocity to zero inside stopping radius) is the WRONG
    tool here — it kills speed and makes the carrier a sitting duck. The first
    attempt (park at 30m) regressed peaks carry 70.9→0s. **Deceleration is
    not the fix.**
  - *Offset pursuit:* steer toward a point offset from a moving target at a
    given radius — "fly-by" not collision. **Application:** the grab-orbit
    already does this for runners (orbit at pickup radius, not dive-through).
    The carrier exception (belowFlag widening) handles the vertical orbit case.
  - *Path following / flow fields:* follow a predetermined path spine, stay
    within radius. **Application:** terrain-trap bounce (~30s at 110-220m) —
    carrier should follow a route home, not free-form seek.

- **Tribes is about speed and trajectory, not deceleration.** A capper's
  speed IS the game — you don't slow down to land on the pole, you aim your
  trajectory to hit the touch ring at speed (like a strafing run). The 50 m/s
  grab target requires maintaining speed through the stand, not bleeding it.
  Deceleration should be used **very sparingly** — only when an overshoot is
  unavoidable (e.g., a wall face that can't be mounted at speed).

- **Tribes wiki (flag mechanics):** a dropped flag can be picked up by a
  teammate to finish the capture (instant return on pickup). So a drop near
  home is recoverable if someone grabs it. The carrier must re-grab if alone.

- **Correction log (2026-10-15):** "Never infer a flag's semantics from the
  goal builder's source — instrument it and count." `ctx.running` is true on
  225/225 carrying thinks; `ctx.runner` is the role flag (428/428).

## Root cause in `shared/botMoves.ts`

The park block (line ~201) had NO carrier check:
```ts
if (ctx.posted && spd0 > 1.5 && toward && od < ring + (spd0 * spd0) / 60) {
```
A carrier who is `posted` (has a posted anchor) and moving fast toward home
satisfied this and park-braked 20-30m short. This is the "parked at
odHome 20-32" defect.

The breath/perch block (line ~217) gates on `!ctx.runner`, which correctly
excludes carriers (runners don't perch — parking to refill tank makes them a
sitting duck). This was correct as-is; do NOT change it.

## Fix plan

### Edit 1 — Park block: exclude carriers (SHIPPED)
```ts
// Before:
if (ctx.posted && spd0 > 1.5 && toward && od < ring + (spd0 * spd0) / 60) {
// After: a carrier must never park-brake short of home.
if (ctx.posted && !ctx.running && spd0 > 1.5 && toward && od < ring + (spd0 * spd0) / 60) {
```

### Edit 2 — Arrival deceleration: DEFERRED (wrong tool)
Reynolds arrival (ramp velocity to zero) was attempted twice:
1. Park at 30m → regressed peaks carry 70.9→0s (carrier stopped, became
   a sitting duck, bots killed him, flag dropped).
2. Crawl arm at 30m (walk + mount) → still regressed (carrier stopped at
   125m, never reached home).

**Lesson:** Tribes is about speed and trajectory. Deceleration kills the
carrier's defense (speed) and makes him a target. The correct approach for
the park-short defect is NOT to decelerate — it's to **not park at all**
(Edit 1 already does this). The grab-orbit brake (lap detector) handles
the overshoot case for runners; carriers should use offset pursuit (orbit
at pickup radius) and path-following (route home), not deceleration.

If a carrier overshoots the pole at speed, the fix is better *aiming*
(offset pursuit around the stand) and *routing* (path-following home), not
braking. Deceleration is a last resort for wall faces that can't be mounted
at speed (and even then, the mountCommit block handles it via breathHold).

### Edit 3 — Breath/perch block: NO CHANGE (reverted)
Original `!ctx.runner` exclusion is correct. Carriers (runners by role)
must not perch — parking to refill tank makes them a sitting duck.

### Edit 4 — Drop-and-never-score (SHIPPED, RoomFlags.ts)
Clear `airborneBy` + `throwFrom` on carrier death (drop) and capture
(home return). Prevents the ex-thrower guard from leaking across a flag
return and blocking re-grab.

## What actually fixes the park-short defect

Edit 1 alone. The park block was designed for non-carrying runners on the
enemy stand (posted anchors). It was firing for carriers (who are also
`ctx.runner` by role) and braking them 20-30m short of home. Adding
`!ctx.running` excludes carriers. No deceleration needed — the carrier
just runs home at speed, and the grab-orbit brake handles any overshoot.

## Measurement protocol (established)

- 3 disjoint seed sets, ~48 runs each, 6 maps.
- Metrics: caps/run, grabV (m/s).
- Noise floor: <0.05 caps/run or <2 m/s grabV across ~126 runs is noise.
- Baseline: caps/run ≈ 0.82–0.85, grabV ≈ 20–22 m/s mean (per-run 15–55).
- Target: 50 m/s grab, good cap times.

## Tuning constants (shared/botTuning.ts relevant entries)

- `grabWatchGd`: 30 (wider orbit-detection ring)
- `grabOrbitS`: window for lap detection
- `grabOrbitMinGain`: min closure per window to avoid lap classification
- `parkRingFast` / `parkRingSlow`: park brake rings
- `parkSpeedSplit`: speed threshold for fast/slow ring
- `crawlHopGd`: crawl hop distance
- `breathRise` / `breathArm` / `breathHold`: tank thresholds
- `mountE`: mount energy floor

## Landmines

- `ctx.running` is NOT a role flag — it's true only while carrying. `ctx.runner`
  is the role flag (true for all cappers all the time). Conflating them is the
  bug. Every gate must ask "am I carrying?" (`ctx.running`) separately from
  "am I a capper?" (`ctx.runner`).
- The grab-orbit brake's `belowFlag` widening (3× watchGd for carriers below
  elevated home) must NOT be removed — it's the fix for the vertical orbit.
- `park` releases the walk key (forward input overrides friction). A carrier
  who parks to bleed speed must still re-engage walk once below arrivalSpeed,
  or he stalls permanently. The crawl transition handles this.
- Tuning changes must be validated on 3 disjoint seed sets; single-seed
  wins are usually basin luck (correction log: bend-brake 1.1→1.6 measured
  +18% on tuned seed, +0.1% on two unseen sets).
- Sim determinism: no `Date.now`/`Math.random`/`new Date` in shared/. Use
  seeded RNG or tick-derived time.
- `resultSigner` determinism: injectable stamps (already fixed).

## Status

- [x] Research complete (Reynolds arrival/offset-pursuit/path-following, Tribes flag mechanics, correction log)
- [x] Root cause located (park block carrier-blind)
- [x] Edit 1 shipped: park block `ctx.posted && !ctx.running`
- [x] Edit 4 shipped: RoomFlags airborneBy/throwFrom clear on drop + capture
- [~] Edit 2 (arrival deceleration): **abandoned — wrong tool.** Tribes is
  about speed and trajectory. Deceleration kills defense and makes carriers
  sitting ducks. The real fix is Edit 1 (don't park) + better aiming/routing.
- [x] Edit 3: reverted (original `!ctx.runner` was correct)
- [ ] Run 3-seed measurement on Edit 1 + Edit 4, compare to baseline
- [ ] If terrain-trap bounce persists, apply path-following (flow field /
  precomputed route home) — NOT deceleration
- [ ] Update this doc with results