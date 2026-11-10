# Always-On, Evolving Bots — research + plan

**Status:** investigated + designed, not implemented (2026-11-09).
**Amended same day:** live persistence is probably the wrong vehicle —
the scenario harness already runs full matches synchronously at sim
speed (`mkRoom` + `step()`, seeded, deterministic; respawn/cooldowns/
TTLs all track `simNow` — verified `respawnTick(simNow())` fires inside
`step`). ~50-160× realtime → hundreds of matches in minutes. Evolution
belongs in an offline batch harness emitting a tuned table; the live
box only *loads* results. See §3b.
**Ask:** the OCI box is free — can bots play 24/7 (never hibernate), with
variation, and slowly *evolve* based on hit-accuracy and energy
conservation?

**Verdict:** yes, and we're unusually well-positioned. Half the idea
already exists in-match; the missing pieces are orthodox patterns the
field already standardized on, not research.

---

## 1. What the research says

Surveyed patterns for persistent bot worlds and adaptive opponents
(2026-11-09 web search; sources cited per claim).

### Always-on worlds: the answer is *tiered*, never binary

| Pattern | Source | Fit for us |
|---|---|---|
| **Relevancy-tiered AI** — only a fraction of bots run full AI with no player nearby; rest idle cheap (`BotActiveAlone=10` on WoW-bot realms) | Ether Labs devlog (etherlabs.app/blog/89-percent-idle) | **The pattern to copy.** Zero-audience rooms tick at reduced rate; wake to full rate on join. |
| **Park + fast-forward** — inactive actors freeze, catch up via math on wake | dev.porschiey.io "world that never sleeps" | Wrong fit — a frozen mid-match FPS can't fast-forward into a believable live fight for a joiner. |
| **Freeze/thaw whole server** — SIGSTOP everything when empty | github.com/andymarden/azeroth-sleep | The *opposite* direction — but proves the fear: their idle sim burned 37% of 2 cores. Our hibernation exists for exactly this reason. |
| **Idle gates** — skip heavy dispatch when a world has no work | voxelize PR #98 | Same tiering idea at the ECS level; our equivalent is the room-level tick skip. |
| **bot_quota fill / keep-free-slots** — bots hold seats, yield to humans | CS2 `bot_quota_mode`, Omni-Bot, TF2 | Already done: `botFill` floor + roster rebalancing. Parity with industry. |

Nobody sims unwatched rooms at full rate. "Always a live match" means
**one standing room alive at reduced rate**, not every room at 60Hz.

### Bot evolution: research does RL; production does stats→smooth→mutate

- Academic work (PDDA arxiv:2408.06818, PSO-net fighters, RL NPC surveys)
  trains opponents from player profiles. Every *deployed* example
  degenerates to the same trick: log stats → exponential-smooth into a
  profile → mutate parameters. One indie example logs accuracy/evasion/
  positioning per session, smooths 70/30 into a persisted profile, and
  spawns enemies scaled from it.
- Real-time neural training on a live free-tier box is not a thing
  anyone ships. **Fitness-proportional mutation of existing dials is
  the practical ceiling** — which is exactly what our `baseAxes`,
  `baseMove`, `mods`, `form` already are.

**Conclusion:** the user's "evolve based on HA% + energy conservation"
is the standard profile-and-mutate loop. No ML needed; the dials to
mutate already exist.

---

## 2. What already exists (inventory)

### Variation — already strong, needs nothing

`shared/botSkill.ts` rolls each bot a personality matrix at spawn:
4 aim axes (`snap`/`track`/`arcLead`/`arcJudge`) × moving/still splits,
`movement` competence, `courage`, `beltPull`, `form` random-walk
(±15%, `driftForm`). Wildcard kits ~12.5% (`botRoster.ts:75`), perk
rolls, Q-skill draws. Tiers via `BOT_TIERS` + per-axis `BotSkillMix`.

### In-match evolution — already exists, three mechanisms

- `adaptOnRespawn` (`botRoster.ts:110`, called at `ServerBots.ts:733`)
  drifts the loadout toward weapons the bot's skill matrix hits with.
- `heroTick`/`resolve` (`botSkill.ts:164`) escalates losing bots toward
  `impossible`, performance-seeded + menace pressure, with results-based
  overdrive (uncapped until the menace takes a real wound).
- `driftForm` — continuous warm/cool.

All per-life: `BotBrain` + skill matrix die with the room. Nothing
persists across matches or process restarts.

### Always-on — explicitly designed *against*

`TickLoop.ts:212-223`: `audience = humans>0 || spectators>0`; no
audience → `ballSim.dormant`, `creatureSim.dormant`, **whole room tick
skipped**. Comment is deliberate: "Bots alone don't count as an
audience… a bot-only 'default' would otherwise sim forever."

Standing rooms (`spec.standing`, mapCatalog `standingRooms()`) already
seed `duel-1`/`headhunt-1` with bots at boot and never dispose — they
just freeze when unwatched.

### Metrics substrate — partial

- `RoomMoveSim` tracks per-bot energy live: `sh.energy`, `jetDrain`,
  `jetRegen`, `jetLockT`; `econOf(id)` (`RoomMoveSim.ts:902`) already
  exposes the whole energy economy per bot. Energy conservation is
  measurable *today* with a counter, zero sim changes.
- Hit accuracy: **not tracked per-bot.** `hitLedger.ts` is a soak
  autopsy (self-frag probes), not an accuracy ledger. Shots fired is
  knowable at fire time (`serverAttacks`); hits are attributable via
  projectile owner in the damage funnel. Needs a small new counter,
  ~tens of lines.
- `asw` columns in Alt+Q are client-side activity shares — not a
  server stat source.

### Constraints to respect

- `botSkill.ts` header: skill rolls run on a **private PRNG seeded from
  spawn point**, never `botRand` — deterministic harnesses pin duel
  outcomes. Any evolution mutation must also stay off `botRand` and off
  the seeded stream (use a separate ledger-driven PRNG or wall-time,
  and gate it for scenario tests).
- `server_bun/AGENTS.md`: sims deterministic, no `Date.now()` in sim
  decisions. Ledger bookkeeping is bookkeeping, not sim — wall-clock
  save intervals are legal (respawn timers precedent).
- Server owns outcomes — the ledger lives server-side by definition.

---

## 3. Design

Three independent pieces, ship in order.

### Piece 1 — Always-on tiered tick (the "bots never sleep" ask)

Flip the audience rule so **standing bot rooms** keep ticking when
unwatched, at reduced rate.

- `TickLoop.ts:216`: `audience = humans>0 || spectators>0`.
  New: rooms with `standing && bots.count > 0` tick at a low rate
  (suggest 10Hz — 1/6 cost) instead of skipping; audience>0 restores
  full rate instantly. Non-standing empty rooms still dispose;
  non-standing bot rooms keep current hibernation (a minted `arena-3`
  nobody watches is still waste).
- At reduced rate, skip what's pure broadcast: no wire encode target
  exists anyway (broadcasts already no-op with zero sockets). The tick
  cost is brains + moveSim + projectiles — the parts that *are* the
  "living match" for the joiner.
- Sub-beat alternative (lighter): keep 60Hz tick loop but only run
  `tickRoom` every 6th pass when `!audience`. Simpler than a second
  timer, sim sees `dt=0.1` steps — verify bots handle coarse dt
  (brains think on `thinkPhase` divisions; reaction timers are
  wall-ish. Check `thinkDiv` interplay before choosing).
- **Falsifier:** `profload`/metrics on a bot-only standing room at the
  reduced rate must stay under a few % of one core; if brains don't
  tolerate `dt=0.1` (overshoot, tunneling), go to "fraction of bots
  think per tick" (Ether-style) instead of slower dt.

### Piece 2 — Persisted bot ledger (identity + stats)

New file `server_bun/src/botLedger.ts` + JSON store (e.g.
`_data/botLedger.json`, gitignored, written on interval + shutdown).

- **Identity:** `BOT-<name>-<idx>` already stable per room population
  order — but names cycle (`BOT_NAMES[idx % len]`). For evolution to
  mean anything, ledger keys on **callsign** (`VEKTOR`), not the full
  id (index suffix is roster position). `populate` already seeds
  skill from spawn point; keep that (determinism) but let the ledger
  *override* rolled values for known callsigns — same callsign, same
  bot, slightly different bot each era.
- **Stats per callsign** (rolling, e.g. EMA α≈0.05):
  - `shots`/`hits` per weapon → **HA%** (the user's axis)
  - jet energy burned per kill / per km skied → **energy economy**
    (from `econOf` deltas + existing energy drain events)
  - K/D, damage dealt/taken — cheap context for mutation direction
- **Wiring points:** shots at fire time (`serverAttacks`), hits at the
  damage funnel where projectile owner is known (CombatHandler path),
  energy via periodic `econOf` sampling in `ServerBots.tick` (cheap —
  once a second per bot, not per tick).
- No wire changes, no protocol surface. Pure bookkeeping.

### Piece 3 — Evolution (mutate the dials)

On bot spawn (or slow interval), callsigns with ledger history get a
**mutated spec** instead of a fresh roll:

- `baseAxes[axis]` drifts toward weapons/axes where observed HA%
  exceeds expectation — a bot that keeps landing arcs gets *better*
  at arcs (positive feedback) AND its `adaptOnRespawn` already drifts
  the kit that way; the ledger makes the drift survive room resets.
- `baseMove` (movement) drifts up for high energy-economy bots —
  efficient skiers become better skiers.
- `form` baseline nudged by recent K/D.
- Mutation is **small and clamped** — e.g. ±0.02 per era, same
  `clamp(0.45–1.5)` bounds as rolls, applied to `base*` fields so
  `heroTick`'s lerp machinery is untouched.
- Guard: ledger mutation runs only when `!process.env.FPS_SOAK`
  style deterministic contexts — or better, behind
  `spec.evolve !== false` so scenario tests pin it off (harnesses
  pin duel outcomes; a mutating ledger in a test would flake it).
- Persist cadence: dirty-flag write every ~60s + on graceful
  shutdown. Tiny file (50 callsigns × ~10 numbers).

### Piece 2b — Offline evolution harness (the better vehicle — added after review)

**Why:** the ask is *evolved bots*, not *a ledger*. A dedicated
headless run compresses the needed generations into minutes:

- `tests/scenarios/harness.ts` already does everything needed:
  `mkRoom(spec)` → `step(room, ticks, dt)` drives the full Room
  (brains, move shadows, projectiles, combat funnel, fanout) in a
  tight synchronous loop. Seeded `botRng` per room → reproducible.
  Respawns/cooldowns/TTLs ride `simNow` (`harness.ts:64`,
  `respawnTick(simNow())`), so complete matches run at sim speed —
  no wall-clock hole.
- Throughput: ~50ms of sim per sub-millisecond tick → ~50-160×
  realtime. A 10-min match ≈ 4-12s wall. Generations are the unit
  that matters, not hours; hundreds of generations in minutes.
- Loop shape: era N bots play a match (or fixed T sim-minutes) →
  collect HA%/energy/K-D per callsign → mutate `baseAxes`/`baseMove`
  within clamp bounds → era N+1 rolls from the mutated spec → repeat.
  Output: `botEvolved.json` (callsign → skill spec).
- Live consumption: `botRoster.populate` overrides the spawn roll with
  the table entry for known callsigns — a ~15-line seam, no ledger,
  no EMA, no save cadence, no runaway risk between saves (mutation is
  bounded per-era *in the harness* and the shipped file is static).
- Determinism: harness runs are already seeded; mutation uses its own
  PRNG. The shipped table is data, so production `populate` stays
  deterministic given the same file.

**What the live ledger still buys** (if ever wanted): evolution that
responds to *real human* opponents, not bot-vs-bot. That's a P3+
question; bot-intrinsic axes (HA%, energy economy) don't need it.

### Explicitly out of scope

- RL/NN anything — the mutate-the-dials loop *is* the production
  version of that research.
- Cross-room/fleet shared ledger — single box, single file.
- Bots in non-standing minted rooms staying awake (waste, and the
  matchmaker recycles them anyway).

---

## 4. Piece-by-piece file map

| Change | File(s) | Size |
|---|---|---|
| Reduced-rate zero-audience tick for standing bot rooms | `server_bun/src/TickLoop.ts` (~L212-223) | ~20 lines |
| dt-coarseness check vs think phases | `server_bun/src/ServerBots.ts` thinkPhase path | audit only |
| Ledger module (load/save/EMA) | new `server_bun/src/botLedger.ts` | ~150 lines |
| Per-name stat taps: shots, hits, energy | `serverAttacks.ts`, `CombatHandler.ts` funnel, `ServerBots.ts` tick | ~60 lines spread |
| Seed override at populate | `botRoster.ts:107` (after `new BotBrain`) | ~15 lines |
| Mutation spec → `rollSkill` inputs | `shared/botSkill.ts` or a server-side wrapper (keep shared pure — wrapper on server) | ~40 lines |
| Test gate | spec field or env, harness pins | ~10 lines |

Total ≈ 300 lines new + ~50 touched. No protocol, no client, no
deps. `_data/` is new — add to `.gitignore` + rootcheck index.

---

## 5. Risks / falsifiers

- **CPU**: reduced-rate standing room still sims forever. Measure with
  `bun _tools/profload.ts` on a bot-only room; if a single standing
  room at 10Hz reads >2-3% of a core, lower further or drop to
  Ether-style partial thinking. OCI free tier is shared — headroom
  matters at peak.
- **Determinism**: ledger writes must never feed `botRand` or the
  skill PRNG; keep a dedicated RNG in botLedger (mulberry32 on
  callsign hash + era counter).
- **Evolution runaway**: positive feedback could mono-culture the
  roster (every bot becomes an arc phenom). Clamp bounds +
  per-era cap + maybe slight decay toward the base roll keeps the
  spread. Watch for it in the ledger file itself — it's inspectable.
- **Zero-audience match quality**: at 10Hz a joining human sees a
  slightly chunky mid-match world for a frame or two before full
  rate resumes. Acceptable; the alternative is a dead lobby.
- **Bot-only CTF/headhunt forever**: match clocks already end games;
  `checkMatchClock` runs pre-hibernation — verify the reduced path
  still reaches it so standing rooms cycle matches, not run one
  stale match forever.

## 6. Phases (revised)

1. **P1 tiered tick** — unchanged; it's about joiner experience, not
   evolution. Smallest, standalone.
2. **P2 offline evolve harness** — `_tools/evolve.ts`: seeded
   `mkRoom` + `step` loop, per-era fitness collection (HA% per weapon
   per callsign, energy-per-kill via `econOf`), mutation, emits
   `botEvolved.json`. ~200-300 lines, all in `_tools/` — zero
   production surface.
3. **P3 table load seam** — `populate` reads `botEvolved.json` for
   known callsigns (~15 lines + fallback to roll). Deterministic,
   testable: harness pins the file, same file → same bots.
4. ~~Live ledger~~ — deferred unless human-vs-bot adaptation becomes
   the goal.

## 7. First empirical run (2026-11-09) — `_tools/sweeps/evoSkill.ts`

Built and ran the P2-style harness the same day. Mechanism: per-bot
`botShot` room event (new — bots emitted no fire events, so per-bot
HA% was unmeasurable), `hit`/`kill` events, `econOf` sampled 1/sim-sec
for energy fill + dry-out transitions. Genome = continuous
`{aim,move,react,jitter,temper}` floats applied to `base*` and live
skill fields (heroTick lerps from base — both must be written).

Three runs: mixed-kit flat (8 gens), `--pure Disc` flat (8 gens),
mixed-kit rimrock real terrain (8 gens). Data: `out/evoSkill.jsonl`.

**What increases HA% (high-air share, NOT hit accuracy — metric was
misread on the first pass and rewired):** baseline bots already run
~50-55% airborne + ~45% ski on rimrock dm — air=life is already true;
almost no walking or standing. No genome convergence in 8 gens: at
this granularity airtime is saturated and the skill dials can't push
it. The lever for *sustained* air is jet economy (featherjets =
0.7 drain × 1.5 regen — why cappers pin it), not skill. Pure `ha`
(>5m) is ~20-25%; >50% needs traverse-heavy objectives (cap runs),
not a dm.

**Hit-accuracy digression (the misread metric):** `jitter ↓` +
`temper ↑` converged cleanly on rimrock (HA% 14-24% → 31-37%).
Full impossible-tier injection scored only 17% — dial ceiling ~35%;
50% hit-rate needs shot discipline (fire gating), not tuning.

**What preserves energy:** the energy→agency chain shows in data
(best air row also had the best eFill, 31%): fuller tank = more jet
options = more airtime. But `move` dial never differentiated —
conservation is emergent (lethality shortens engagements + perk
economy), not a trainable dial in a dm.

**Method caveats:** ~2-3 bots/genome → high variance; dm mode mixes
roles; sim pos rides ~1.5m above surface (eye offset) so altitude
buckets must gate on `onGround` or standing bots count as airborne.
Instrumentation added is permanent: `botShot` in `roomEvents.ts` +
3 emits in `botArsenal.ts`; `_tools/sweeps/evoSkill.ts` with
`--pure/--map/--inject` flags.
