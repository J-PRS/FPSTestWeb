# North Star: Compress the Middle, Pay the Top

*Design concept — 2026-09-26*

## The principle, corrected

The goal is NOT "handicap the weapon, give pros a consolation prize."
The real shape of it:

**Absorb the middle of the skill spectrum.** Whether a player can hold a
beam on target for 0.1s or 0.3s (metaphorically), they should land in the
same damage curve — mediocre vs decent tracking shouldn't separate
players much, because that gap is where stomps are born. Then push the
entire skill expression into the tail: the player who can hold for a full
second+ gets something genuinely *awesome* — not more damage, but a
different order of capability.

Flatten the mid-skill separation. Make mastery spectacular.

That's the inversion that matters: in ordinary shooter balance, better
aim → more damage, linearly — the decent player beats the average one,
the good one stomps the decent one, and the noob feeds everyone. Our
north star instead *compresses* the ladder in the middle and *explodes*
the payoff at the top. Average players aren't punished for being
average; mastery is rewarded with spectacle instead of a bigger number.

## The worked example: the Lightning Gun

Shipped as flat 8/tick (~178 dps — dominant everywhere). The redesign:

- **Stepped ramp-down**: consecutive ticks on one target step 8 → 6 → 4,
  floor at tick 10 (~0.5s). Misses inside 0.3s keep the count; switching
  targets resets. Sustained ~90 dps, burst ~178. *The absorption*: a
  2-tick graze and a 7-tick track land on nearly the same stepped curve —
  the middle of the aim spectrum collapses into the same bucket. And the
  decay punishes the *accurate* player specifically — a perfect track
  bleeds to the floor while a sprayer on fresh targets keeps full 8.
  The handicap is on mastery, which is why the payoff must be serious.
- **The bank**: each tick banks `8 − tickDamage` (what the ramp withheld)
  ×2 into a per-target charge, cap 320. *The payoff*: the withheld
  damage isn't lost — it's stored ON THE VICTIM as a bomb. The only
  way to the 320 detonation is the ~2.7s sustained track that almost
  nobody can do — that's the tail-end skill expression.
- **Telegraph**: the victim wears an electric shroud that swells and
  flickers with charge; the beam itself thickens ~2.6× and crackles
  harder. The stored payoff is public — everyone can read the bomb.
- **Detonation economy**: any non-LG direct hit pops
  `min(banked, hitDamage)` — a pellet sparks 10 out, a rocket dumps 90;
  remainder keeps smoldering (decays at 5× fill rate off-beam). The LG's
  own kill pops the full bank.

## The anti-pattern in our own roster: the Chaingun ramp

The chaingun's ramp (`dmg += n`, up to +8 on sustained per-target hits)
is this design *backwards* — and it's the reason it's worth calling out:

- It pays the accurate tracker a linear bonus for sustained hits —
  i.e. it WIDENS the mid-skill gap. The decent aimer melts where the
  average one plinks. That's a skill separator, not a compressor.
- Its payoff is just more of the same damage — no spectacle, no stored
  resource, nothing the victim or observers can read or play around.
- Net effect on a noob: the good player holding the trigger does MORE
  damage to them, faster — the ramp is a stomp amplifier. It rewards the
  skill that already wins.

It is an anti-pattern — not a milder flavor, the inverted design. Any
mechanic that pays linearly for mid-spectrum accuracy is a stomp
amplifier: it takes the player who already wins the mid-skill gap and
makes them win harder, while giving the noob nothing to read, dodge, or
trade against. Under the north star that shape is simply wrong,
regardless of how common "ramp/spin-up" is in shooters.

The fix when the chaingun gets its pass is a conversion, not a nerf:
the ramp should bank a *separate* payoff state (overheat stun-power, a
spread-burst finisher, a telegraphed special) rather than flat +dmg —
compress the middle, pay the top. Same ramp, opposite seat.

## How rare is the pattern in our roster? Honest audit

- **Disc — the only genuine sibling.** Self-knockback risk (eat your
  own blast) is a real *cost*, spent on disc-jump mobility — the
  franchise-defining tail skill. Mid-skill players barely jump; experts
  cross the map in seconds. Cost→payoff in one mechanic. Fits.
- **Chaingun — the anti-pattern** (above).
- **Mortar — aim gate, wrong seat.** The arc is execution difficulty,
  and the 18m splash is forgiveness *for the shooter* — noob-friendly,
  but with no stored payoff; it's just a skill gate with a soft floor.
- **Railgun — pure skill gate.** A fast precise slug (450 m/s, 0.5
  proxy cap). No cost converts to anything; accuracy pays linearly.
- **Cannon — flat.** No forgiveness axis, no depth axis — the prime
  candidate for the next pass (slow dodgeable ball justifies a
  consecutive-hit charge/ramp payoff).

So: one full implementation (LG), one genuine sibling (Disc), one
anti-pattern (Chaingun), and three weapons that are difficulty-gated
or flat.

## The pattern in other games

**Tribes: Ascend — Spinfusor (disc)**
Same shape as ours: the blast that's dangerous to eat is the mobility
engine. The mid-skill player uses it as a slow grenade; the expert
chains mid-air discs into map-crossing routes. Tail payoff, real cost.

**Quake — Lightning Gun**
High point-blank DPS gated by tracking difficulty — the original
inspiration. But note: Quake's LG pays linearly for aim — it's a skill
gate, not a compressor. Ours goes further: the decay *absorbs* mid-aim
and converts it into stored payoff.

**TF2 — ÜberCharge**
Handicap: the medic can't fight — a real cost. Payoff: 8 seconds of the
strongest state in the game. And it telegraphs — the charge visual on
the pair is counterplay, exactly why our shroud exists.

**TF2 — Pyro airblast**
Weak flamethrower (cost) buys a reflect/push/extinguish toolbox
(payoff). Nobody reads the weak damage as a handicap — it's what the
utility costs.

**Fighting games — comeback mechanics (X-Factor, Rage)**
The "cost" is being behind; the payoff is damage scaling proportional
to deficit — codified rubber-banding that gives the losing player a
real out without taxing the winner. The cost side can be *situational*,
not statistical.

**Monster Hunter — Long Sword Spirit Gauge**
Gauge decays when you stop attacking — sustained pressure is the tax,
spirit finishers are the payoff. Same maintenance-creates-value shape
as our off-beam drain.

**Halo — Energy Sword lunge**
Useless at range (cost); the lunge spacing game *is* the skill
(payoff). One stat creates floor and ceiling together.

## Debinarization: the gentler sibling

Compression doesn't only come from cost→payoff couplings. The other
tool is **debinarization** — replacing 0-or-1 outcomes with gradients,
so "almost did it" pays a fraction instead of nothing.

Why it's stronger than it looks: aim is a *distribution*, not a point.
A pro's spread is tight — binary vs graded contact barely changes their
hit rate. A noob's spread is wide — binary gives them 0 for the same
shot a graded system pays 30% on. The gradient therefore compresses the
mid-skill gap *without taxing the top* — the cleanest compression there
is, because nobody feels a cost being extracted.

We already use it in several places:

- **Growing proxy hitboxes** (`hitMin`→`hitMax` over travel): a midair
  near-miss still registers contact — the classic all-or-nothing shell
  becomes a graze. This is the canonical example: pros were hitting the
  direct anyway, so the wake mostly pays the wide distributions.
- **AOE falloff** — edge chip instead of an in/out blast boundary (the
  banded `[[0.2,0.8],[0.5,0.4],[1.0,0.2]]` proposal sharpens this into
  readable tiers).
- **Partial charge detonation** — `min(banked, dmg)` means "couldn't
  fully pop it" still pays proportionally; the bomb is a gradient, not
  a switch.

Where the roster is still binary — the conversion candidates:

- **Railgun** — 0.5 proxy cap at 450 m/s is near-binary hit-or-miss.
  A modest wake or grazed-chip lane would grade it.
- **Melee** — connect-or-nothing inside 3.2m; a partial-whiff lunge
  would grade the edge.
- **Sticky fuse arm/disarm** — binary arm states; could pay partial
  charge on premature triggers.
- **Knockback thresholds** — launched vs not; graded juggle force would
  soften the cliff between "combo'd" and "untouched".
- **TTK cliffs generally** — 100hp vs per-hit damage leaves binary
  breakpoints everywhere; falloff/banding blurs them naturally.

The generic recipe is "give the miss a fraction": wakes, chip damage,
partial charge, reduced-effect instead of no-effect.

## Design rules extracted

1. **One mechanic, two seats.** The limiter and the payoff must be the
   same system — if you can describe the payoff without naming the
   cost, it's two features bolted together.
2. **Compress, don't gate.** A skill gate ("hard to aim") just raises
   the entry bar — it still pays mid-skill players linearly and stomps
   noobs harder. The north star compresses mid-skill separation and
   pays the tail instead. Two ways to compress: absorb the middle
   (cost→payoff, the LG) or grade the cliff (debinarization, the
   growing proxy). Prefer gradients where a binary edge exists — they
   compress without anyone feeling taxed.
3. **The payoff must be visible.** Stored power everyone can read is
   counterplay and drama; a hidden meter is a feel-bad surprise.
   Telegraph anything that can kill someone.
4. **Stored power must be maintained.** Charge decays off-beam; the
   ramp resets on target-switch. Parked payoffs are unearned ones.
5. **Proportional detonation keeps the economy honest.** Small hits
   can't arbitrage a big bank — `min(banked, hitDamage)`.
6. **The handicap is allowed to be scary.** A decay to 4/tick is a
   real cost — that's what buys a 320 payoff without breaking casual
   lobbies. Timid costs buy timid payoffs.
7. **Beware the inverted version.** Paying accuracy linearly (the
   chaingun ramp) widens the very gap we're trying to close — it's the
   anti-pattern, not a milder flavor of the same idea.

## Open questions

- Should the victim see their own charge on the HUD ("you're loaded —
  get clear"), or is the world-readable shroud enough?
- Charge doesn't survive death (it lives on the target id) — correct
  for now, revisit if it becomes a traded resource.
- PvP parity: shroud + detonation are client-side creature mechanics
  today; remote players would need server-relayed charge state.
- Chaingun: leave the flat ramp as-is, or convert it to a
  compress/pay shape (e.g. ramp builds a burst-finisher state)?
