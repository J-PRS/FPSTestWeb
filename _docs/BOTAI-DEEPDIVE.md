# Bot AI — Deep Dive: "How is that a bot?" tricks

Second research pass, focused on *believability that blows players' minds*
rather than raw competence. BOTAI-ENHANCEMENT.md covers combat/duel depth;
this doc is about the moment a player goes "wait, bots don't do that."

All findings mapped to our stack: shared deterministic brains
(shared/botBrain + botHunt + botDisposition + botGoals), legal senses only,
spawn-hash personality, utility-argmax goal pick.

---

## 1. Attention budget — the single biggest cheat we still have

**Finding.** Human perception is focal. A human mid-duel does NOT see the
guy entering from 120° off-axis. Crytek's Target Tracks and every AAA
perception system (Unreal AIPerception, Lumina, Argus) model senses as
separate budgets: sight cone + hearing events + damage sense, each with
its own range and a *dominant sense*. Humans fighting have tunnel vision;
humans idle have wide ambient awareness.

**Where we stand.** `scanVisible` sweeps a full sphere at think rate and
acquires the nearest contact — perfect 360° awareness every ~300ms. That's
the single most un-human thing our bots do: you can NEVER sneak up on a
bot that's already fighting your teammate 30m away.

**Cheap version.** A single awareness scalar:
- If `hunt` is live and within ~60m → acquisition cone collapses to
  ~100–120° centered on the hunt's bearing, plus a short hemisphere
  radius (~25m) for "someone is in my face."
- No hunt → full sphere awareness (the wanderer's idle scan).
- Heard events (`ctx.heard`) bypass the cone entirely — footsteps are
  omnidirectional in humans too.
- Feeding: rotate `ctx.enemies` filter in `pickHunt` by the same bearing
  math the dread filter already uses. No new senses needed — this is a
  *constraint* on existing ones, which also makes it fully legal.

**Why it blows minds.** A player literally side-strafes behind a dueling
bot and the bot doesn't snap around — because a human wouldn't. First
time someone gets away with it they will tell friends.

---

## 2. Human aim is a submovement sequence, not a lock-on

**Finding.** A century of motor-control research (Woodworth 1899 → Meyer
1988 → Meyer/Elliott multiple-process model) and the 2023 CHI FPS-aim
studies all say the same thing: aimed movement is a **ballistic primary
submovement** that lands near-but-not-on the target (undershoot is more
common than overshoot), followed by **1–3 corrective submovements** over
the next 100–250ms. Pros just need fewer corrections — same shape.
Continuous smooth tracking only exists in perfect-pursuit scenarios; the
crosshair "flick + settle" is THE human aim signature on killcam.

**Where we stand.** Our aim is instant aim point + gaussian scatter per
shot. Skill changes the scatter magnitude but the aim point teleports
onto the lead position the frame the reaction delay expires. On a
spectator screen our bots don't *aim*, they *acquire*.

**Cheap version.** Split aim into a two-phase state in pickFire:
- `aimPhase: 'primary' | 'correct' | 'settled'` per target id.
- Primary submovement lands at `lead + Fitts-noise`: error ∝ angular
  distance to the previous aim point, biased to undershoot (~60/40
  under/over per the type-1/2/3 literature).
- Correction loop: over the next 80–200ms the aim point eases toward the
  true intercept in 1–2 micro-flicks (each one is just a lerp step with
  noise — no new physics).
- `settled` → current per-shot jitter as today.
- Skill = fewer corrections + tighter primary noise; personality could
  push a twitchy "snap-heavy" style vs a smooth "track-heavy" one.

**Why it blows minds.** Killcam + spec cams will show a human-shaped
aim: flick, tick-tick settle, shot. This is the #1 thing aim-bot
detectors and players BOTH key on — "snapped" = bot, "settled in" =
person. We have spectator mode; people *will* watch.

---

## 3. MirrorBot's dirty secret: mimicry beats intelligence

**Finding.** BotPrize 2012 winner (first bot ever to crack the
"human-likeness barrier," 52% vs judges) did almost nothing clever
tactically. Its trick: when it met a *non-threatening* player it just
**played back what it saw** — copied jumps, crouches, weapon swaps,
movement cadence. Judges rated mimicry as more human than most actual
humans. The insight: our perception of "alive" is social, not
performance-based. Same lesson in UT^2 (replay of human traces).

**Where we stand.** KRIBES bots have warmup/idle time, taunts, and now
a `social` trait — all the hooks for this.

**Cheap version — "matching" during downtime.** When a social bot is
idle within ~15m of a *friendly* player who is jumping/jetting/vgs'ing,
mirror the gesture class on a short lag (300–600ms): player hops, bot
hops; player types VGS-hello, bot answers. Not a scripting system — just
a "match the last thing the nearby ally did" impulse weighted by
`social` and gated on `!hunt`. In pre-match / warm corridors this reads
as "someone is chilling with me," which is the most human thing a bot
can do. Keep it rare (a loner NEVER mirrors; a social does it maybe
1-in-3 idle ticks) so it stays easter-egg, not parrot.

---

## 4. Signature quirks — a bot you can *recognize*

**Finding.** Judges caught bots on the absence of consistent quirks:
"didn't dodge," "kept jumping vertically," "limited range of reactions."
Conversely the strongest humanness signal in the literature isn't
intelligence — it's a *stable but imperfect* style. Personality
parameters (Gamedeveloper "Personality Parameters" classic) argue each
opponent should require different responses — that's what makes them
feel like characters, not difficulty settings.

**Where we stand.** We already hash-seed wanderlust/duty/social +
per-weapon skill axes. We don't have *quirks* — stable idiosyncrasies a
player could name.

**Cheap version.** 2–3 more spawn-hash scalars, each one flipping ONE
visible habit:
- `panicHop`: when first hit, this bot hops sideways instead of juking
  (some bots always bunny-hop on damage, humans do too).
- `wideOrbit` / `tightOrbit`: preferred duel band — a chaingun bot that
  sits at 55m vs a disc rusher closing to 8m read as *different people*.
- `aimBias`: a small persistent under/over-lead sign per bot (already
  have `leadSkew` — extend it to also pick a left/right strafe bias in
  the orbit so a bot has a "favorite side").

Each one is a 1–3 line usage of a trait we already roll. Zero cost at
runtime, but now the 8th bot in a TDM lobby isn't bot #8 — it's *"the
one that always ducks left."*

---

## 5. Fight-range grammar — the Halo "dance" decomposed further

**Finding.** 343's combat-dance work goes beyond "strafe + shoot": the
bots select a *verb* — close-with-melee, bounce-a-grenade, back-off-
while-shield-recharges — and each verb implies its own movement + fire
sub-pattern. The magic isn't the individual moves, it's that a bot
*commits* to a verb for a beat like a human commits to a read. Our new
beatT rhythm gives us the timing skeleton; what's missing is the verbs.

**Where we stand.** Duel behavior is basically "orbit + shoot + melee
if point-blank." No deliberate weapon-for-range switching mid-duel, no
"back off while reloading/at low energy" mini-state, no finisher verb.

**Cheap version.** A small `duelVerb` latch on HuntState with 3 verbs:
- `press` — target weak or we have melee advantage → close distance
  during `relocate` beats instead of orbiting.
- `hold` — healthy and even → current orbit behavior.
- `kite` — our energy low / reload-ish gap → *increase* orbit radius and
  bias aim to lead, like a human backing off while keeping fire up.

Pick per `beatT` phase transition, weighted by health/energy/weapon
matchup. No new architecture — it's a third case on top of
orbitMul/beatMove. The win: duels gain *narrative shape* — you can feel
a bot go from stalking to pressing when it smells a kill.

---

## 6. Environmental memory — "he knows this map"

**Finding.** UT2K4 expert-bot work and every arena-bot classic agree:
humans' spatial advantage is *memory*, not senses — they know where the
armor respawns, which corridor is camped, where they last saw the flag
run away. Bots with item-location databases and per-lane failure counts
consistently rate more human-like than smarter-sensored bots.

**Where we stand.** We have nearest-pickup *sensing*, pickup spot memory
is in the shortlist, lane memory is in the shortlist. This is a vote to
*combine* them into one "map mind": a per-brain bounded dict —
`mapMind: { spots: Vec[] (pickups seen), lanes: Map<laneKey, deaths>,
lastCarrierVec: Vec+timestamp }`. Three small structures, one concept.

**Cheap version.** On first sight of a pickup, stamp it. When health/
ammo drops below a threshold, the utility picker offers "go to a known
spot" before falling back to wander — a human "heading to the armor."
Lanes: reuse the existing death-memory position → nearest lane node,
increment; the wander/steering field subtracts score ∝ deaths on a
nearby lane. Carrier-sight memory already half exists via `lastSeen` —
persist it per-enemy longer for flag contexts so a bot that saw the
thief 8s ago still drifts that way even out of hearing.

---

## 7. Micro-social behaviors (the "wtf he's vibing" layer)

**Finding.** BotPrize post-mortems + Halo Infinite's own telemetry:
the strongest single humanness multiplier was *reacting socially* —
acknowledging a teammate's presence, answering a taunt, celebrating a
win. Judges who got mirrored or greeted almost always voted "human."

**Where we stand.** We have `say` chatter, VGS codes, killfeed — all
the output surface. Missing: *responsive* behavior to someone else's
says/emotes and any form of "I notice you exist" while idle.

**Cheap version.**
- VGS reply: if a teammate says a greeting/help/thanks within earshot,
  this bot has a `social`-weighted chance to answer with the matching
  VGS. No chat system work — just another `say` trigger on the existing
  event bus.
- Corpse respect: after killing your *nemesis* (already tracked via
  foeScore), a `social`/`aggro` bot gets one shot at a 0.5s crouch-bob
  or a targeted VGS over the kill. This is the single most "I cannot
  believe that was a bot" moment available in an FPS — people clip it.
- Idle stance: a bot that hasn't seen anyone for 20s and is posted
  does a slow scan yaw sweep (head-gaze only) — sells "watching the
  ridge" on spectator cam even though the decision layer is unchanged.

---

## 8. What NOT to do (update to the warning section)

The research this pass is unambiguous: **raw performance is anti-
correlated with believability.** MirrorBot beat the top-performing
strategic bots on humanness while being *worse* at winning. Halo's
ODST-tier bots were tuned *down* after the tech preview because
accuracy + instant reaction read as bot even while winning. Our skill
axes + form system already do this; keep nerfing speed of acquisition
before adding capability.

Concretely for KRIBES that means: do NOT widen senses, do NOT shorten
reactTicks below ~150ms equivalent, do NOT let aim settle to zero error
on the final correction phase, do NOT add simultaneous multi-target
awareness (we already split seenEnemies into a board — keep ONE hunt
target only).

---

## Priority shortlist (post-deep-dive, for the NEXT batch)

| Item | Addresses | Effort | Wow-per-line |
|---|---|---|---|
| Attention cone + hearing bypass when engaged | senses | S | huge — enables stealth play vs bots |
| Two-phase aim (primary + corrective submovements) | aim | S-M | huge — killcam/spectator signature |
| Idle mimicry of a non-hostile nearby ally | social | S | very high, cheap, uses existing senses |
| Per-bot quirks (panicHop, favorite side, duel band) | personality | S | high — bots become individuals |
| Duel verbs (press/hold/kite) on the new beatT | combat | S-M | high — duels gain narrative |
| Map mind (pickup memory + lane deaths + carrier trace) | strategy | M | medium-high — "he knows the map" |
| Responsive VGS/chatter + nemesis corpse beat | social | S | high — clips itself |

Everything here rides the existing spawn-hash personality + utility
argmax + legal senses. Nothing requires a new sim, a wire change, or
unseeded randomness.

## Sources

- 2K BotPrize 2012 writeups (MirrorBot paper, Polceanu; New Scientist
  feature on mimicry; UT^2 neuroevolution).
- Halo Infinite — GDC 2022 "Thinking Like Players" slides +
  Deconstructing the Combat Dance + Inside Infinite Aug-2021 postmortem.
- Jaderberg et al. 2019, Science — DeepMind FTW Quake III CTF.
- Woodworth/Meyer aiming models; CHI 2023 spatiotemporal aim model;
  PNAS Nexus kinematic study of FPS skill.
- Crytek Target Tracks (Game AI Pro ch.31); Unreal AIPerception docs;
  Gamedeveloper "Personality Parameters"; AIIDE "Stronger AI
  Personalities."
