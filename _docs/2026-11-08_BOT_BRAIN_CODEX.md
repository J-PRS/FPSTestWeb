# Bot Brain Codex — the living map of our AI

One place for what the bots do, why, and the philosophy. Update this
when the brain changes — it's the "where are we at" doc, not a report.

## Philosophy — how the AI thinks

**No hard rules — only probabilities.** Nothing is "never" and nothing
is "always." Every behavior lives at some chance: the coward still
heroics sometimes, the sweatlord still whiffs, the tourist occasionally
hears the fight over the mountain. A lobby of bots should feel like a
lobby of people — variance IS the product.

**Fun first.** Between "realistic" and "interesting," pick
interesting. Cool interactions, surprise plays, memorable moments —
a bot that does something worth telling someone about beats a bot
that's merely correct. When in doubt: what makes the better story?

**Legal humans.** Every input is the same buttons a human presses:
move keys, ski, jet, jump, fire direction. Skill is dials a roll could
draw; escalation moves dials, never grants powers. Legality is the
frame — inside it, probability writes everything.

**Wire-legal senses.** Sight through LOS, hearing through
`noisesNear`, memory through ghosts — the senses a human has. The one
stretch (menacePos into hearing) is still the *hearing* channel with a
radius — a fight you could plausibly have heard, not radar.

**Errors, not aimbot.** Aim is an error budget divided by skill;
behavior is utility-argmax with per-bot weights (duty, social, greed,
wanderlust, courage, temper, sweat). Personalities are distributions,
not scripts — that's why a squad doesn't read as clones.

**Deterministic & shared.** `shared/bot*.ts` runs identically on
server and offline brains; seeded streams keep soaks reproducible —
the *rolls* are reproducible, the outcomes are varied by design.

## Architecture — where things live

**Shared brain** (`shared/` — runs identically on server and client):

| File | What it does |
|---|---|
| `botBrain.ts` | The think loop. Defines `BrainCtx` (every sense: enemies, sounds, threats, allies, objective, hero, confidence, notice, convoy, spill, desperate, energy, flags, radio) and `BrainOut` (move/fire/aim intents). Per-think: heroTick → menace hearing → pickHunt/goal refresh → moves hints → fire. Owns personality fields (sweat, duty, social, greed, wanderlust, courage) and the sub-modules below. |
| `botSkill.ts` | The skill roll + hero model. `rollSkill` draws axes (snap/track/arcLead/arcJudge × moving/still), movement, spec tier, mods — plus `baseAxes`/`baseMove`/`baseMods` snapshots heroTick lerps from. `HERO_ON`, `resolve`, `prevMenaceHp`, `odHold`, `heroTick` (pressure→resolve→dial lerp→overdrive). |
| `botHunt.ts` | Combat brain. `scanVisible` (LOS acquire, nearest + beast), `pickHunt` (hunt/thief/spot/ghost pick + finisher bias + dread/blacklist filters), `pickFire` (reaction gate → cadence → error budget → track convergence → lead/loft). HuntState: reactTicks/jitter/temper baked at roll, acquiredAt, unreachUntil, foeScore, lastSeen ghosts. |
| `botGoals.ts` | Goal argmax — every candidate is a weighted offer: objective, wander, heard-noise, social (fold to ally), greed (pickup), escort, vulture. Distance falloff + duty-scented danger discount. heardGoal's investigate roll = curiosity + duty + resolve. |
| `botMoves.ts` | Ski/jet/jump intents — the buttons, not the destination: committed jet holds, glide taps, hop-descents, escape bursts, breath-perch climbing, orbit brakes, recon climbs, dive vetoes. `jetWhy` telemetry tags every burn. |
| `botDisposition.ts` | Personality→step destination: flinch knock, hunt press/retreat/orbit, quiet-map drift, posted anchoring. Disposition fields per family; the carrier→duelist conversion gate lives here. |
| `botSteer.ts` | Context steering — scores every direction (not just the goal line): interest = goal alignment + heading momentum; danger = hazards. Produces the ~8m step destinations feed. |
| `botSlew.ts` | Human-shaped aim turns — turn rates + settle, so the crosshair moves like a wrist, not a snap. Driven by both hosts identically. |
| `botEscape.ts` | Get-out senses: no-progress sidesteps escalating to a jet escape burst, shell-dodge lateral hop — rewrite the step destination after steering. |
| `botGraph.ts` | TerrainFlow — leg-scale routing: samples candidate runs 15–60m out; the ray-fan steerer is myopic, this layer sees saddles. |
| `botLines.ts` | Meso line picking — dive/glide windows, hop rings, overshoot reads between the steerer (9m) and the graph (600m). |
| `botLos.ts` | The LOS sense — heightfield march + structure solids, memoized per (bot,enemy) cell; extracted from botHunt. |
| `botSheep.ts` | SheepCore — headhunt's anti-pedestrian meter: hoard→buffs→panic, one impl for wire humans, offline bots, and the local readout. |
| `botWeaponHooks.ts` | Per-weapon senses the ctx reads — one factory both hosts build: preferredRange, lead, fuse clock, aim axis pick by range. |
| `botLoadouts.ts` | Kit tables + wildcard rolls + perk rolls — what guns/items a bot draws; `botClassForLoadout` derives class after the roll. |
| `botClasses.ts` | Armor classes (light/medium/heavy): HP vs speed vs mass — jet thrust and movement differ for real. |
| `botTuning.ts` | `BOT_TUNING` — every movement/route constant in one mutable table; sweep tooling perturbs genomes from it. |
| `botRand.ts` | The injectable rng source for every heuristic — seeded per room so decisions replay; never crosses the wire. |
| `botNames.ts` | Callsign pool shared by client ('bot:VEKTOR') and server ('BOT-VEKTOR') rosters — TTS-safe, no repeats. |
| `botVec.ts` | `BotVec` plain-record vector + helpers — shared sims can't touch THREE types. |
| `botTaunts.ts` | Kill/death chatter on the real 'chat' wire — cooldown + speak-chance; a flavor line, not spam. |

**Server bots** (`server_bun/src/` — the authoritative host):

| File | What it does |
|---|---|
| `ServerBots.ts` | The server-driven bot: a `PlayerState` with no socket — hit claims, knockback, deaths, respawn reuse the normal player pipeline. Owns the brain registry (`brains` map), the THINK_DIV cadence, `skillOf(id)` telemetry, and wires senses → brain → drive/fire each think. |
| `serverSenses.ts` | `ServerBotSenses` — the brain's sensorium: every channel a legal client could read — positions, pickups, inbound shells, noises, wall occlusion, plus the heroOf/menaceScan feed, confidence, notices, convoy/spill/desperate, repair jobs. |
| `botArsenal.ts` | The trigger half: weapon selection, muzzle geometry, ballistic lobs, disc-jump propels. Every bot shot goes through the same `RoomProjectiles.spawn` a client's would — no bot-only damage path. |
| `botBeam.ts` | Non-shell fire paths: creature shots and projectile-less beam weapons where the honest ray decides contact (earliest of terrain/wall/player). |
| `botRouting.ts` | Squad routing: hunt picks feed room objectives + radio spots + capSync — the "where the squad pushes" layer. |
| `botRoster.ts` | Squad bookkeeping: spawn roster, armor-class swaps, role rebalancing, the botFill population floor — tick loop owns "what does the room need." |
| `botCommand.ts` | Per-team commander: same FlagSituation every role reads; contested jobs (chase thief, return flag, escort carrier) assigned by score. |
| `botDrive.ts` | Brain→inputs contract: turns a brain destination into legal player inputs and steps the body — every motion through the real move sim, nothing teleports. |
| `botGreedy.ts` | Path-free local driver: ~4Hz rolls ~14 candidate inputs ~0.9s through the real MoveSim, commits argmax (progress + terminal speed). ~25× cheaper than MPC. |
| `botMobility.ts` | Stuck leash + mobility watchdog helpers — ~2m travel re-arms, carriers get a short leash. |
| `botMpc*.ts` | MPC committed-run solver: receding-horizon search over the real MoveSim producing an input schedule — the deep-nav option for cappers (search + worker split). |
| `botSheep.ts` | Wire-side sheep adapter — the meter lives in shared/botSheep.ts; this feeds wire humans' hoards. |
| `superBot.ts` | `FPS_SUPERBOT` debug knob: matching bot gets superpowers (faster drive, never-miss, extra HP) — dev/test only. |

**Client offline bots** (`client/src/game/bots/` — the local host):

| File | What it does |
|---|---|
| `index.ts` | `TeamBots` — the offline roster: spawn/spec/roster management, per-bot fillSenses (enemies/others/allies/engageRange), fillNerve (sounds/threats/repair/confidence/hero/notice + convoy/spill/desperate), heroOf/menaceScan mirrors of serverSenses, alliesOf/rally, spawnSpot, score tracking. The offline counterpart to ServerBots+serverSenses. |
| `botBrain.ts` | `GameBot` — the local brain host: per-bot state (position/vel/health/held/class/loadout), think() maps the shared BrainOut onto the local body (locomote via botMoves hints + slew face, fire intents, sounds→heard noises), sheep/kill bookkeeping, `get skill()` exposing brain.skill for telemetry. |
| `botSenses.ts` | Offline BrainCtx builder: recentNoises, incomingNear threats, enemy contacts with hpFrac — the same channels serverSenses feeds, read off `world.remotePlayers` + the local player. |
| `botFire.ts` | Local fire pipeline: muzzle geometry + weapon spawn into the client projectile sim — the offline counterpart to botArsenal. |
| `botWatchdog.ts` | Mobility watchdog: stuck/pin detection and the recovery kicks — the offline counterpart to botMobility's leash. |
| `botCtf.ts` | Flag-mode offline logic (CTF objective wiring for offline bots). |
| `botRabbit.ts` | Rabbit-mode offline logic (carrier hunt/roster rules for offline bots). |
| `botMatch.ts` | Match bookkeeping for the offline roster (rounds, mode glue). |
| `botKill.ts` | Offline kill/death bookkeeping — killCounts/deathCounts feeds + respawn for local bots. |
| `botSheep.ts` | Client-side sheep adapter — same shared/botSheep meter for the local bots + HUD read. |
| `botEnergy.ts` | Bot tank/energy accounting for the offline bodies. |
| `botBolts.ts` | Bot bolt/projectile helpers for the local sim. |

## Server bots vs offline bots — same brain, different host

The **shared/** modules are the whole personality: identical code,
identical seeds → identical decisions. What differs is the *host*:

| | Server bots (`ServerBots`) | Offline bots (`TeamBots`) |
|---|---|---|
| Authority | authoritative — their shots spawn real sims | local sim — feeds the same client-only predict |
| Senses | `serverSenses` reads the live Room (positions, threats via `RoomProjectiles.incomingNear`, noises via `noisesNear`) | `botSenses`/`index.ts` reads `world` (remotePlayers, killCounts) + local player |
| heroOf | room players + team scores | world killCounts + local player — **same scoreboard semantics, different data source** |
| Fire | `botArsenal` → `RoomProjectiles.spawn` → wire broadcast | `botFire` → client projectile sim |
| Movement | `RoomMoveSim` shadows (botDrive/greedy/MPC solvers) | local movement sim via `Player`-style sim |
| Sheep/score | `botSheep` server bookkeeping + killFeed | `botSheep` client bookkeeping |
| Telemetry | `skillOf(id)` on the room | `gameDump` rsv column reads `bot.skill` |
| Why separate | server authority + secrecy (proprietary routing/MPC never ships) | offline rooms need bots with no server — the shared brain is the guarantee of parity |

**The parity rule:** decision logic lives in `shared/`; host code only
translates the world's shape into `BrainCtx` and executes `BrainOut`.
If a behavior exists on one side, it exists in shared/ — heroOf's two
mirrors (`serverSenses`/`index.ts`) are the pattern, not the exception.

## The dials — every legal lever and who reads it

| Dial | Where | What it does |
|---|---|---|
| `axes.{snap,track,arcLead,arcJudge}` | aimSkill → pickFire err | aim error divisor per weapon family |
| `mods.aim/move/react/jitter/temper` | baked at roll → live fields | tier multipliers; **note: baked once — escalation must hit the read sites** |
| `reactTicks` | pickFire gate | acquisition→first-shot delay; hero: /(1+resolve) |
| `temper` | pickFire fireT | fire cadence; hero: ×(1+0.6r) |
| `jitter` | pickFire err | steady-hand scale; hero: /(1+0.8r) |
| `movement` | ctx.moveSkill | hop/jet competence |
| `sweat` | ctx.sweat | tryhard behaviors; hero: resolve blends in |
| `dread/foeScore` | pickHunt filter | a nemesis becomes invisible to acquisition |
| `finisher bias` | pickHunt | hpFrac<0.6 visible contacts outrank near ones; stickiness ±25% |
| `track convergence` | pickFire err | on-target ticks shrink err up to 3×, scaled by axis |
| `resolve` | BotSkill + heroTick | 0..4 escalation: lerps all dials + overdrive |
| `menacePos` | hero→sounds | earshot 50+250×r — predator investigation radius |
| `heardGoal` | botGoals | investigate roll 0.15+duty·0.5+r·0.4 → certain |
| `switching cost` | botGoals | incumbent goal bonus grows with distance-committed (up to 2x), drops under threat, expires stale (~20s) — committed lines, free minds |
| `attention cone` | scanVisible | committed hunt collapses acquisition to ±60° on target bearing, 25m reflex radius — flankable like a human |
| `dodge horizon` | botEscape.dodge | shell vel×closing shrinks effective distance — skill-scaled anticipation horizon |
| `form` | skill | per-bot random-walk form multiplier |
| `confidence` | ctx | team margin + own K/D nerve |
| `duty/social/greed/wanderlust/courage` | personality | argmax goal weights |

## Hero mode — escalation by results

`HERO_ON` in `shared/botSkill.ts`. Per think, `heroTick(pressure)`:

- **Pressure** = deficit (team score margin, or **team-kill gap** for
  unscored modes like headhunt, or FFA gap-to-leader) × ownPerf (K/D
  form — better seeds escalate first) + menace pull (dominant enemy
  K/D) + random walk (organic spikes).
- **Resolve 0→1**: every dial lerps toward impossible tier,
  proportionally (never below the roll).
- **Overdrive >1**: if the menace takes no real wound (≥15% off peak
  hp), resolve compounds ~12%/s (cap 4) — the lobby ramps until the
  problem is dealt with. A wound snaps to ≤1 + 5s hold.
- **Predator**: resolve>0.5 pushes menacePos into hearing (radius
  scales with resolve) — they hunt the problem, not lock onto it.
- **Feeds**: `heroOf`/`menaceScan` on serverSenses (server) and
  index.ts (offline) — same scoreboard semantics both sides.

## Testing & telemetry

- `server_bun/tests/hero.test.ts` — resolve math, nerf-free, overdrive
- `server_bun/tests/heroWire.test.ts` — read-site proof: same state,
  resolve flips the reaction gate + cadence
- `server_bun/tests/scenarios/_herosoak.ts` — real room sim: staged
  menace → enemy rsv>1 → menace dies (loop proven on Rimrock)
- **Shift+Alt+Q dump** — `rsv` column = live resolve per row
- `skillOf(id)` — brain telemetry read on the server

## Known gaps / next candidates

- Attention budget: scanVisible is still a 360° sweep (see
  `2026-10-11_BOTAI_DEEPDIVE.md` — the biggest remaining un-human
  cheat). Cone-collapse while engaged is unbuilt.
- Dodge anticipation: threats react, don't predict launch.
- Range-band discipline: bots fight at whatever range happens.
- Energy-gated engagement: no "don't duel on empty tank" dial.
- Pre-aim on approach: slew doesn't pre-stage toward lastSeen.
- Squad focus-fire share: radio carries spots, not target picks.
- **Activation skills (Q): BUILT (8ae39ab9-era).** `BrainCtx.skill`
  carries the equipped id (server roster + client TeamBots assign one
  per class at spawn: lights → blink/dash, heavies → slam/medkit,
  mediums → dash/bounce/warp/shield). `pickSkill` presses on
  human-shaped triggers (dash = gap-close/escape, slam = landing dive,
  blink/warp = infiltrate/flee, bounce = hop). `BrainOut.skill` rides
  the same seam as `belt`: `ServerBots.applySkill` drains the
  `ENERGY.skillCost` ante, enforces the 850ms floor, applies
  impulse/resync/applyBlast; the client `applySkill` in bots/index.ts
  mirrors it on `bot.velocity`/`bot.position` + the `hit()` funnel.
  Channel skills stay in `statusIntent`.
- **Soak methodology lessons (the hard-won part):**
  - `step()` now fires `respawnTick(simNow())` — respawns are wall-clock
    `setTimeout`, so without it every dead seat stayed dead for the whole
    sim. THAT was the "combat freeze": a lobby of corpses, not a lull.
  - Soak `t`/net values are step counts (dt=0.05s): sim-s = steps × 0.05,
    real speed = per-step net × 20. Labels now read sim-seconds.
  - `--pool=a,b,c` on `_beltab`/`_deployab`/`_skillab` gives each bot a
    different item and tallies kills PER ITEM — one room, whole ranking.
  - **Corpse-lobby tallies invert.** First sweeps (pre-respawn-fix) said
    blink/Implodisc/cgturret lead; on a living sim the real ranking is
    warp > dash > bounce > blink > slam (29k vs 9k), ImpactGrenade >
    Javelin > RemoteRailgun > Grenade > ClusterBomb > Implodisc (36k vs
    10k), mortar > jammer > loiter > station > mine > turret/cgturret >
    spider > drone (23k vs 3k). Denial + AoE earn on live lobbies;
    aim-tools only looked strong farming the dead.

## Hard-won lessons (why things are this way)

- **Mods bake at construction** — lerping `skill.mods` post-roll is a
  dead write; the hunt-state fields (`reactTicks`, `jitter`, `temper`)
  are consumed once. Escalation MUST touch the read sites. (This was
  the "hero mode doesn't work" bug.)
- **Results, not threat-model** — `menace` reads the scoreboard (K/D),
  never the body that earned it. A buffed but mediocre bot triggers
  nothing; the ramp only answers real dominance.
- **Earshot, not radar** — menacePos at any range was a wallhack;
  scaling with resolve keeps it "heard a fight" legal.
- **`bun --watch` misses `shared/`** — server reloads need the
  dev-watch debounce or `/dev/shutdown`.
