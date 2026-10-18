# CTF Bot Brain vs the Tribes PUG Guide — audit + plan

Reference: `2026-10-18_TRIBES_QUICK_PUG_GUIDE.md` (dodgesdomain Quick
PUG Guide). Audit of `shared/flagGoals.ts`, `BrainCtx`,
`botDisposition`/`botGoals`, `ServerBots`/`serverParties`/`serverSenses`.

## Design stance

The guide describes *serious* 7v4/7v3 PUG play — assigned roles, called
timings, VoIP discipline. Our bots live in a **fun chaos public game**:
unpredictable, occasionally dumb, but fundamentally sound. So the bar
is NOT "always fill every role" or "execute timed pushes on the clock."
The bar is:

1. **Legibility** — a player should be able to tell what a bot is
   *trying* to do (that's a capper, that's a HoF, that one's just a
   gremlin).
2. **Fundamental soundness** — somebody chases the thief, somebody
   presses the stand, nobody fights a pointless duel while the flag
   runs home. Chaos in the *how*, never in the *what*.
3. **Personality over completeness** — an empty role slot or a bot
   freelancing is a feature; a bot ignoring the flag state is a bug.

Current state already satisfies most of this: `assignRole` gives a
deterministic squad shape without a coordinator, minSquad unlocks mean
small games fill capping/chasing before anyone specializes (roles as
luxury, not mandate), and `duty`/`social` personality scalars already
make individual bots hold roles loosely rather than rigidly.

## Where the brain already matches the guide

- **Roster shape** — `ROLE_PRIORITY` capper → ldefense → hof →
  specialists, tail fills offense/defense.
- **The push** — capper stages outside the defended ring (`stageT`,
  `loiterT`), squad marshals ~110m out, `pushLive` releases the flood
  together. This is the guide's "hit the stand at capper-15s-out"
  coordination, emergent rather than scripted.
- **Offense priorities** — thief → push → escort → stand press, and the
  llama-deny E-grab (probability-scaled by cap risk vs reach).
- **HoF discipline** — planted, body-blocks the incoming run line,
  only leaves for a flag dropped in easy reach.
- **Stand-off resolution** — mutual-carry lock folds non-anchor roles
  onto the enemy carrier.
- **Communication texture** — `spots` reports, VGS radio pins,
  `sayHelp` carrier escort calls.

## The gaps, ranked by pub-value

### G1. No sniper role — the capper-killer (HIGH)

Guide defense is HoF + LD/MD + *sniper* whose only job is spot/kill the
capper. We have no `sniper` role at all — laser users exist as kits but
nobody owns the anti-cap lane. In a pub this is the role players feel
most viscerally: a railgun actually covering the flag is the difference
between "the bots defend" and "flags are free real estate."

**Plan**: add `'sniper'` to `BotRole` + `ROLE_PRIORITY` (want 1,
minSquad 5, after hof — a luxury like the guide implies, not a core
slot). `CLASS_FITNESS`: light 3 (snipers are light). `sniperGoal`:
posted perch overlooking the home stand at ~80–150m toward the enemy
approach (thief first if visible/beacon, then stand overwatch).
Server-only concern: it needs a far weapon — role-gate on the loadout
carrying a sniper-class gun, fall back to ldefense shape if the kit
can't shoot far.

### G2. Figiting is legal — offense duels while flags sit home (HIGH)

Guide: both flags home → enemy offense is ignorable; spot, don't duel.
Today `scanVisible` picks nearest-enemy regardless — an offense bot
mid-route will happily turn and figit a passerby. That's the one place
bots currently look *dumb* rather than chaotic.

**Plan**: in flag-room senses, when both flags are home and the bot is
a route role (capper/offense/infiltrator), discount non-stand enemy
players in acquisition — spot them instead (the `spots` channel already
exists). Keep the fight reflex: enemies actually near the bot
(brawl range) or near the objective still engage. This preserves chaos
(the gremlin still starts fights near the flag) while killing the
classic "offense bot gets distracted mid-field" failure.

### G3. E-grab is solo, never called (MEDIUM)

The llama deny exists but as a private probability roll — nobody calls
for it, so it never reads as a squad play.

**Plan**: cheap version — when a defender sees the enemy carrier inside
~150m of our stand, raise a team "deny" signal (reuse the `push`/`sense`
callout path or a new `denyTarget`): nearby offense/loose bots flip
their objective to the enemy flag for the window. Skip voice line
polish until the mechanic lands.

### G4. The sweatlord — competitive tech as a rare trait, not the mode (MEDIUM)

The guide's remaining tech (announced cap times, K-out resets,
dedicated chasing, tight push discipline) shouldn't be deleted — it
should be *rare*. A real pub occasionally fields the comp tryhard, and
that's the charm: "oh this bot is actually playing seriously" is a
delightful read precisely because most aren't.

**Plan**: add a `sweat` personality scalar to the brain's existing
spawn-hash trait draw (alongside `duty`/`social`/`wanderlust`), rolled
at ~10-15% so a 7-bot team gets a sweatlord maybe half the time. The
scalar gates:

- **Announced timing** — a sweaty capper VGS-calls its ETA before the
  push releases; sweaty members pre-commit to the marshal instead of
  converging on their own patience.
- **K-out/reset** — after a failed push, a sweaty route-role suicides
  to re-sync with the next capper window instead of drifting.
- **Dedicated chase** — a sweaty defender leads the thief's route
  (intercepts where the carrier *will* be, not where it is) rather
  than following the wake.
- **Figiting discipline** — a sweaty bot applies the G2 filter even
  when it's a defender (nobody sweatlord-duels mid-field).

Non-sweaty bots keep everything as now — the trait only ADDS
discipline, so the pub texture stays chaotic by default.

### G5. No dedicated chaser / callout layer (LOW)

Largely covered by the thief beacon + fold-onto-carrier lock, and the
sweat trait above adds route-leading chase for the bots that should
have it. Beyond that stays out unless soak data shows carriers
surviving too often.

## Non-goals (explicitly NOT doing)

- Enforcing the full role table — small games keep the minSquad ladder;
  empty slots are flavor.
- Clock-synchronized stand hits for everyone — marshal/push convergence
  already produces the shape; the sweat trait sharpens *individuals*,
  not the squad.
- Removing the misfit/personality layer — `misfitClass` (7% wrong-body
  rolls) and loose `duty` adherence are exactly the pub-chaos we want.

## Implementation status (all landed)

1. **G2 no-figit acquisition discount** — `ctx.flagsHome` fed by both
   hosts; route-role bots price mid-field passerby 3× farther, brawl
   reflex and objective-shadow enemies exempt. `scanVisible` + senses.
2. **G4 sweat trait** — `sweat` scalar off the spawn hash (~12%):
   posted defenders get figit discipline too, a sweaty runner emits
   `capcall` on the push-live edge ("going in 10"), and a sweaty
   chaser leads the thief's velocity instead of following the wake
   (`FlagSituation.sweat`, populated by both hosts).
3. **G1 sniper role** — `BotRole 'sniper'` in the ladder (minSquad 6,
   strict light, Railgun graft in the roster): thief → dropped →
   escort → side-mirrored overwatch perch ~75m down the approach lane.
   Posted leash 140m on both hosts.
4. **G3 called E-grab** — `FlagSituation.deny`: thief inside 150m of
   home + enemy flag home → offense/infiltrator fold to the grab; the
   solo llama-deny roll stays as the uncalled fallback.

Each lands independently; all shared-brain changes ride both server
and offline paths automatically (same `flagGoals`/`botBrain` code).

Still open: K-out/reset (bots have no suicide path — needs respawn
plumbing, not worth it yet), soak-level validation that the deny ring
and sweat lead measurably change cap outcomes.

## Test shape

- G2: scenario test — offense bot with a non-stand enemy at 60m and
  flags home keeps routing; the same enemy next to our stand still
  gets engaged.
- G1: roster test — squad ≥5 assigns a sniper when a kit qualifies;
  goal places the perch on the approach side of home.
- G3: deny signal raised when carrier <150m of stand; a near offender
  flips objective to the enemy flag.
- Existing cap/soak harnesses (`_csoak`, scenario suites) re-run after
  each — cap rate and grab-to-cap time are the regression dials.
