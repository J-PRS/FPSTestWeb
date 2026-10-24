# Skills, perks & deployables — design rundown

Companion to `2026-10-24_CLASS_WEAPON_LOCKS.md` and
`2026-10-24_UNIVERSAL_WEAPONS.md`. Verified against
`client/src/entities/player/skills.ts` + `skillBeacon.ts`,
`shared/movement.ts` (ENERGY), `shared/status.ts`, `shared/perks.ts`,
`shared/deployItems.ts` (2026-10-24).

## The two economies everything draws from

- **Energy pool** (max 60): jets drain 15/s, recharge 8/s off-jet (held
  skill channels suppress recharge), one-shot skills ante 30, T2 sputter
  lockout 0.5s on a bottomed tank. Every trick costs mobility — priced
  against the jet tank, not a separate currency.
- **Belt pool** (`BELT_MAX 5`): every belt throw AND every pack deploy
  draws the same nuggets — 1 per toss, per-kind cost for deploys
  (turret 2, mortar turret 3, satchel 2). Ordnance and fort-building are
  one budget, so deploying is always an opportunity cost.

The shared-tank design is the load-bearing decision: it self-balances by
construction — you cannot spam skills without spending your escape.

## Q-skills — one slot, mutually exclusive

`SkillId` = bounce / blink / dash / slam / warp / cloak / shield / medkit.
One slot forces a real choice; the 1s uniform cooldown is a spam-breaker —
the energy ante is the real price.

### One-shots (30 energy ante)

**Bounce** — arm airborne (hold Q), redirect full speed along the
crosshair on touchdown. Pure redirect: magnitude preserved, nothing added.

- *Pro:* highest skill ceiling in the kit — converts a fall into a line.
- *Con:* invisible to casuals despite being the default; and it's the
  only trick that preserves rather than buys speed — the purist pick.

**Blink** — 20m along the crosshair, ray-marched 0.5m steps against
terrain (can't land inside a hillside — fizzles free if <2m clear),
smoothstep lerp in 0.16s, physics suspended, momentum restored.

- *Pro:* self-correcting landing — terrain march means a bad blink
  shrinks instead of embedding.
- *Con:* a teleport on a ski game skips the movement — a discipline
  break, only defensible because it costs half a tank.

**Dash** — +25 m/s along aim, instant impulse.

- *Pro:* simplest honest trick — composes with skiing, never replaces it.
- *Con:* least distinctive — a jets-flavored disc jump for energy.

**Slam** — airborne only; spikes vertical velocity to −55 m/s, the
landing IS the trigger (35dmg @9m). Horizontal momentum kept.

- *Pro:* the traversal→combat bridge — turns being airborne (vulnerable)
  into a threat.
- *Con:* a weapon occupying a movement slot — weakest *trick* of the four.

**Warp beacon** — two-beat: Q-down throws a bouncing anchor (45 m/s +
50% velocity inherit, 6s fizzle cap), Q-up teleports onto it with
momentum preserved. Ante paid on the *throw*, so the warp itself is
already bought — a beacon you can't afford can't exist.

- *Pro:* the standout — aim the throw, time the warp; momentum preserved
  keeps it Tribes-honest (UT translocator lineage done right).
- *Con:* hardest for enemies to read; beaconed flag-pull escapes are the
  abuse case.

### Channels (toggle, drain while held)

**Cloak** — 10 to enter, drain scales 1→10/s with horizontal speed.
Firing reveals you for 2s (`SHOOT_REVEAL_S`) to remotes AND bot/creature
senses — the cloak bit stays set, consumers mask it.

- *Pro:* drain-priced-by-motion is the design — infiltrating is cheap,
  cloaked skiing is expensive. The shoot-reveal mask keeps one bit honest.
- *Con:* cloak + satchel is the stealth-bomber combo the satchel's
  plant-range is meant to punish; cloak on a heavy nest hides a fort.

**Shield** — 20 to enter, 5/s drain; damage burns energy at 10 hp per
point, bubble drops at zero. Converts the fuel tank into a health bar.

- *Pro:* priced-as-tank means it's a dive/escape tool, not a second
  permanent health bar.
- *Con:* overlaps Featherfall's niche — the perk soaks falls at 20hp/pt,
  strictly better rate than the skill's 10:1 (falls only, but still).

**Mend (medkit)** — 20 to enter, 15/s drain, heals 12 hp/s; in MP the
server owns the heal tick (`STATUS.MEND` + `MEND_HP_PER_SEC`).

- *Pro:* pocket-medic priced against mobility on any frame.
- *Con:* 12 hp/s is between-fights patching — marginal vs the Scavenger
  perk; weakest case for a skill slot in the roster.

### Cross-cutting concern

Every one-shot is mobility-priced, so they're strongest on already-fast
frames — a dashing light is a monster. The balance lever isn't the 1s
cooldown, it's "how much jet did you just not have." The channel trio
adds three verbs to one pool; mend and shield each have a perk that
crowds their niche — the slot could lose 2-3 entries without losing an
idea.

## Perks — one passive per loadout

`shared/perks.ts`. Mostly modifiers, no new verbs; server enforces the
mechanics it owns (resist in applyDamage, regen tick, max hp).

| Perk | Effect | Read |
|---|---|---|
| Featherjets | jets burn 20% less | honest mobility discount |
| Plated | 25% resist **below 80% hp** | underdog armor — stops working while you're winning; elegant edge |
| Lifesteal | melee kill → heal to full; **lance kill → half** | event-shaped — only pays on kill edges, hits-to-kill untouched |
| Regenerator | regen to 4hp/s, ramps after 5s unhurt | sustained combat denies it entirely — anti-trickle by design |
| Overcharge | energy recharges 50% faster | the channel-skills perk |
| Sharpshooter | +20% direct, −40% blast radius | precision fork — pairs with Bombardier as a real dichotomy |
| Bombardier | +40% blast radius, −15% direct | carpet fork — mirror of Sharpshooter |
| Juggernaut | 80% less knockback taken | **watch pair with heavy** — near-immovable anchor on a stand |
| Scavenger | pickups heal 50% more | passive-value filler — nobody feels it |
| Lightfoot | own blasts cost 50% less self-damage | disc-jump subsidy — mobility perk in disguise |
| Airtank | +50% energy pool | feeds channels/jets; quiet |
| Reach | +25% pickup/flag touch radius | flag-runner flavor; quiet |
| Featherfall | falls soak energy at 20hp/pt | strictly better rate than the shield skill (10:1) — a perk outdoing a skill at its own niche is a design smell |
| Jumpstart | +6 m/s on ski-press, only below run cap | self-limiting by construction — can't be milked at pace |

## Deployables — belt-priced plants

`shared/deployItems.ts`. Caps + costs keep forts finite; everything costs
2 nuggets except mortar turret (3) and satchel-throw (2). `bodyR/bodyH`
are the solid collider; drones/nuggets/water/tether are non-solid.

### Combat emplacements

- **Turret-Missile** (cap 2, 60hp, 42m, 14dmg/1.25s) — the honest field
  turret; two for 4 nuggets is a real fort investment.
- **Turret-Mortar** (cap 1, 90hp, 95m reach, 20m dead zone, real Mortar
  shells every 4s) — fires the actual weapon row so stats can't drift.
  Dead zone is the counterplay; most Tribes-true item in the set.
  Liability on small maps.
- **Turret-Chaingun** (cap 2, 50hp, 36m, ~24dmg pulses) — suppression,
  LOS-gated; the "keep skiers honest" emplacement, honest-tier damage.
- **Mine** (cap 6, 20hp, 3.2m fuse, 22@6m) — six mines = 12 nuggets, a
  real minefield. 22dmg is deterrence not lethality — correct; lethal
  mines feel terrible at ski speed.
- **Drone** (cap 2, 40hp, 35m, 9dmg/1.6s, hovers over owner) — chase pet;
  non-solid so it can't punt its owner. Modest free pressure.

### Support / control

- **Healing Pad** (cap 1, 80hp, 9m, 9% maxhp/s) — stand sustain. Watch:
  pad + heavy + repair beam is the documented turtle loop.
- **Barrier** (cap 1, 120hp, 6m dome) — energy field: stops shells, NOT
  bodies. Right call (walk-through cover); needs visuals that sell it.
- **Watersphere** (cap 2, 30hp, 45s, 7m dome) — a pocket of sea as a
  roadblock: enemies capped at 8 m/s wading, team walks dry. Creative and
  rules-honest; short ttl keeps it a roadblock, not a base.
- **Tether** (cap 2, 6m snare) — outward speed bled by curve: full stop
  under 20 m/s, 20% at 60, free above 80; breaking free zaps 24 jet
  energy. Punishes *leaving*, not entering — skiers blow through, walkers
  get pinned. Mostly an anti-defender/bot tool in practice.
- **Nugget** (cap 8, instant) — converts belt charges into a droppable
  health pickup; feeds the pool back into itself.
- **Targeting Beacon** (cap 1, 10hp, 300s) — laser designator: plants an
  aim point, live-solves your firing arc, HUD reticle shows where to
  point so the lob lands on it. Deadly in a coordinated squad, useless
  solo — exactly what a beacon should be.

### Authored-only (cap 0 — map assets, never plantable)

- **Generator** (400hp) — the raid prize; fat bodyR 2.8 soaks splash.
- **Sensor** (120hp, 120m sweep) — the team's eyes.
- **Base Turret** (160hp, 55m, 40dmg @3m, 80 m/s real bolt) — leadable,
  dodgeable — not hitscan; heavier than field gear as intended.

## Placement rules

1. **New skills ante against the jet tank** — a trick that doesn't cost
   mobility is a free verb and will be spammed.
2. **New deployables price against the belt pool** — cost = how much
   ordnance you gave up; a free plant is a balance bug.
3. **Channel effects share one pool** — cloak/shield/mend can't stack by
   design (one drain at a time); keep it that way.
4. **Watch list:** heavy+pad+repair turtle; cloak+satchel; Juggernaut on
   an anchor; tether's real-world usefulness (skiers ignore it);
   mend-vs-scavenger and shield-vs-featherfall niche overlap.
