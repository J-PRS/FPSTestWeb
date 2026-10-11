# Bot AI — Enhancement Possibilities

Reference for the thin areas identified in the bot AI review, mapped to
established game-AI literature and to the hooks KRIBES already has.
Ranked roughly by (impact / effort).

---

## 1. Duel IQ — the most visible gap

Bots today: acquire → orbit in the engage band → fire with skill-matrix
aim → flat fear/flee gates. Missing: intent prediction, per-opponent
assessment, engagement control.

### Anticipation / goal recognition — Laird's Quakebot (2001)
"It Knows What You're Going To Do" (Laird & van Lent) added one
mechanism to a Quakebot: infer the opponent's *next* action from
context (hearing a pickup sound → he's heading for the next item →
pre-aim the doorway). Bots that anticipate read as dramatically smarter
without better aim.

**KRIBES fit:** we already have the senses — `ctx.sounds` (heard
events), `ctx.spots` (squad spot-reports), the thief beacon. A cheap
first cut: when a hunt target breaks LOS near a known pickup/flag
route, aim and pre-position at the *intercept*, not the last-seen pos —
the machinery exists (`escort` velocity-lead does exactly this for
friendlies; there's no equivalent for enemies). Effort: small — a
`predictHunt` slot in botHunt that extrapolates last-seen vel + nearest
attractor (pickup/stand/pack) instead of the stale point.

### Per-opponent assessment
UT-style bots and the Killzone line track a local threat estimate per
enemy; the fight-or-flight decision is per-matchup, not global. Ours
flees on a flat HP/fear gate regardless of who's shooting.

**KRIBES fit:** brains already keep `deaths[]` (spatial memory). Add a
tiny per-enemy record — times-hit vs times-died-by this id — so a bot
that's lost 3 straight to the same player avoids the rematch and one
that's beating someone presses harder. Feeds both the fear gate and the
hunt target pick. Effort: small (a Map in the hunt state, decayed).

### The combat dance — Halo Infinite bots (GDC 2022)
343 modeled the "combat dance" explicitly: strafe-bounce-grenade as a
modeled rhythm humans perform, not just an orbit radius. Our orbit is a
clean circle with jink params — mechanically varied but rhythmically
flat.

**KRIBES fit:** `botDisposition` orbit could gain beat structure —
fire-burst windows vs relocation windows (shoot 1-2 volleys, break
orbit direction, resume) instead of continuous drift. Humans pulse
movement; the current flip timer approximates it but isn't tied to the
fire cadence. Effort: small-medium, high read value.

---

## 2. Resource control — item timing & denial

Quake III's bot (van Waveren, the definitive write-up) treats items as
goal candidates weighted by need AND **respawn-state awareness** —
knowing a health pack respawns in N seconds is what makes arena bots
feel like they're cycling the map. Duel-level players deny the enemy
the pack; bots that do this look frighteningly aware.

**KRIBES fit:** `ctx.pickup` is a single nearest-in-reach sense — no
memory of where packs/gems spawn, no respawn prediction, no "route
through the armor on the way" planning. Feasible adds:
- **Pickup spots as a map feature** — pickups broadcast/appear at
  authored spawn points; a bot can learn the cycle table per match
  (shared, wire-legal: it saw them there).
- **Denial grab** — when a hunt target is heading for a pickup the bot
  can reach first, steal it (the llama deny already does the flag-flavored
  version of this in `offenseGoal` — same shape).
- **Post-fight top-up** — a bot that just won a duel routes past the
  nearest pack before resuming. Currently only the <15% rally handles
  "hurt" and it seeks allies, not health.

Effort: medium (a small per-match spot table + one more offer
candidate). High flavor payoff.

---

## 3. Route planning / cross-death learning

Q3's bot builds a cognitive map (areas + items discovered); the Expert
Bot (UT2K4) persists item locations in an auxiliary database. We have
the spatial *danger* half (influence map + per-bot `deaths[]`) but no
route-level memory: a capper that died on the east lane picks the same
lane next life because the cost field doesn't remember "this lane is
camped for me".

**KRIBES fit:** the brain's `deaths[]` are already position-stamped.
Extend: record the *approach vector* of the last death (which lane the
bot was running when it died), then let `quietApproach`/the route probe
penalize that corridor for N minutes. That's route variety — humans
call it "not feeding the same lane twice". Effort: small-medium.

---

## 4. Position evaluation — Crysis TPS / Killzone

The AAA standard (Tactical Position Selection, CryEngine; Killzone's
position evaluation functions): generate candidate points, score by
cover/exposure-to-threats/role fit, argmax. Our steering field already
is a slot evaluator — same technique, evaluated per-direction rather
than per-point.

**KRIBES fit:** what's missing isn't the mechanism but a *criteria* —
exposure to known threats. `ctx.spots`/threat positions could add a
negative weight in the steering fan so holds/retreats pick the
low-exposure slot instead of the geometric one. Medium effort; pays off
most in stand defense (HoFs currently body-block positionally but don't
seek hull cover).

---

## 5. Believability — what NOT to build

Worth stating, since the temptation is real:

- **Imitation learning (MLMove, Buffing Bots talks)** — transformer
  movement models trained on match traces are now legitimately
  CPU-feasible (~0.5ms/step) and produce the most human-like movement
  ever measured. Still a non-starter here: requires a recording
  pipeline, training infra, and breaks our deterministic shared-sim
  constraint. Bookmark as "someday research", not a roadmap item.
- **Repeating mistakes reads as bot.** BotPrize judges flag bots that
  make the *same* error twice — our `nearDeath` avoidance already
  handles the spatial case; keep this principle when adding behaviors
  (a scripted-looking flourish that repeats identically is worse than
  none).
- **Superhuman consistency reads as bot too.** The skill matrix's
  per-axis spread is the right answer; don't tighten it for "better
  bots" — tighten the *decisions* instead.

---

## Priority shortlist

| Item | Addresses | Effort | Why first |
|---|---|---|---|
| ~~Enemy intercept prediction~~ **shipped**: lost-LOS ghost snaps onto a sensed pickup near its extrapolated line (botHunt.ghostPos) | anticipation | S | biggest "wow it read me" per line |
| ~~Per-opponent W/L record → fear/press~~ **shipped**: `foeScore` tallies hits+deaths per attacker; dread ≥2 filters a nemesis from acquisition unless brawl-range/hero (botHunt.dreadOf) | duel IQ | S | cheap, compounds with nerve |
| ~~Fire-burst/relocation beat in orbit~~ **shipped**: `beatT` alternates settled burst (orbit 0.3×) and relocate swing (1.8×) in botDisposition | combat dance | S-M | most visible mechanical tell |
| Pickup spot memory + denial + top-up | resource control | M | classic arena-bot depth |
| Lane memory → route penalty | route planning | M | fixes "feeds the same lane" |
| Threat-exposure criterion in steering | positioning | M | defensive solidity |

All of these ride existing senses and utility plumbing — none need a
new architecture, a coordinator, or wire changes. The honest next step
for each is the usual loop: instrument a soak, find where bots lose the
duel/route/resource, then land the smallest candidate that moves the
number.

## Sources

- Laird & van Lent, *"It Knows What You're Going To Do: Adding
  Anticipation to a Quakebot"* — goal recognition → ambush.
- van Waveren, *"The Quake III Arena Bot"* — cognitive map, item goal
  weights, respawn awareness.
- Game AI Pro: *Hierarchical AI for Multiplayer Bots in Killzone 3*,
  *Tactical Position Selection*, *Modular Tactical Influence Maps* —
  layered commander (our TeamCommand is the same shape), position
  evaluation, influence modules.
- GDC: *Deconstructing the Combat Dance* (Halo Infinite bots),
  *Buffing Bots with Imitation Learning*.
- GameDeveloper: *Intelligent Mistakes* — humans anthropomorphize;
  visible reasoning beats visible accuracy.
- Durst et al., *MLMove* (Stanford/arxiv) — transformer movement
  imitation; state of the art for human-likeness, wrong toolchain for us.
