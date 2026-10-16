# Themed team matchups — and the warp collapse they exposed

Living reference for two things that ended up in the same session:

1. **`_tools/sweeps/teamSoak.ts`** — the themed team-vs-team warp soak
   ("railgun team vs mortar team"). How to run it, what its numbers mean,
   and the four traps that make a bench lie about itself.
2. **A throughput regression**: on the same box, in the same minute,
   `fastSoak` runs a **16-bot TDM room at 234x real-time but a 16-bot CTF
   room at 1x** — no headroom at all. The bot tick owns 100% of it, and
   the difference is flag-runners arming the new MPC planner.

Written 2026-10-16. Every number below is a real run of the command next
to it.

## Run it

```bash
# one weapon per side, 10 sim-minutes, ~4s of wall clock
bun _tools/sweeps/teamSoak.ts --alpha Railgun --bravo Mortar

# the A/B that exposed the regression (unmodified repo probe)
cd server_bun
FPS_SOAK_MS=6000 FPS_SOAK_MODE=tdm bun test tests/scenarios/fastSoak.test.ts   # 234x
FPS_SOAK_MS=6000 FPS_SOAK_MODE=ctf bun test tests/scenarios/fastSoak.test.ts   # 1x
```

| knob | default | meaning |
| --- | --- | --- |
| `--alpha W` / `--bravo W` | Railgun / Mortar | primary for each side (`WeaponType` name) |
| `--alpha2` / `--bravo2` | off | secondary for slots 2-3, drawn inside its own range band |
| `--per N` | 8 | bots **per side** |
| `--mins M` | 10 | sim-minutes to warp |
| `--wall S` | 120 | hard wall-clock cap (the honest stop, see Caveats) |
| `--map NAME` | katabatic | real map; stands/spawns come from its JSON |
| `--mode M` | tdm | tdm / ctf / dm (ctf needs `bases` in the map) |
| `--ring R` | 70 (0 in ctf) | half-separation of the two facing lines, metres |
| `--class T` | off | pin every body to light/medium/heavy (kit-faithful when off) |
| `--berserk` | off | never holster the primary (see trap 4) |
| `--arena M` | 0 | dome for bot roam targets only — it does **not** create contact |

Read this line first on every run:

```
contact meanSpeed=17.0m/s nearestFoe=798m hunt=0% over 600 samples
```

A matchup where the sides never meet produces a perfectly balanced 0-0
and an empty weapon ledger, which reads exactly like a broken tool. The
contact line says which it is: `hunt` near 0% with `nearestFoe` in the
hundreds of metres is starvation, not a stalemate.

## Four traps that make a bench lie

1. **TDM on a 1.5 km field starves by default.** No objective pulls 16
   bots together, and they ski *away* from each other at 17 m/s. Measured
   with `--ring 0`: nearest foe 773-798 m, `hunt 0%`, **zero shots in 10
   sim-minutes** (and, being empty, a flattering 141-183x warp). The
   fix is not the arena: `RoomArena` documents that its pull-back shove
   was removed and it only warns now, so an arena clamp changes bot roam
   *targets* and nothing else. `teamSoak` seats both sides on facing
   lines inside sight range instead, and **re-seats every respawn** — a
   bench that only seats at spawn drifts apart one death at a time.
   With `--ring 70`: nearest foe 69-80 m, hunt 92-99%.
2. **The warped kits leak away one life at a time.** Respawn adaptation
   (`adaptLoadout`) rerolls every slot that *has* alternates toward the
   bot's skill matrix, so a clean 8v8 railgun-vs-mortar room grows
   Chaingun / Shotgun / BoltLauncher rows as the match runs. Clearing
   `roster.alts` for every bot kills the reroll (no candidates = nothing
   to reroll). Symptom before the fix: the ledger listed 9 weapons for a
   2-weapon bench.
3. **Heavy kits silently lose their far gun.** `applyClass` rewrites
   `far` to Mortar on anything heavy ("heavies shoulder the mortar" —
   product behavior). Inject the kit, refit the body, then **write the
   kit again**, or a "PlasmaCannon team" fields Mortar at range and the
   scoreline is a lie. Related: a kit its own class can't fire is the
   quietest way to lose a bench — every shot comes back "class-locked
   weapon" — so the tool checks `kitConsistent` and shouts.
4. **CTF refits kits by role, and that is correct.** Flag modes assign
   strict roles, and the roster swaps illegal slots for legal staples
   (capper gets a Disc, HoF gets mines, medic gets the beam). A *pure*
   one-weapon team is a TDM/DM property; in CTF expect the leaders to
   carry their job's gun. Don't "fix" this in the bench.

Also: the ledger's `hits/sh` is per-slot **hits per shot**, not accuracy —
multi-projectile weapons exceed 100% legitimately (MRV bomblets read
317%, shotgun 247%), so the column is labelled for what it is. And a
mirror matchup shows **one** row for both sides (the table is keyed by
weapon), so the mirror's damage is the match total.

## What the matchups say (8v8, katabatic, seed 1337, 10 sim-min TDM)

| alpha | bravo | score | K/D a-b | medLife a/b | damage a-b | kills a-b |
| --- | --- | --- | --- | --- | --- | --- |
| Railgun | Mortar | 294-346 | 0.50 / 2.01 | 30 / 50 | 23087 / 19369 | 70 / 201 |
| Disc | Lightning | 317-286 | 1.05 / 0.96 | 34 / 42 | - | 156 / 149 |
| Chaingun | Shotgun | 218-241 | 1.08 / 0.93 | 32 / 48 | - | 120 / 111 |
| PlasmaCannon | Sprinkler | 132-145 | 1.80 / 0.56 | 82 / 70 | 11382 / 9080 | 57 / 32 |
| Bombard | MRVLauncher | 229-247 | 1.96 / 0.45 | 82 / 30 | 39283 / 18287 | 128 / 87 |
| Railgun | Railgun | 387-410 | 0.91 / 1.10 | 34 / 32 | 33054 (both) | 294 (both) |

Two things worth keeping:

- **The mirror is the bench's sanity check.** Railgun-vs-Railgun lands
  0.91 / 1.10 over 403 kills — a ~5% edge, i.e. the terrain and the
  harness are not structurally favouring a side. Any matchup reading
  outside ±15% is the weapons, not the seat.
- **Damage is not frags.** The railgun side out-damages the mortar side
  (23087 vs 19369) and loses 294-346. Splash converts: the mortar needs
  fewer, wider hits, while a 50 hp light body dies to one near-miss. That
  is the kind of question the K/D table alone can't answer and the ledger
  is in the report for.

## The finding: CTF ticks cost ~200x a TDM tick

`fastSoak` is the repo's own throughput probe and I changed nothing in
it. Same machine, same minute, same 16 bots, same map:

```
FPS_SOAK_MODE=tdm  ->  28120 ticks, 1406 sim-s in 6.0 wall-s - 234x real-time
FPS_SOAK_MODE=ctf  ->    140 ticks,    7 sim-s in 7.8 wall-s -   1x real-time
```

234x means the box has ~234 sim-seconds of headroom per wall-second
before a live 20 Hz room would fall behind. 1x means a 16-bot CTF room
**already consumes the whole tick budget** — no headroom, on the current
uncommitted tree. (The repo's capper doc recorded 73x for this same
probe, so this is a recent move, not the long-standing cost.)

Where it goes:

- `FPS_SIM_PROF=1` (teamSoak) - `bots=100%`, every other sim (`move`,
  `proj`, `flags`, `balls`, `pickups`, `crawl`, ...) rounds to 0%. It is
  one phase.
- `FPS_THINK_PROF=1` (fastSoak) - inside a think: `lines 50%`, `steer
  11%`, `moves 8%`, `hunt 6%`; `botProf` attributes `drive 99%`.

The arming site is `server_bun/src/ServerBots.ts:634`:

```ts
if ((ctx.runner || ctx.running) && ctx.objective && this.field) {
  this.mpcArm.set(id, ctx.running ? ctx.objective : (ctx.flagPos ?? ctx.objective));
}
```

i.e. **any capper or flag carrier on a map with a heightfield** arms
`BotMpc`, and `mpc.drive()` is called from the *move* path (line 663),
not the think path — a receding-horizon replan per tick per armed bot.
TDM/DM have no runners, so the MPC never arms there, which is exactly why
the two modes differ by two orders of magnitude.

Honest attribution: the A/B above is same-machine and mode-only, the
profiler puts 99% of bot time in `drive`, and the files that own that
path (`ServerBots.ts`, `botRouting.ts`, `serverSenses.ts`,
`RoomMoveSim.ts`, `shared/botBrain.ts`, plus the new `botMpc.ts`) are
uncommitted work in the tree that I did not touch, stash, or revert.
That is strong but circumstantial: a definitive attribution needs an A/B
of the WIP itself, which is the WIP owner's call. What is *not*
circumstantial is the capacity number: whatever owns it, a 16-bot CTF
room currently has no tick headroom.

## Caveats (read before quoting a ratio)

- **Wall-clock ratios are machine-dependent.** The absolute x-factor from
  any single run is not comparable across sessions on this box; I saw the
  same command report 0.4x, 87x, 150x, 183x and 234x within one afternoon
  depending on what else was running. Compare the *two arms of an A/B*
  taken back to back, never two numbers from different minutes.
- `--wall` is the reason a starving or contended run reports a small sim
  total: the loop stops on wall clock, so `simS` in the header tells you
  whether the sample you are reading is real.
- `teamSoak` measures combat and (in ctf) flag states; it is not a route
  or capper metric - for those use `capStat.ts` / `approachProbe.ts`.

## The full matrix (added later same day)

`_tools/sweeps/teamSoakMatrix.ts` runs every unordered primary pair
(pool = union of WILDCARD_SLOTS near/mid/far, 16 weapons), one Bun
process per matchup pooled across cores (`--jobs`), appending each
report to `_tools/sweeps/out/*.txt`. 136 pairs ≈ 12 min sequential,
≈ 2 min at 16 jobs. Resume-safe: pairs already logged are skipped.

**Trap 5, found by the matrix: the score column is structurally
near-tied.** TDM pays a kill point to the shooter AND drops a `tag` on
the corpse that pays a point to *whoever touches it* — own side or
enemy, "deny" still pays the denier (`roomScore.ts:131-135`,
`Room.ts:603`). Ring-seated respawns land bots on their own dead, so
each side banks kills + own-tags ≈ `K + D` ≈ total carnage either way.
Concrete worst case: Sticky-vs-Bombard scored **272-324** while kills
ran **33-268** (K/D 0.12). On this bench the verdict is the K/D +
medLife table; the score only measures how much dying happened.

**Trap 6: the seat leans bravo for arcing heavies.** Mirrors at ring-70
aren't all 50/50 — Mortar/RL/MRV/Sticky mirrors read bravo +20-45%
(spawn-side geometry favours the arc), while hitscan mirrors are clean.
`--mix` removes the question entirely: each side fields half of each
weapon, the verdict table reports per-weapon K/D across both teams, and
a mirror is symmetric by construction (skipped in the matrix).

**`--seat map`**: hands respawns to the real `spawnPicker` (foe
clearance over the flat `spawns` pool) instead of scripted ring seats —
team pools/bases are stripped first in non-ctf since authored team
spheres sit at bases ~400m apart and reintroduce transit starvation.

Mixed-matrix result (dunes, real spawnPicker, 120 pairs, seed 1337):
Chaingun 1.65 / Flak 1.59 / Bombard 1.50 > Shotgun 1.29 / BoltL 1.24 >
Disc 1.11 / Lightning 1.05 / PlasmaGun 1.03 > Sprinkler 0.87 / Mortar
0.87 / Railgun 0.83 / Cannon 0.80 > GrenL 0.75 / MRV 0.73 / RocketL
0.59 / Sticky 0.45. Versus the ring bench: Bombard is still top but
chaingun-class guns match it in the arena's close fight; RocketLauncher
collapses on the small map; Sticky is dead last on both benches. Data:
`_tools/sweeps/out/matrix_dunes_mix.json` (+ `matrix_kd.json` for the
ring run). One seed/map throughout — treat <±15% edges as noise.

## Doc rot found while writing this

`server_bun/tests/scenarios/_ffasoak.ts` justifies its arena with
"RoomArena shoves rim offenders back in". It does not — see
`RoomArena.ts`, whose own header says the pull-back shove was removed
(nothing enforces the dome server-side). Anyone trusting that comment
for contact pressure gets a starved match, as I did.

## Wave 2 — wild lobbies, range curves, cycle coverage, better telemetry

Four more modes and three ledger upgrades, same runner:

**`--wild`**: every bot rolls `rollWildcard` — the closest thing to a real
lobby. 10 seeds x 8v8 dunes (1,980 kills): BoltLauncher 23% / Mortar 17% /
Disc 17% own the meta; sidearms take 12.6% of all kills (the wounded-
holster gate working, not a bug); RocketLauncher 3 kills total; Lightning
0 (draw-starved — it rolls only on light kits). Kill counts here are
draw-rate-confounded — read shares, not totals.

**`--force`**: the dealt weapon fires at every range → per-weapon RANGE
CURVES. Headline corrections: Chaingun's 15m slot was a joke (best at
25-60, converts to 120+); Mortar is dead under 25m and apexes 60-120;
RocketLauncher's best band is 25-60, not "far"; Lightning hard-stops at
60m (LG_RANGE 55 + slack). Bands are now preferences (0.08 floor +
BOT_NEAR_M 15→25 + plateau near-fit), never hard bans — the user rule:
bots are allowed to be suboptimal like humans.

**`--cycle`**: a bot walks to the next weapon in the pool on every kill —
all 32 fireable types in ONE 10-min run. Settled previously un-benched
weapons: PlasmaCannon (weak, ~0.3 k/10s), all belt throws (they DO fire
as primaries — DiscPull legitimately works), SatchelCharge/HealGrenade
(duds as expected).

**Ledger upgrades:**
- `conn` — pull-level connects deduped on a per-pull nonce (pf-N minted
  in `RoomProjectiles.spawn` for unclaimed fans). Flak now reads ~46%
  not 162%. `hits` stays pellet-level for damage accounting.
- `up(s)` — shots × `WEAPON_FIRE_INTERVAL_S` = trigger-uptime; `dmg/10s`
  and `k/10s` price weapons per second of firing. Mortar's kill volume is
  longevity, not lethality (0.32-0.38 k/10s).
- Per-band hits/damage/kills — the `--force` curve data.

**Ordnance aim (the big finding):** RL was bottom-tier everywhere UNTIL
bots were taught to aim. `ordnanceAimY` picks max expected damage between
a direct shot and the ground point under the led position — reachable-disc
uncertainty (`reachR ~ t²`), splash via `aoeDamageAt`, direct-or-splash
pricing for grounded targets. Airborne targets score ~0 ground EV and get
the risky direct automatically. `ORDNANCE_EV=false` restores the ≤4m
heuristic. RL vs CG same-seed: K/D 0.36 chest-aim → 0.57 heuristic →
0.65 EV. The gun was half a bot-play problem, not just a stats problem.

**Remaining open items:** RL cadence 2.5→2.0 / speed 48→65 are the last
stat levers; the CTF stand-clearing bench (deployables + stationary
defenders) is still unbuilt — needed before declaring RL dead since
mobile-duel K/D can't measure its real job. Sprinkler/Sticky are the
true bottom guns across every bench.
