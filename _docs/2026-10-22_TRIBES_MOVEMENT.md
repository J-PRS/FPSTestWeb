# Tribes Movement — Full Report

**Written:** 2026-10-22
**Source:** KRIBES repo (shared/botMoves.ts, shared/botTuning.ts, shared/botBrain.ts,
server_bun/src/botRouting.ts, _docs/2026-10-15_CAPPER_STRIKE.md,
.agents/memory/corrections.md, _reference/tribes-physics, T1/T2/T:A reference installs)
**Scope:** Movement physics, energy management, terrain reading, and bot AI
application for a Tribes-style browser FPS.

---

## 1. Core movement model

### 1.1 Skiing (the foundation)

Skiing is **frictionless momentum transfer**. When a bot skis, ground friction
is zero — the bot slides on the terrain surface at constant speed (minus
gravity redirection). This is the single most important mechanic: skiing is
the only way to preserve speed.

- `groundFriction = 50 m/s²` — an un-skiing grounded bot stops in ~0.4 s
  from 20 m/s. Without ski, you bleed speed instantly.
- `ski` flag in `botMoves.hints()` controls whether the bot skis. When
  `ski=false`, ground friction applies and the bot decelerates.
- **Skiing on a descent pumps speed**: the sim redirects velocity along the
  slope, killing only the into-ground component. A grounded descent converts
  potential energy (height) into kinetic energy (speed). This is the core
  speed-generation mechanism.
- **Skiing on an ascent** is bad: ski is frictionless, so a bot that skis
  UP a ridge it can't jet over slides back down and re-climbs forever
  (the "Sisyphus orbit"). Hence `skiVetoRise` (2.7m): don't ski up a steep
  grade when slow.

### 1.2 Jetpack (thrust)

The jet is **up-dominant thrust**: `jetForceUp = 35 m/s²`, `jetForceDir = 10 m/s²`.
- Horizontal acceleration from jets is only 10 m/s² — jets alone cannot push
  forward past 50 m/s (`jetMaxFwdAccel = 50`).
- The jet's primary role is **vertical**: climbing, mounting, maintaining
  altitude. Horizontal speed comes from terrain (skiing/descent pumping).
- `ENERGY` drain/charge/max: 15/s, 8/s, 60. A full tank is 4 s of burn.
- `terminalVelocity = 100 m/s` — the fall cap.

### 1.3 Gravity

`GRAVITY = -28 m/s²`. A 45 m descent ≈ 50 m/s (free-fall conversion).
- Grounded: velocity redirects along slope (pump). Only the into-ground
  component is killed.
- Airborne: velocity is NOT redirected. You fall (vy increases) but
  horizontal speed is unchanged. **Airborne descent does NOT pump speed.**

This distinction is critical: a bot that hops over a descent loses the pump.
The `travelDescent` veto exists precisely to prevent this.

### 1.4 The movement pipeline

```
ServerBots.think() → botRouting.flagGoal() → goalPos (d0)
  → botBrain.pickDest() → botLines.plan() (d1) → botSteer (d2) → botMoves.hints() (buttons)
```

- `botRouting` picks the destination (where to go).
- `botLines` plans the path (terrain-aware routing, orbit escape).
- `botSteer` steers toward the waypoint.
- `botMoves.hints` decides ski/jet/jump/park buttons.

---

## 2. Speed generation (how you get fast)

### 2.1 The two paths to 50 m/s

1. **~45 m of descent** — grounded skiing down a slope converts potential
   energy to kinetic energy. The bot redirects velocity along the slope.
2. **~2.5 s of burn from a full tank** — 10 m/s² × 2.5s = +25 m/s on top
   of ~20-25 m/s arriving speed. Requires arriving with gas left.

Both need the approach to **end downhill** (or arrive with energy to burn).

### 2.2 Terrain reading (the skill)

The capper reads terrain to find the slope that converts vertical fall into
speed with least loss. This is the core skill — not tuning, but *reading*.

- **Find the descent**: look ahead for a slope that falls away. Ski it.
  Gravity pumps speed. Don't jet (jets fight the descent). Don't hop
  (hops are airtime the slope can't pump).
- **Find the climb**: when the way ahead rises, jet to minimize speed loss.
  The jet's up-force (35 m/s²) fights gravity; the horizontal component
  (10 m/s²) is a bonus.
- **Find the apex**: at the top of a jump, if the next peak is at a shallow
  angle (barely reachable), jet to extend the trajectory. This chains
  descents — more descent = more speed.
- **Steer at apex**: lateral jet to adjust trajectory mid-air (air-strafe).
  This lets you aim your fall to hit the next slope at the right angle.

### 2.3 The descent pump (grounded vs airborne)

| Situation | Speed effect |
|---|---|
| Grounded descent (ski) | **Pumps** — velocity redirects along slope, into-ground component killed |
| Airborne descent (fall) | **No pump** — horizontal speed unchanged, vertical speed increases |
| Grounded ascent (ski up) | **Loses speed** — frictionless but gravity decelerates |
| Airborne ascent (jet up) | **Maintains speed** — jet thrusts against gravity |

The bot's `travelDescent` veto (`!travelDescent`) prevents hops on descents:
a hop is airtime the slope can't pump. Humans hold ski and stay glued.

### 2.4 Energy banking

- **Bank leg**: save energy for the stand approach. Veto discretionary burns
  (boost, tap, hop, destHigh) so regen refills the tank. The strike leg
  (inside `strikeGd` = 140m) burns everything — arrival speed is the armor.
- **A full tank at the stand** = 4s of burn = +40 m/s (capped at 50
  forward accel). This is how you reach 50 m/s: arrive at 20-25 m/s with
  a full tank, then burn for 2.5s.
- **The tank was empty at the stand** (the #1 measured problem): the bank
  leg was spending regen on hop/destHigh. Widening the bank window and
  vetoing every discretionary burn was the biggest single win.

---

## 3. The jet system (botMoves.hints)

### 3.1 `wantJet()` — the burn decision table

The jet decision is a priority-ordered surface with multiple gates:

1. **Posted anchors**: burn only to climb back onto the post. Every
   discretionary burn is altitude+momentum off the stand.
2. **Target high**: hunt targets that are clearly airborne get altitude burns.
3. **Sky-bank**: past `jetMaxFwdAccel` (50), a held jet adds ZERO forward
   thrust but full +35 up. A fast airborne runner burning while gliding
   spends nothing horizontal and banks altitude as potential. Needs real
   runway (od), real speed (vSpd ≥ 45), and air under the arc.
4. **Hard ceiling**: past ~30m AGL, a held burn is ballooning, not skiing.
   High prey still earns altitude; everything else glides back down.
5. **Comfy energy gate**: discretionary spending asks for a healthier tank
   (comfyEnergy = 35). Climbing out of a hole is not discretionary.
6. **Climb gate**: `rise > climbRise` → jet (uphill). This is the core
   "up to continue with least loss using jet" rule.
7. **Bank leg veto**: inside the bank window, veto boost/tap/hop/destHigh
   (only real climbs spend).
8. **Strike leg discipline**: inside the strike window, only climb/runIn
   spend (tank exists for the run-in forward burn).
9. **mountE floor**: no burn may start below 15 energy (load-bearing).
10. **Tail tap**: jet only on the descending arc of each hop (the human
    timing trick — ~43 m/s at 1/10 the energy per meter).
11. **Cruise burn**: grounded-only forward burn for runners/wave (ski contact
    is frictionless, so forward jet converts straight into speed).
12. **Run-in burn**: committed runner closing on a near-level objective
    keeps thrusting to ~26 m/s (arriving through the flag at speed).
13. **Boost**: discretionary speed play when slow, flat, tanked.

### 3.2 `jetHold` — the burn latch

- Arms when `wantJet()` is true and tanked: `jetHold = max(jetHold, 0.84-1.32s)`.
- Re-arms while the reason holds (long climb = one long burn).
- Minimum pulse prevents gate flicker from chopping the burn.
- `diveRun` (approaching a dive) zeroes jetHold (coast instead of burn).
- `inGlide` / `landDive` zero jetHold (landing phase).

### 3.3 `travelDescent` — the hop veto on descents

```ts
private travelDescent(ctx, pos, speed): boolean {
  // Under 15 m/s, no pump to protect — hop down the slope is free airtime.
  if (speed < 15) return false;
  if (ctx.running) return false;  // carrier: the lip hop at the descent bottom IS the escape speed
  // Dead-reckon 12m along velocity; if ground falls away, it's a descent.
  const drop = groundY(pos) - groundY(pos + vel/speed * 12);
  return drop > hopDescRise * 2;
}
```

Carrier exception: a carrier's lip hop at the descent bottom is his escape
speed — gluing him rides the slope into bad lines.

### 3.4 `arcClearsCrest` — dead-reckoned arc prediction

Marches the ballistic arc (vel + gravity, 0.12s steps, 24 steps = ~2.9s)
and checks if it clears a downslope entry. If the arc would smack a rising
face, the burn is needed. If it reaches a downslope, ski is free.

### 3.5 `arcThreadsFlag` — don't hop over the pole

Vetoes hops when the no-thrust arc already reaches the flag window
(±6m vertical). A hop only adds altitude — exactly what killed the dunes
fast passes (40 m/s arrival, hop added vy≈13, sailed 15m over the pole).

---

## 4. Tactical decisions

### 4.1 When to ski
- **Always ski on descents** (frictionless, gravity pumps speed).
- **Don't ski up steep grades you can't jet over** (skiVetoRise 2.7m, skiVetoSpeed 10 m/s).
- **Don't ski on flat ground at walking pace** (boost handles this).
- **Posted anchors**: don't ski (boots planted, friction owns landings).

### 4.2 When to jet
- **Climb**: rise > climbRise → jet (uphill, minimize loss).
- **Apex**: if you see you need help to hit the next peak at a shallow angle → jet to extend trajectory.
- **Steer**: lateral jet to adjust trajectory mid-air (air-strafe).
- **Sky-bank**: past 50 m/s, jet up (altitude banking, no horizontal cost).
- **Run-in**: committed runner on flat, thrust to ~26 m/s.
- **Boost**: discretionary speed play when slow, flat, tanked.
- **Don't jet**: on descents (travelDescent veto), when turning (carve suppressor), when tank < mountE, when ballooning (>30m AGL).

### 4.3 When to decelerate (tactical only)
- **Only before a hill impact** where you'd lose more speed on impact than
  a brief friction tap would cost.
- Compare: decel cost (0.1-0.3s friction) vs impact cost (5-15 m/s on a
  bad hit). If decel < impact, release ski briefly, then re-engage.
- **Never** use deceleration as a general strategy (arrival, parking, etc.).
- Speed is life — don't bleed it unless the math says it's cheaper.
- **Implemented as Edit 5** (tactical ski-release): 0.15s friction tap when a
  carrier is going >25 m/s toward a steep rise (>2.7m). Re-engages ski after
  the tap. No regression (capRun 3/3 pass, capStat identical to baseline).

### 4.4 When to hop
- **Mounting lips** (rise > stepRise, near-stationary or mountCommit).
- ** NOT on descents** (travelDescent veto — skiing converts gravity to speed).
- **NOT when the arc already threads the flag** (arcThreadsFlag veto — hop
  adds altitude the grab can't spend).
- **NOT when gluing is better** (grounded ski is frictionless, hop buys
  nothing on flat ground).

### 4.5 When to park (release walk key)
- **Only when posted** (anchor on a stand, can't move).
- **Never for carriers** (Edit 1: `ctx.posted && !ctx.running`).
- **Mount-wait** (dry tank on a lip, park until refill).
- **Breath** (perch on a steep climb to refill tank — runners only).

---

## 5. Terrain reading (the skill)

### 5.1 Finding the descent
- Look ahead for a slope that falls away. Ski it. Gravity pumps speed.
- The `rise` probe (6m ahead) tells you if the ground climbs or falls.
- `travelDescent` checks 12m along velocity for a falling surface.

### 5.2 Finding the climb
- When the way ahead rises (`rise > climbRise`), jet to minimize speed loss.
- The `destHigh` check: destination is high → need altitude burn.
- `arcClearsCrest` checks if the free arc reaches a downslope entry.

### 5.3 Finding the apex
- At the apex of a jump (vy ≈ 0, airborne), look ahead to the next peak.
- If the next peak is at a shallow angle (barely reachable), jet to extend.
- If the angle is steep (easily reachable), don't jet — gravity will carry you.
- **Implemented as Edit 6** (`apexNeedsJet` method): dead-reckons the no-thrust
  arc forward. If it hits ground before reaching a downslope (rising ahead),
  jet to extend the trajectory over the rise and land on the downslope.
  `wantJet` returns true with `jetWhy = 'apex'` when `airborne && apex &&
  energy > tapEnergyMin && apexNeedsJet()`. No regression (capRun 3/3 pass).
- This is the "sky-bank" concept: past 50 m/s, jet up (altitude banking)
  with no horizontal cost, then convert on the next descent.

### 5.4 Finding the pass (crest evaluation)
- For a stand in a moat/basin, the straight line goes through the basin.
- Evaluate crests (argmax along bearing, dips allowed) — find the pass
  that gives the best arrival speed.
- Price: `(crestH - standY) - climbBack * 1.2 - detour * 0.15` + affordability
  gate (`crest > pos.y + v²/56 + tank*0.5`).
- The descent-head routing in `botRouting.ts` does this for the enemy stand.
  The carrier's return home should use the same (currently beelines).

---

## 6. The physics budget (arrival speed)

| constant | value | means |
|---|---|---|
| `GRAVITY` | -28 m/s² | 45 m descent ≈ 50 m/s |
| `jetForceUp` / `jetForceDir` | 35 / 10 m/s² | thrust is up-dominant |
| `jetMaxFwdAccel` | 50 m/s | jets alone can't push past 50 horizontally |
| `terminalVelocity` | 100 m/s | fall cap |
| `ENERGY` drain/charge/max | 15/s, 8/s, 60 | full tank = 4s burn |
| `groundFriction` | 50 m/s² | un-skiing bot stops in 0.4s from 20 m/s |

**50 m/s is reachable two ways:**
1. ~45 m of descent (grounded skiing, gravity pumps speed)
2. ~2.5 s of burn from a full tank (10 m/s² × 2.5s = +25 m/s on top of
   ~20-25 m/s arriving)

Both need the approach to **end downhill** (or arrive with energy to burn).
A stand on a rising apron (katabatic bravo) makes the last 40m a climb —
burns buy altitude, not speed.

---

## 7. The capper's approach pipeline

```
botRouting.flagGoal() → goalPos (d0)
  → botBrain.pickDest() → botLines.plan() (d1) → botSteer (d2) → botMoves.hints (buttons)
```

Capper-specific stages:

1. **Bank leg** (`bank`): `runner` and `140 < od < strikeBankGd` (320). Only
   a real climb (or live prey chase) may burn. Everything else (hop, destHigh,
   boost, tap) is dropped so regen refills the strike tank.

2. **Strike leg** (`strike`): `runner` and `od < strikeGd` (140). Drops the
   comfy energy gate so the tap floor is `strikeTapMin`.

3. **Stand press** (~line 507): once the lane to the stand is clear, aim =
   `enemyStand + trackLead + passThrough - altitudePull`.
   - `passThrough` = min(40, dStand*0.5) along home direction (exit wraps
     toward home for free).
   - `altitudePull` = clamp((dy-5)*1.6, 0, 24) aims short when high — a
     deliberate brake.
   - `passCommit` latch: gates are `spd > 14 && dStand > 20`. Latched to
     prevent aim limit cycle in the last 40m.

4. **Ring entries** (`RING_MAX=150`): elected only when the straight lane is
   blocked. Entries score `(drop - rise)*1.5` for cappers over the last 1/8
   of the leg.

5. **botLines.plan**: inside `runnerDirectGd` (48m) the runner is handed the
   pole itself; outside, the flood hop each think.

6. **botMoves.hints**: the whole approach game (ski/jet/jump/park buttons).

---

## 8. What went wrong (measured, 2026-10-15)

Baseline: **caps/run 0.67, grabV 19.1 m/s, grabT 69.5s.**

- **Tank empty at the stand**: bank leg was spending regen on hop/destHigh.
  Widening bank window + vetoing all discretionary burns = biggest single win.
- **Aim limit cycle in last 40m**: passCommit latch fixed this.
- **Terrain traps mid-route**: katabatic 9002 burned ~30s bouncing 110-220m
  in a bowl. Staging orbit theory was wrong (standoff never armed).
- **Anti-churn layers trade grabV for caps/run**: both botGraph bend-brake
  and botLines escape are live and both are net wins (confirmed on disjoint
  seed sets).

---

## 9. The capper's approach pipeline (bot AI)

The bot tries to replicate human routing:

1. **Bank energy**: save tank for the stand approach. Veto discretionary
   burns so regen refills.
2. **Route terrain-aware**: crest evaluation (find the pass over terrain),
   not free-form seek. Avoid basins.
3. **Aim through the stand**: passThrough toward home, not stop at the pole.
   altitudePull only when high.
4. **Jet for climbs, ski for descents**: minimize speed loss on uphills,
   maximize speed gain on downhills.
5. **Hop only for mounting**: not on descents (travelDescent veto), not when
   the arc already threads the flag (arcThreadsFlag veto).
6. **Tactical deceleration**: brief ski-release before steep hills at high
   speed, only when decel cost < impact cost.
7. **Don't park short**: carriers must never park-brake on the ring
   (Edit 1: `ctx.posted && !ctx.running`).

---

## 10. Common mistakes / anti-patterns

- **Decelerating near home** — kills speed, makes sitting duck. Use Edit 1
  (don't park) + better aiming/routing instead.
- **Lowering mountE** — measured worse on every axis (grabV 22.4→15.0).
  A capper arriving with 2 E can't mount the dais.
- **Tuning on single seeds** — basin luck dominates. Always validate on 3+
  disjoint seed sets.
- **Mixing capRun.test.ts with capStat** — bare vs. real map specs. Don't mix.
- **Inferring flag semantics from source** — `running` looks like a role flag
  but means "carrying." Always instrument and count.
- **Hopping on descents** — kills the descent pump. Ski instead.
- **Skiing up steep grades** — slides back down. Walk-hop-jet instead.
- **Empty tank at the stand** — the #1 measured problem. Preserve energy.

---

## 11. What I got wrong and learned (corrections)

1. **Deceleration is not arrival** — I tried to slow carriers down near home
   (Reynolds arrival), which killed their speed and made them sitting ducks.
   The user corrected me: decel is a tactical ski-release, not a general
   strategy. Speed is life.

2. **Vertical fall → slope conversion** — vertical fall is great IF you hit a
   slope at the right angle to convert vertical velocity into horizontal speed.
   A flat landing wastes all that energy. The bot must aim its fall to hit the
   right slope. (User insight.)

3. **Uphill = jet, downhill = ski** — going up, jet to minimize speed loss
   (thrust against gravity). Going down, ski (harness gravity, don't jet, let
   the slope pump you). The jet is up-dominant (35 m/s² up, 10 m/s²
   horizontal) — it fights gravity primarily.

4. **Apex jetting** — at the apex, if you see you need help to hit the next
   peak at a shallow angle, jet to extend. Or to steer (lateral air-strafe).
   Implemented as Edit 6 (`apexNeedsJet` method). Proactive jetting, not just
   reactive climbing.

5. **Tuning is at a plateau** — every threshold change lands in noise on
   disjoint seed sets. The gains come from structural changes (bank veto,
   passCommit, crest routing), not knob-turning.

6. **Single-seed results are lies** — basin luck dominates. Always validate
   on 3+ disjoint seed sets.

7. **`ctx.running` is not a role flag** — it's true only while carrying.
   `ctx.runner` is the role flag. Conflating them is the bug.

4. **`ctx.running` is not a role flag** — it's true only while carrying.
   `ctx.runner` is the role flag. Conflating them is the bug.

5. **The capper reaches 40-61 m/s mid-route** — arrival speed is not a speed
   cap, it's preservation. The problem is bleeding speed across the final
   ~100m, not generating it.

---

## 12. Measurement commands

```bash
cd server_bun
# The scoreboard (run these, don't eyeball it):
bun ../_tools/sweeps/capStat.ts --maps oasis,broadside_nef,escalade,raindance_nef,katabatic,surreal --seeds 1,7,11
bun ../_tools/sweeps/capStat.ts --maps katabatic --seeds 1,7 --repeat 3 --verbose
bun ../_tools/sweeps/approachProbe.ts --map katabatic --seeds 9002 --window 2000 --dt 40
bun ../_tools/sweeps/approachProbe.ts --map katabatic --seeds 9002 --window 60
# Regression gate:
bun test tests/scenarios/capRun.test.ts
```

- `caps/run` first (a run that never caps makes every other number meaningless).
- Then `grabV` (planar speed at the grab instant — the "50 m/s grab").
- Then `grabT`, `carry`, `pace`, `appE`/`peakE`.
- Rooms carry the **real map spec** (structures included).
- `--set moves.X=N` pokes one BOT_TUNING knob for an A/B.
- `capRun.test.ts` uses the **bare** room (no map spec) — don't mix numbers.

---

## 13. What's next (priority order)

1. **Offset pursuit refinement** for grab-orbit — carrier exception only
   fires below elevated homes; flat-approach carriers get no orbit brake.
   This is the biggest remaining structural gap.

2. **Path-following for terrain-trap bounce** — extend crest-evaluation
   routing (already in botRouting.ts for descent-head) to the carrier's
   return leg. Currently beelines from 200m, which hits basins.

3. **Tactical ski-release tuning** — currently conservative (speed>25,
   rise>2.7, 0.15s). Could be tuned but skiVetoSpeed changes are high-risk.

4. **Full 6-map × 3-seed measurement** to establish a proper post-fix
   baseline and compare to the 0.82-0.85 / 20-22 m/s baseline.

5. **Terrain-aware aiming** — aim the fall to hit slopes at the right angle
   (user insight: vertical fall → slope conversion). The passThrough and
   altitudePull are crude proxies; the bot should read the terrain and aim
   at the slope that converts vertical velocity to horizontal speed.

6. **Apex jetting tuning** — currently fires when vy ≈ 0 and the no-thrust
   arc hits a rising face. Could be tuned to fire more aggressively at
   shallow angles. Needs measurement on more seeds.
