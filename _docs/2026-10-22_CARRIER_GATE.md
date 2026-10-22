# Capper Carrier-Gate Fix

**Status:** in progress (2026-10-22)
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

## Root cause in `shared/botMoves.ts`

`BrainHints.hints()` has several carrier-blind gates:

1. **Grab-orbit brake** (line ~136) — already has a carrier exception:
   `ctx.runner && (!ctx.running || belowFlag)`. Good for the *vertical* orbit
   case, but the `belowFlag` widening only triggers when the carrier is below
   an elevated home (`dyAbove < -6 && > -25`). A carrier on a flat approach
   never enters this branch, so the lap detector never arms for him.

2. **Park block** (line ~168) — **no carrier check at all:**
   `if (ctx.posted && spd0 > 1.5 && toward && od < ring + (spd0*spd0)/60)`
   A carrier who is `posted` (has a posted anchor) and moving fast toward
   home satisfies this and park-brakes short. This is the "parked at
   odHome 20-32" defect.

3. **Breath/perch block** (line ~195) — gated on `!ctx.runner`, which
   excludes carriers (who are runners by role). A carrier climbing an
   elevated home can never perch to refill tank → sputters on the face.

4. **Drop-and-never-score** (server side, `server_bun/src/RoomFlags.ts`) —
   `tickDropped` / return-by-touch clear `airborneBy` on home-return, but the
   correction log flags that a dropped flag near home can be abandoned instead
   of re-grabbed. Carrier must re-enter grab behavior on drop, not abandon.

## Research basis

- **Craig Reynolds, "Steering Behaviors For Autonomous Characters" (GDC 1999):**
  - *Seek* drives through the target at full speed → "moth buzzing around a
    light bulb" overshoot/orbit. **This is the park↔jump churn.**
  - *Arrival* = seek while far, ramp desired velocity to zero inside a
    stopping radius. Character slows as it approaches and stops *at* the
    target. **Application:** carrier's final approach to home should be an
    arrival (decelerate), not a seek.
  - *Offset pursuit:* steer toward a point offset from a moving target at a
    given radius — "fly-by" not collision. **Application:** grab-orbit at
    pickup radius, not dive-through. Already done for runners; carrier
    exception only fires below elevated home.
  - *Path following / flow fields:* follow a predetermined path spine, stay
    within radius. **Application:** terrain-trap bounce (~30 s at 110-220 m)
    — carrier should follow a route home, not free-form seek.

- **Tribes wiki (flag mechanics):** a dropped flag can be picked up by a
  teammate to finish the capture (instant return on pickup). So a drop near
  home is recoverable *if* someone grabs it. The carrier must re-grab if
  alone, not abandon.

- **Correction log (2026-10-15):** "Never infer a flag's semantics from the
  goal builder's source — instrument it and count." `ctx.running` is true on
  225/225 carrying thinks; `ctx.runner` is true on 428/428 (role flag).

## Fix plan

### Edit 1 — Park block: exclude carriers (shared/botMoves.ts ~line 168)
```ts
// Before:
if (ctx.posted && spd0 > 1.5 && toward && od < ring + (spd0 * spd0) / 60) {
// After: a carrier must never park-brake short of home.
if (ctx.posted && !ctx.running && spd0 > 1.5 && toward && od < ring + (spd0 * spd0) / 60) {
```

### Edit 2 — Arrival-style deceleration for carriers (new block, before park)
```ts
// Reynolds arrival: decelerate into home instead of overshooting.
if (ctx.running && ctx.objective && od < T.moves.arrivalGd && spd0 > T.moves.arrivalSpeed) {
  return { ski: false, jet: false, jump: false, park: true };
}
```
New tuning constants in `shared/botTuning.ts`: `arrivalGd` ~30, `arrivalSpeed` ~8.

### Edit 3 — Breath/perch block: allow carriers to perch on elevated home (~line 195)
```ts
// Before: !ctx.runner excludes carriers (who are runners by role).
if (!ctx.posted && !ctx.runner && ctx.energy !== undefined && !airborne && rise > T.moves.breathRise) {
// After: exclude only non-carrying runners; carriers may perch when climbing home.
if (!ctx.posted && !(ctx.runner && !ctx.running) && ctx.energy !== undefined && !airborne && rise > T.moves.breathRise) {
```

### Edit 4 — Drop-and-never-score (server_bun/src/RoomFlags.ts)
Ensure `tickDropped` / return-by-touch clear `airborneBy` on every path
(already done on home-return at line ~403 and on grab at ~493/507/515).
Verify the client-side prediction (`lazyClient`) also clears the guard.
Carrier's bot brain must re-enter grab behavior on drop instead of
abandoning.

## Measurement protocol (established)

- 3 disjoint seed sets, ~48 runs each, 6 maps (katabatic, oasis, peaks, etc.)
- Metrics: caps/run, grabV (m/s mean + per-run range)
- Noise floor: <0.05 caps/run or <2 m/s grabV across ~126 runs is noise
- Baseline: caps/run ≈ 0.82–0.85, grabV ≈ 20–22 m/s mean (per-run 15–55)
- Target: 50 m/s grab, good cap times

## Tuning constants (shared/botTuning.ts relevant entries)

- `grabWatchGd`: 30 (wider orbit-detection ring)
- `grabOrbitS`: window for lap detection
- `grabOrbitMinGain`: min closure per window to avoid lap classification
- `parkRingFast` / `parkRingSlow`: park brake rings
- `parkSpeedSplit`: speed threshold for fast/slow ring
- `crawlHopGd`: crawl hop distance
- `breathRise` / `breathArm` / `breathHold`: tank thresholds
- `mountE`: mount energy floor
- `arrivalGd` / `arrivalSpeed`: NEW (Edit 2)

## Landmines

- `ctx.running` is NOT a role flag — it's true only while carrying. `ctx.runner`
  is the role flag (true for all cappers all the time). Conflating them is the
  bug. Every gate must ask "am I carrying?" (`ctx.running`) separately from
  "am I a capper?" (`ctx.runner`).
- The grab-orbit brake's `belowFlag` widening (3× watchGd for carriers below
  elevated home) must NOT be removed — it's the fix for the vertical orbit.
  Only the *flat-approach* case needs the new arrival deceleration.
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
- [x] Root cause located (park block carrier-blind, breath block carrier-blind, drop-handler guard leak)
- [x] Edit 1 applied: park block now `ctx.posted && !ctx.running` (carriers can't park-brake short of home)
- [x] Edit 4 applied: RoomFlags clears `airborneBy` + `throwFrom` on carrier death and capture (guard leak fix)
- [~] Edit 2 (arrival deceleration): **deferred** — first version (park at 30m) caused peaks regression (carry 70.9→0, caps 1→0). Second version (crawl arm at 30m) also regressed (carrier stopped at 125m, never reached home). Reynolds arrival needs a *gradual* deceleration, not an instant mode switch. Revisit with a speed-cap or proportional brake, not a full park/crawl flip.
- [~] Edit 3 (breath/perch for carriers): **reverted** — allowing carriers to perch made them sitting ducks (perch parks to refill tank, bots kill them). Original `!ctx.runner` exclusion was correct for carriers too.
- [ ] Run 3-seed measurement on Edit 1 alone, compare to baseline
- [ ] Re-attempt arrival deceleration with gradual approach (not full mode switch)
- [ ] Update this doc with results
