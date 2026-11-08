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

**Shared brain** (`shared/` — runs identically both sides):

```
botBrain.ts    the think loop + BrainCtx + the wiring of every sense
botSkill.ts    skill roll (tiers), baseAxes/mods, resolve + heroTick, HERO_ON
botHunt.ts     scanVisible/pickHunt (target pick), pickFire (aim+trigger),
               reaction clock, dread/unreach, finisher, track convergence
botGoals.ts    goal argmax — wander/heard/social/greed/duty/escort offers
botMoves.ts    ski/jet/jump intents — "how to get there" (hints out)
botDisposition.ts  personality-driven step/goal dispositions
botSteer.ts    the step-destination steerer (memory trail, deflection)
botSlew.ts     aim slew model — human turn rates, not instant snaps
botEscape.ts   escape-kit arming (stuck→thrust out of the pocket)
botGraph.ts    waypoint/nav graph the routed legs walk
botLines.ts    line-of-travel reads (dive/glide windows, hop rings)
botLos.ts      LOS helpers the senses ride (sight answers memoized per room)
botSheep.ts    headhunt sheep-meter (hoard→buffs→panic) logic
botWeaponHooks.ts  per-weapon aim/fire hooks (range, lead, fuse picks)
botLoadouts.ts bot kits + wildcard rolls + perk rolls
botClasses.ts  light/medium/heavy class stats
botTuning.ts   BOT_TUNING — every knob lives here
botRand.ts     seeded rng streams (deterministic soaks)
botNames.ts    bot name tables
botVec.ts      BotVec + vector helpers
botTaunts.ts   chatter/taunt economy (parallel seeded stream)
```

**Server bots** (`server_bun/src/` — the authoritative host):

```
ServerBots.ts    brain registry per room, think cadence, skillOf() telemetry
serverSenses.ts  BrainCtx feed off the live room: enemies/threats/sounds,
                 heroOf/menaceScan, confidence, notices, convoy/spill
botArsenal.ts    bot fire pipeline → RoomProjectiles.spawn (real sims)
botRouting.ts    squad routing: hunt picks feed room objectives + radio
botRoster.ts     spawn/respawn roster + loadout/class assignment
botCommand.ts    GM/admin bot commands (roster control, skill grades)
botDrive/botGreedy/botMobility  locomotion drivers: the feet
botMpc*/botMpcSearch/botMpcWorker  MPC drive solver (deep nav on track)
botBeam.ts       beam-intent handling for bot rays
botSheep.ts      server-side sheep bookkeeping
superBot.ts      the "super" admin/test bot variant
```

**Client offline bots** (`client/src/game/bots/` — the local host):

```
index.ts       TeamBots: spawn roster, fillSenses/fillNerve/heroOf/
               menaceScan — mirrors serverSenses semantics
botBrain.ts    GameBot: the local brain host (slew drive, fire intent,
               sounds→heard channel, sheep/kill bookkeeping)
botSenses.ts   offline BrainCtx builder (noises, incoming, contacts)
botFire.ts     local fire pipeline → client projectiles
botWatchdog.ts mobility watchdog (stuck/pin detection → recovery)
botCtf.ts botRabbit.ts botMatch.ts botKill.ts botSheep.ts
               mode/match-specific wrappers + sheep/kill bookkeeping
botEnergy.ts   bot tank/energy accounting
botBolts.ts    bot bolt/projectile helpers
```

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
