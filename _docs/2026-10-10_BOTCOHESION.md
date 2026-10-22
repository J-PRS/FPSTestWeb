# Bot Cohesion — situational team grouping

How bots decide when to be near teammates. The design goal is a *hint*
of cohesion, never a formed unit: real Tribes TDM is mostly lone wolves
with organic pairs and trios that form around fights and dissolve again.

## Two layers, by mode

**Flag modes (ctf, flagrun)** — real squad machinery, unchanged by the
nerve system:

- `shared/flagGoals.ts` role table (capper/hof/offense/medic/…) +
  deterministic `assignRole` — each bot computes the same team layout
  locally, zero coordinator messages.
- `server_bun/src/botCommand.ts` `TeamCommand` — names bounded
  responders (chase 2, return 1, escort 2, push 4+) for contested jobs
  so the whole team doesn't lemming one stimulus.
- Push-call + wave marshal (`botRouting.ts`, `botDisposition.ts`) — the
  capper posts a push ~75s out; wave members hold a ~110m standoff until
  an ally lands near the ring or a wingman is within 45m.
- Escort slots lead carrier velocity; mutual-carry folds the whole
  non-anchor team onto the enemy carrier.

**Non-flag team modes (tdm, nuggets)** — the nerve system below. FFA
modes (dm, rabbit, duel) have no allies and nothing fires.

## The nerve system

Three inputs, one product:

| Input | Source | Range |
|---|---|---|
| `social` | Spawn hash `h04` in `BotBrain` — a rolled personality trait like `wanderlust`/`duty` | 0 loner → 1 pack animal |
| `confidence` | `BrainCtx.confidence` — host-computed: team score margin / `winAt` × 0.35 + `tanh((kills−deaths)/4)` × 0.25 around 0.5 | 0 getting stomped → 1 crushing |
| `healthFrac` | existing ctx field | 0–1 |

`nerve = social × (1.1 − confidence)` — read in `shared/botGoals.ts`.

Two effects, both inside `BotGoals.pick()`:

1. **Rally threshold breathes** — `rallyAt = 0.15 × (0.4 + nerve × 1.6)`,
   i.e. the fold-to-nearest-ally trigger moves from ~6% HP (confident
   loner) to ~32% HP (rattled social). Was a flat 15%.
2. **Ally-drift candidate** — the nearest teammate between 60m and 260m
   enters the utility argmax at `nerve × 0.55`, competing with wander
   (0.35), heard-fight (~0.2–0.9), pickup (0.8). Usually loses; wins
   exactly when a rattled social bot should go find a buddy.

## The anti-herd gates

What keeps it a hint and not a squad system:

- **Company cutoff** — an ally already within 60m cancels the candidate
  outright. The pull can only *form* a pair, never stack one.
- **No objective gate** — `ctx.objective` set ⇒ no drift. Flag modes'
  commander/roles own cohesion there.
- **Reach cap** — allies past 260m don't exist for this sense; no
  cross-map pilgrimages.
- **Distance falloff** — `offer()`'s `1/(1+d/140)` reach term still
  applies, so a far buddy scores lower than a near one.
- **FFA dead channel** — `ctx.allies` is empty outside team modes; dm /
  rabbit / duel can't fire by construction.

Emergent result: most bots solo, a rattled or sociable one shadows a
teammate for a stretch, the pair dissolves when the anchor's own goals
move it on. Clumps of 2–3 arise around fights (heardGoal already pulled
toward gunfire) — this just makes the *approach* slightly social.

## Host wiring

- Server: `ServerBotSenses.confidenceOf` (`serverSenses.ts`) reads
  `room.scores` + `p.kills`/`p.deaths`; filled on every `build()`.
- Offline: `TeamBots.confidenceOf` (`client/src/game/bots.ts`) reads
  `this.scores` + `deps.world.killCounts`/`deathCounts` — same formula,
  so solo and hosted bots herd identically.
- Omitted `confidence` ⇒ 0.5 neutral (hosts with no scoreboard behave
  as before).

## Tests

`server_bun/tests/botGoals.test.ts` — "ally drift" block pins: rattled
social drifts, confident ignores, loner never drifts, company cutoff
blocks herding, objective suppresses it, and the nerve-scaled rally
threshold on both ends of the social dial.
