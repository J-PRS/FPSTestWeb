# Bot Brain Codex — the living map of our AI

One place for what the bots do, why, and the philosophy. Update this
when the brain changes — it's the "where are we at" doc, not a report.

## Philosophy — the rules everything obeys

1. **Bots are legal humans.** Every bot input is the same buttons a
   human presses: move keys, ski, jet, jump, fire direction. No
   wallhacks, no instant reactions, no guaranteed hits. Any "impossible
   tier" behavior must be reachable by dials a roll could draw.
2. **Senses are wire-legal.** A bot sees through LOS (eye line, range
   caps), hears through `noisesNear`, remembers through `lastSeen`/
   ghosts, and gets squad spots/radio the same way a teammate would.
   If it can't know it, it doesn't act on it — menace injection is the
   only exception and it rides the *hearing* sense, earshot-gated.
3. **Deterministic & shared.** `shared/bot*.ts` runs identically on
   server (authoritative) and offline client brains. Seeds roll
   personality; the same seed replays the same bot. `botRand` streams
   keep soaks reproducible.
4. **Errors, not cheats, make them human.** Aim is an error budget
   (lead distance, flight, jitter) divided by skill — never aimbot.
   Behavior is utility-argmax with per-bot weights (duty, social,
   greed, wanderlust, courage, temper, sweat).
5. **Escalate via dials, not new powers.** Hero mode only ever moves
   legal dials. If a behavior needs a new lever (track convergence,
   predator earshot), build it as a legal human skill first, THEN let
   resolve sharpen it.

## Architecture — where things live

```
shared/
  botBrain.ts    the think loop + BrainCtx + senses/aim/move wiring
  botSkill.ts    skill roll (tiers easy..impossible), baseAxes/mods,
                 resolve + heroTick + HERO_ON
  botHunt.ts     target pick (scanVisible/pickHunt), fire (pickFire),
                 reaction clock, dread/unreach, track convergence
  botGoals.ts    goal scoring (wander/heard/social/greed/duty offers)
  botMoves.ts    ski/jet/jump intents (hints) — "how to get there"
  botDisposition.ts  personality-driven step/goal dispositions
  botTuning.ts   all tuning constants (BOT_TUNING)
  botLoadouts/botClasses  kits + class rolls
server_bun/
  serverSenses.ts  BrainCtx feed on the wire: enemies, threats, sounds,
                   heroOf (deficit/menace/menaceHp), confidence
  ServerBots.ts    brain registry, skillOf() telemetry
  botArsenal/botRouting  weapons + squad routing
client/
  game/bots/index.ts    offline TeamBots: fillSenses/fillNerve/heroOf/
                        menaceScan — mirrors serverSenses
  game/bots/botBrain.ts GameBot: the local host wrapper (slew, fire,
                        sounds->heard)
```

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
