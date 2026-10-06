# Tribes gameplay & movement — reference for bot AI design

Sources: Tribes Depot wiki (Skiing, Beginner's Guide, Capper role pages),
community guides, and our own soak autopsies. For the *simulation* model
(friction, knockback curves, step-up) see `tribes-physics/` — this doc is
about how humans actually play, and what that implies for bot rules.

## The one axiom

**Velocity is survival.** A moving target is the entire game's defensive
model: nothing else (armor, cover, aim) matters as much as "hard to hit."
Every behavior below — skiing, hop-chaining, disc-jumping, wide routes —
exists to buy or preserve velocity. A bot that stops moving is a dead bot;
the sheep meter is calibrated around exactly this.

Corollary: **energy is a momentum budget**, not a shield budget. Jets are
how you pay for uphill, hops, and escapes. Spending the tank on a drain
skill while a climb needs it is how bots get pinned — the mount/starve
loops we fixed were all "tank spent on the wrong thing."

## Movement vocabulary (what players actually do)

1. **Skiing** — hold the ski key; friction drops to near-zero on slopes.
   Discovered by accident in T1 beta (jump-spam on hillsides looked like
   cheating), canonized by T2 as a real mechanic with training missions.

2. **The ski cycle on a slope** — start high, let gravity accelerate on a
   down-slope, land on a slope that converts vertical momentum to
   horizontal, and at the down→up inflection either ski through (buying
   height) or jump to carry speed over the crest. Speed compounds across
   linked slopes: each valley is a pump.

3. **Hop-chaining on flats** — holding ski while grounded and tapping jump
   keeps the run airborne and frictionless. This is flatland travel, not a
   trick — humans hop continuously across aprons. (Our `speed > hopSpeed`
   momentum hop models this; it was runner-only until the 2026-10-06
   generalization.)

4. **Jet discipline** — the tank refills only when not burning. The
   high-skill pattern is jetting the *descending arc* of each hop
   ("tail-tap": every thrust tick lands as forward speed, ~10x the
   speed-per-energy of a held flat burn). Novices flat-burn and land dry.

5. **Disc-jump / self-knockback** — fire a splash weapon at your own feet
   mid-run for a big velocity burst at the cost of health. The canonical
   grab mechanic: a capper disc-jumps *onto* the stand, touches at 200+,
   and is three hills away before defenders track the grab. Also used to
   escape. Not yet modeled by our bots — the known gap.

6. **Skiing uphill** — bad on steep grades: frictionless boots slide back
   down. Humans release ski and hop-walk-jet steep climbs. (Our
   `skiVetoRise` + `skiVetoSpeed` clause models this.)

## Positional play

**Routes are arcs, not beelines.** A capper's route reads the terrain for
a chain of slopes that build speed into the stand — often a wide,
backside-looking arc that arrives *faster* than the direct line. The
route is committed: midfield contacts are answered with the gun while the
feet keep the line (our "the route owns the feet" rule).

**Staging.** When the wave isn't there, the capper doesn't trickle in
alone — he holds off the defended ring until the push converges, then goes
in *with* it. Real teams call this "cap in 10": the whole flood lands on a
clock, not on individual patience. (Modeled as a fading standoff repel,
not a scripted orbit.)

**Dueling orbit.** Mid-range fights orbit the target inside the drawn
weapon's lethal band while strafing — never standing still. Range band is
weapon-dependent: a Flak brawler hugs ~10m, a disc duel sits ~25-40m, a
rail holds far. (Our `preferredRange` + scored fight-pos ring.)

**Holding ground is also movement.** A posted defender isn't a statue —
he sweeps a small patrol arc, because standing still on the most-shelled
ground on the map is how you eat every inbound disc. "Hold" = small
orbit inside the leash, not zero velocity.

**Terrain as information.** Good players choose the side-valley that
banks energy or the saddle that crests at altitude over the direct line.
Nothing is scripted — the field reads the slope set and the cheapest
line wins (our `BotLines` ray fan, `eScore` energy accounting).

## Decision rules, generalized

What the research + soaks converge on:

- **Commitment with invalidation, not repolling.** A chosen route/spot/
  line holds until a reason kills it (target dead, leash exceeded,
  objectively better by a real margin). Marginal re-scores are noise —
  acting on them reads as dithering.
- **Danger is additive.** LOS threats, leash limits, standoff holds,
  death memory, and slope traps all contribute to one field. Modes
  ("defender", "runner", "fleeing") aren't switches — they're which
  term dominates right now.
- **Energy flows downhill into speed.** Every movement decision can be
  priced in mechanical energy (½v² + g·h): climbs spend it, drops bank
  it, jets buy it, splash converts health into it. The strongest single
  rule in the codebase is "prefer the line that ends with more E."
- **Proximity matters more than range.** Brawl evidence is a 45m cone
  check — a foe you can see but can't reach is a marching order, not a
  duel.

## Capper craft (role-guide canon)

From the T2 Capper guide + T:A capper video guides — the vocabulary pro
cappers actually think in:

- **Route = memorized tuples of (hill, landing angle, jet amount).**
  Improvisation exists but the fast line is always a rehearsed chain of
  slopes. For a no-navmesh bot the equivalent is the meso waypoint fan +
  crest/landing reads we already run — the "route" is what the field
  picks every think, not a stored path.
- **Entrance vs exit routes.** Pro routes pick an approach that sets up
  the *escape*: back-to-front arrives faster home because the exit leg
  points at your own base. Our flow field optimizes each leg separately;
  a true entrance→exit coupling is a deeper planner change, parked.
- **Continuous > setup.** Sitting on a remote perch waiting for a reset
  flag costs the team a body; running the route through the kill is
  usually faster net. Our cappers never stage already.
- **Bowls.** A large concave hill face converts direction at speed —
  ski into the bowl off-axis, exit aimed elsewhere at full velocity.
  This is the human answer to "how do I turn without braking": let the
  terrain do it. Bot equivalent would be scoring landing spots by how
  much of the required heading change the local curvature absorbs —
  our landW tangency term captures the speed half, not the turn half.
- **"Jet earlier rather than later."** A burn taken before the arc
  starts dying buys altitude *and* preserved speed; the same tank spent
  at impact is a splat. Our `arcClearsCrest` fires exactly at this
  decision point.
- **Propel + jets in tandem.** The nitron/disc impulse is worth ~30%
  more horizontal speed when jets ride the same window — humans tap
  thrust as the blast lands. (`propelJetUntil` = 900ms already does it;
  also: impulse aimed at a *downslope behind you* buys horizontal, not
  vertical, velocity — our heel-blast geometry matches.)
- **Start the route on a full tank.** Cappers bank energy before the
  entrance leg. Our runner `bank` window + `mountE` purchase floors are
  the same rule at different scales.
- **Llama grab vs e-grab.** Grabbing slow is worthless (flag off stand,
  carrier dead 5m out) EXCEPT as an emergency flag-reset when the enemy
  is about to cap. Our bots already refuse slow grabs via runIn/strike
  speed gates; a true e-grab policy (grab-at-any-speed when enemy flag
  is home and threatened) is a small `pickDest` term — parked.

## What this means for KRIBES bots

- Never script an orbit radius or a waypoint — express the constraint as
  a field term (danger/interest) and let the steerer's slot scorer find
  the geometry.
- Never ask "should the bot move" — ask "which direction wins the field
  right now." Standing still is only valid when the field itself is flat
  (posted + no threat + nothing pulling).
- Meter sheep on *velocity and position change over time*, not intent —
  the current bleed/cover channels already do this; they caught real
  defects (Sisyphus climbs, edge grinds) no rule-author would have named.

## Conway-shaped game AI — the literature

Our "simple rules, complex behaviors" philosophy is a known and
battle-tested approach in game AI under three names:

- **Context steering** (Andrew Fray, GameAIPro2 ch.18) — directions
  scored by interest/danger maps, best slot wins, small and stateless.
  Shipped on F1 2011 where it *replaced* a behavior-component system,
  shrank the codebase ~4000 lines, and improved overtaking and collision
  avoidance. This is exactly our `BotSteer`.
- **Utility AI / IAUS** (Dave Mark, Infinite Axis Utility System) —
  every behavior scored continuously on current-appropriateness,
  argmax wins, no hand-ordered behavior trees. The commercialized form
  of what `BotGoals` does.
- **Tactical influence maps** (Paul Tozour, GameAIPro2 ch.30) — shared
  spatial fields (threat, opportunity, death history) computed once and
  read by every agent: defender positioning, evade spots, target
  clustering all emerge. Our `imap` layer is a textbook implementation.

Robert Christensen's context-map flocking work also shows the field
weights are auto-tunable by genetic algorithm — evidence that "tune the
field, don't patch the cases" is a working path, not just an aesthetic.

Reading list: GameAIPro2 chapters 18 (Fray) and 30 (Tozour) —
gameaipro.com PDFs are public; IAUS manual at gameai.com/manuals.

## Anti-patterns observed (and fixed)

- "Walk to the wall, then jet up" — hop+jet face-climbing instead of
  routing to the walkable approach. Fixed via goal-line mount probes +
  ramp-seeking detours scored by route slope.
- Orbit-at-range on a flag stand while the touch sphere is above the
  bot — the deck lip blocked the slot, the mount never armed, the bot
  rim-orbited forever. Fixed by the bounded-lip slot rule (bounded faces
  aren't walls).
- Scripted 110m stage orbit — replaced by the standoff field; the ring
  is now emergent.
- Flat-transit walking for non-runners — hop-chain was gated to
  runner/wave; now universal.
