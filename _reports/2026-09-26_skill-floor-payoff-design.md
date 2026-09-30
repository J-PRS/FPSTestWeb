# North Star: Forgiving Floor, Costly Ceiling

*Design concept — 2026-09-26*

## The principle

Every strong tool in the game should answer two questions at once:

1. **Who is it forgiving to?** — the "noob handicap": a built-in limiter that
   keeps the weapon approachable and prevents it from dominating low-skill
   lobbies.
2. **What does it pay back for skill?** — the "pro payoff": a deeper mechanic
   that the same limiter feeds, rewarding mastery with something a flat-stat
   weapon can't do.

The key is that both sides must be *the same mechanic seen from two seats*.
Not a nerf plus a separate gimmick — one system whose cost IS its payoff.
When it works, nobody calls the limiter a handicap: casuals experience a
weapon that feels good immediately, pros experience a resource engine.

## The worked example: the Lightning Gun

The LG shipped as flat 8/tick — ~178 dps, dominant in every lobby. The
redesign (all committed this session):

- **Stepped ramp-down**: consecutive ticks on one target step 8 → 6 → 4,
  floor reached at tick 10 (~0.5s of hold). Misses inside a 0.3s window
  keep the count; target-switching resets. Sustained DPS ~90, burst DPS
  ~178. *Handicap*: spraying is weaker than it looks.
- **The bank**: each tick banks `8 − tickDamage` (what the ramp withheld)
  ×2 into a per-target charge, capped at 320. *Payoff*: the withheld
  damage isn't lost — it's stored on the victim as a bomb.
- **Telegraph**: the victim wears an electric shroud that swells and
  flickers with charge; the beam itself thickens ~2.6× and crackles
  harder. Everyone in the fight can read the bomb's size — charge is a
  public combat state, not a hidden meter.
- **Detonation economy**: any non-LG direct hit pops
  `min(banked, hitDamage)` — a pellet sparks 10 out, a rocket dumps 90.
  The remainder keeps smoldering (decays at 5× fill rate once the beam
  leaves). The LG's own kill pops the full bank.

Why it's both seats of one mechanic: a casual's beam still kills (small
pops feel great), while a pro converts a 2.7s sustained track into a 320
detonation — and can *feed* the bomb to a teammate's rocket. The limiter
purchased the payoff literally, in the same units.

## The pattern in other games

**Tribes: Ascend — Spinfusor (disc)**
Handicap: slow projectile + punishing self-knockback if you eat your own
blast. Payoff: that same blast is the movement system — disc-jumping is
*the* core skill of the franchise. The thing that makes it hard for
beginners is the thing that makes it legendary for veterans. Our disc
already does this.

**Quake — Lightning Gun**
The original truth our LG was modeled on: absurd point-blank DPS gated by
a beam that's hard to hold on strafing targets. Handicap = tracking
difficulty, payoff = the highest sustained DPS in the game. Our version
makes the *cost* explicit (decay) and banks it (charge) instead of leaving
it as pure aim-gate.

**Halo — Energy Sword lunge**
Handicap: useless at range — the noob who whiffs is exposed. Payoff: the
lunge *is* the skill — reading spacing, baiting the commit, punishing the
whiff. One stat (lunge range) creates both the floor and the ceiling.

**TF2 — Pyro airblast**
Handicap: pathetic direct damage. Payoff: the compression blast is a
utility toolbox (reflect projectiles, extinguish teammates, force-push
ubi jumps). Nobody calls reflect a handicap — the weak flamethrower is
what justifies it.

**Fighting games — comeback mechanics (X-Factor, Rage, V-Trigger)**
Handicap: you're losing (the literal handicap). Payoff: damage/utility
scaling proportional to deficit — codified rubber-banding that gives the
behind player a real out without taking anything from the ahead one.
Design lesson: the cost side can be *situational* (behind, whiffed,
sustained) rather than statistical.

**Destiny/Bungie — Charge of Light / super economy**
Handicap: you spend time/position building meter. Payoff: a payoff that
dwarfs any single weapon. The shroud+pop is this in miniature — the meter
is ON the enemy, which is the novel bit.

**Monster Hunter — Long Sword Spirit Gauge**
Handicap: the gauge decays if you stop attacking — sustained pressure is
the tax. Payoff: spirit blade finishers. Same shape as our decay-in /
decay-out charge: maintenance is the skill expression.

**Team Fortress 2 — ÜberCharge**
Handicap: the medic can't fight — the weapon itself is the handicap.
Payoff: the most powerful 8 seconds in the game. *And it telegraphs* —
the charge visual on the medic pair is readable counterplay, exactly the
reason our shroud exists.

## Design rules extracted

1. **One mechanic, two seats.** If you can't describe the payoff without
   naming the limiter, they're probably two features bolted together.
2. **Charge is a public state.** A bank the victim and observers can read
   is counterplay; a hidden meter is a feel-bad surprise. Telegraph
   everything that can kill someone.
3. **Decay on both sides.** Charge fades when the beam leaves (5× drain);
   the ramp resets on target switch. Stored power must be *maintained* —
   that's what makes the payoff earned rather than parked.
4. **Proportional detonation.** `min(banked, hitDamage)` means small hits
   can't arbitrage a big bomb — the economy stays honest.
5. **The handicap is allowed to be scary.** A 20-tick decay to 4 damage
   is a real cost — that's what buys a 320-damage payoff without breaking
   casual lobbies. Timid handicaps buy timid payoffs.

## Honest re-audit: how rare is it really in our roster?

First draft oversold the pattern. Looking at the actual mechanics:

- **Disc — the only genuine sibling.** Self-knockback risk (eat your own
  blast) is a real *cost*, and it's spent on the payoff — disc-jump
  mobility, the franchise-defining skill. Cost→payoff in the same
  mechanic. Fits.
- **Chaingun — half a fit.** A real ramp exists (`dmg += n`, up to +8 on
  sustained per-target hits), so there is a paid-for ceiling. But the
  "cost" is only time-at-target — nothing is stored, nothing telegraphs,
  the ramp can't be stolen or detonated. It's a delayed-stat payoff,
  shallower than the LG's resource economy.
- **Mortar — oversold.** The arc is an *aim gate*, not a stored cost —
  and the forgiving part (18m splash) is forgiveness *for the shooter*,
  which is the wrong seat entirely. It's a noob-friendly weapon with an
  execution ceiling, not a limiter→payoff coupling.
- **Railgun — oversold.** No charge time, no mechanic — a fast precise
  slug (450 m/s, tight 0.5 proxy cap). Precision is a skill *requirement*,
  not a limiter that buys anything.
- **Cannon — nothing at all.** A flat heavy comedy ball: no forgiveness
  axis, no depth axis. The weakest fit — the prime candidate for the
  next pass (e.g. per-target consecutive-hit damage ramp — LG-shaped,
  justified by the ball being slow and dodgeable).

So the honest claim: **the pattern is rare.** One full implementation
(LG), one genuine sibling (Disc), one half-fit (Chaingun), and three
weapons that are just difficulty-gated or flat. That scarcity is the
opportunity — the roster has room for two or three more couplings
without repeating the charge mechanic itself.

Important distinction sharpened by the audit: **a skill gate is not a
payoff.** "Hard to aim" makes a weapon skill-restricted; it doesn't give
anything back. The north star requires the limiter to be a *cost that
converts* — withheld damage, self-harm, spent position, stored time —
not merely difficulty.

## Open questions

- Should charge be visible on the HUD to the *victim* themselves (a
  "you're loaded — get clear" warning), or is world-readability enough?
  Currently only the shroud exists — no self-warning.
- Does charge bank across deaths/respawns? (Currently no — it lives on
  the target id.)
- PvP parity: shroud + detonation is client-side for creatures today.
  A remote-player version would need the server to relay charge state —
  worth it if the mechanic survives playtesting.
