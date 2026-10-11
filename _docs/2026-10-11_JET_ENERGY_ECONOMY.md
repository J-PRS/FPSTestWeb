# Jet/energy economy — KRIBES vs the Tribes family

Comparison of the jetpack energy pool, burn rate, and regen across
Starsiege: Tribes (T1), Tribes 2 (T2), Tribes: Vengeance (T:V),
Tribes: Ascend (T:A), Tribes 3: Rivals (T3), Legions: Overdrive,
and Midair — benchmarked
against our `shared/movement.ts` ENERGY table (authoritative, both ends).

## Quick lookup (fixed-width, reads clean raw)

```
game            pool          drain/s       regen/s         sustained jet
--------------  ------------  ------------  --------------  ------------
KRIBES (ours)   60            15            8               ~4s
Tribes 1 (L)    60            25 (net 17*)  8 (11 w/pack)   ~3.5s
Tribes 2        60/80/110     0.8**         0.256**         ~4-6s
T: Vengeance    100           17?           12? (16.25 pack) ~5.9s?
Tribes: Ascend  100 all       ~25?          13L/13M/12H     ~4s?
Tribes 3: Riv.  100/100/90    40 all        ~16-21.6/class  ~2.5s
Legions         33L/40M/40H   22.5 up-jet   5.6/6.9/7.8     ~1.5-1.8s
                               (+12.5 grounded, see below)
Midair          L/M/H n/m     n/m†          pack-rate base  seconds
```

n/s = rate lives in native engine code (decompiled source confirms
the fields exist). n/p = no published value. n/m = scripts exist but
were only distributed inside game installs — never mirrored to the
indexed web; the numbers are obtainable, just not googlable.
? = UNVERIFIED — only source is a Google AI Overview. For T:V it
claims 17/s burn + 12/s regen (16.25/s w/ Energy Pack → 6.15s
refill); its cited sources don't contain those figures (the 6.15s
traces to a T:A health-regen stat). For T:A it claims ~25/s burn;
that one matches the widely-repeated community "empties a full bar
in ~4s" (GrethSC guide) — but a second Overview claims per-armor
22.5L/25M/28H, which smells like cross-contamination (22.5 is
literally Legions' jetUp drain) and contradicts T:A's design where
armors differ by regen, not burn. No primary source for either.
† Midair fields CONFIRMED in a public SDK dump (JetEnergyDrainRate,
  EnergyRechargeRate, GroundEnergyRegenAmount, EnergyRegenDisable*);
  only the values are missing — they live in cooked .pak blueprints.
* T1 regen runs EVERY tick even while jetting — 25 drain - 8 regen
  = net 17/s burn (14/s with the Energy Pack's +3).
** T2 values are script fractions of `maxEnergy` — the numbers are
  certain, the per-second conversion is not.

## Design rules shared across the family

- **One pool feeds jets + energy weapons + packs/channels** — every
  game, ours included.
- **Regen whenever jets are idle** — T:V manual states it outright;
  ours matches (anywhere off the jet, incl. airborne). **Legions and
  Midair add a grounded bonus**: Legions stacks +12.5/s on its ~6–8/s
  base while grounded; Midair's SDK exposes `GroundEnergyRegenAmount`
  + `WalkingEnergyRechargeBoost` fields doing the same job.
- **Energy Pack = faster regen** in T1, T2 (+58.6%), T:V, T:A; Midair 2
  folded it into baseline because it was never not taken.
- **Flat-cost burst tricks ante most of the tank** — T:A Thrust Pack
  costs 80/100 for 36 m/s; our tricks cost 30/60.
- **Shield converts damage to energy loss** — T2 `energyPerDamagePoint`,
  Legions shield core, our shield (10 dmg/pt).
- **Jets have a floor/penalty at empty** — T2 `minJetEnergy = 1`, T:V
  `energyMinimum = 10`, Midair `EnergyRegenDisable*` post-depletion
  lockout; our 0.5s sputter is a stricter variant.
- **T1 regen never stops, even while jetting** — recharge is added
  every tick unconditionally, so the true burn is drain minus regen.

## Per-game detail

### Starsiege: Tribes (1998)

Real constants from a community physics decompilation (floodyberry,
31.25 Hz tick, light armor):

- `MAXENERGY = 60`, `JETENERGY_DRAIN = 25`, `JETENERGY_CHARGE = 8 + 3`
  — the +3 is the Energy Pack boost; base regen 8/s, pack 11/s.
- Recharge is applied **every tick unconditionally**, even while
  jetting — so jets burn a net 17/s (14/s packed). Sustained light
  jet ≈ 3.5s stock, ~4.3s packed; refill 7.5s / 5.5s.
- Jets stutter near empty (~5%) instead of hard-locking.
- The "armor power cell" powers jets AND energy weapons: the Blaster
  (free spawn gun) draws from it, the LASER rifle's damage is
  proportional to energy drawn, and the ELF gun exists to drain the
  *enemy's* cell — denying them jets. Shield pack: damage goes to the
  cell instead of health while active.

### Tribes 2 (2001)

The only fully-scriptable economy of the family — `player.cs`
datablocks are public:

- Pools: light 60 / medium 80 / heavy 110 (`maxEnergy`).
- `rechargeRate = 0.256`; Energy Pack `rechargeRateBoost = 0.15` →
  +58.6% — the dominant pack choice, required for the laser rifle.
- `jetEnergyDrain = 0.8`, `minJetEnergy = 1` (can't start jets at the
  floor — our sputter lockout is a stricter version of this).
- `energyPerDamagePoint = 75` — shield-energy-per-damage-point for
  pack shields.
- Armor variants (`ScoutMaleArmor` etc.) retune pool per subclass —
  light scout drops to 55.

### Tribes: Vengeance (2004)

Full decompiled UnrealScript source is public
(source.tribesrevengeance.net, UnCodeX):

- `Gameplay.Character` defaults: `energy = 100`,
  `energyMaximum = 100`, **`energyMinimum = 10` — jets refuse below
  10 energy**, our lockout's real ancestor.
- `Gameplay.EnergyPack` defaults: `rechargeScale = 2` (**doubles
  recharge**), `boostImpulsePerSecond = 170000`, boost window 0.75s
  ramp + 0.75s duration — passive regen + an active speed burst
  cappers chained with skiing. Promod tunes it to `EnergyBoost=75000`
  for 1.0s with an 18s cooldown.
- Energy weapons spend from the same pool (promod.ini): **Plasma 10
  energy/shot, Blaster 2 energy/shot** on a 100 pool — every shot is
  a jet second foregone, same shared-tank doctrine.
- Pack cooldowns (promod): Energy 18s, Speed 13s, Shield 16s —
  activation economy, separate from the energy pool itself.
- Per-second drain/recharge live in named CSIRO `movementConfiguration`
  strings (per armor, plus Speed-Pack fast active/passive variants),
  which are config data in the install, not .uc script — so they're
  `n/m`, same category as Legions: on-disk, not indexed.
- Manual rules confirmed: regen whenever the jetpack isn't active, no
  sustained flight by design, energy shared with energy weapons.

### Tribes: Ascend (2012)

Best-documented numbers after T2:

- All armors normalized to **pool 100** in patch 1.1.2860 (was 70
  light / 80 medium / 100 heavy).
- Regen per the exiled wiki stat tables (final live values):
  **13/s light, 13/s medium, 12/s heavy** → refill ~7.7 / 7.7 / 8.3s.
  (Patch-era sources claimed 15L/20M/10H post-1.1.2860; the wiki's
  stat infoboxes are the later, more consistent numbers.)
- Jet burn ≈ **25/s** — community-measured ("a full bar empties in
  ~4s", GrethSC guide) → ~4s sustained jet, near-identical to ours.
  (The wiki's armor infoboxes expose pool + regen only; no burn stat
  is published anywhere — ~25 is inferred from the ~4s figure.)
- Pack/perk values from the wiki: Shield Pack drains **8/s flat**
  while held (Heavy Shield Pack same, -50% upgraded → 4/s, diverts
  up to 750 damage to energy) — the exact shape of our shield.
  Energy Pack +5→+25 pool by class, Survival Pack +15 pool & +15%
  regen, Ultra Capacitor +10/+10, Rage instant +50 energy.
- T:A jet physics (TL.net, Mar 2012): the "jetpack" zeroes gravity
  and accelerates linearly but **caps at 72 kph**; above that it
  only cancels gravity (+1 kph). No thrust vectoring — air control
  is free (opposite of T2/Midair/ours where corrections cost or
  need jet energy). Burn stays on regardless, so T:A players
  feather taps, not for energy but because the jet stops doing
  anything at speed.
- Phase Rifle: charged shot draws from the energy pool AND ammo —
  BXT1 patch note: "with max energy 75, regen to full charged shot
  5.35s (was 8.9s)" — a weapon whose firepower is gated by regen.
- Thrust Pack: **80 energy flat** for up to 36 m/s — a near-full-tank
  ante per trick, the exact design our pre-nerf 50/60 mirrored.
- Stealth Pack: 5/s cloak drain (4/s upgraded) — our cloak's 1–10/s
  speed-scaled drain is richer but same shape.
- Regen sources stack: Energy Recharge Pack (+4%/upgrade tier), Ultra
  Capacitor I/II, Potential Energy, Survivalist, Rage (+50 pool, +20%
  regen).

### Legions: Overdrive (2012)

Full numbers extracted from the shipped TorqueScript datablocks
(`game/server/game/dataBlocks/`):

- Pools: **Outrider 33 / Raider 40 / Sentinel 40** (`maxEnergy`).
- Regen is TWO rates: `rechargeRate` always (5.625 / 6.875 / 7.8125)
  PLUS `groundRechargeRate` **+12.5 additive while on the ground** —
  grounded regen is ~18–20/s vs ~6–8/s airborne. The only game in
  the family with a grounded regen bonus; everyone else regens
  whenever off the jet.
- Jet drains by direction: `jetUpEnergyDrain = 22.5`,
  `jetDownEnergyDrain = 21.875`, `jetSkateEnergyDrain = 4.6875`
  (ground hover-strafe), directional air jets 0, idle 0. Sustained
  up-jet ≈ **1.5s Outrider / 1.8s Raider+Sentinel** — the shortest
  burn in the family; Legions jets are pure burst.
- `lowEnergyJet*Scale`: horizontal jets keep working at low energy
  (scale 1.0), vertical jets dead at 0 — empty tank still leaves
  lateral control.
- Core costs (`dataBlocks/cores/cores.cs`): **Dodge `energyCost=0.3`
  = 30% of current energy** (confirms the patch note's "30% of
  remaining"); Shield `energyTick=0` free but `damageDrain` converts
  damage to energy loss per class (0.5 light / 0.7 medium / 0.82
  heavy); Regen `energyTick=-4.45` drains energy→health; Overdrive
  `overdriveEnergyDrain=1000` (instant drain) but Outrider's
  `overdriveKillsEnergy=true` means OD costs energy not health.
- Laser Rifle Mk II: **drains ALL energy on fire, damage ∝ energy
  consumed** (June 2009 patch) — one shot spends the whole tank.

### Tribes 3: Rivals (2024)

Fully stat-tabled on the exiled wiki — the newest official entry:

- Pools: 100 light / 100 medium / **90 heavy**.
- **Jetpack drain 40/s identical on every class** → ~2.5s sustained,
  the shortest official burn. T3 also answers T:A's open question:
  modern Tribes varies REGEN by class, not burn (16–21.6/s per
  class) — supporting flat-burn for T:A too.
- Regen is class-tuned, not armor-tuned: Sentinel 21.6/s (incl.
  +20% passive → base ~18), Raider 17/s, Juggernaut 16/s.
- `Jetpack Overburn Duration 5s` — jets keep running 5s PAST empty
  at reduced power, a softer version of Legions' lowEnergyJet.
- New energy-interaction mechanics: **EMP grenade drains energy and
  blocks regen**; **BXT1 rifle hit drains energy + halts regen**;
  Shield Pack caps max energy at 75 while held; Air Control is an
  explicit 30% stat.

### Midair (2018) / Midair 2

Closest mechanical sibling (built by Legions veterans). Closed UE4,
but a public SDK dump of Midair: Community Edition v1.9.1.12285
(github MuhanjalaRE/Midair-Community-Edition-SDKs) exposes the
native `AMACharacter` energy fields — the economy's SHAPE is
confirmed even though the default VALUES live in cooked .pak
blueprint data, not headers:

- `JetEnergyDrainRate`, `EnergyMax`, `EnergyRechargeRate` — the same
  pool/drain/regen triple as ours.
- `GroundEnergyRegenAmount` + `WalkingEnergyRechargeBoost` — Midair
  ALSO has a grounded/walking regen bonus, so Legions isn't the only
  grounded-refuel design in the family after all.
- `EnergyRegenDisableThreshold` + `EnergyRegenDisableDuration` —
  a regen lockout after depletion; our 0.5s sputter has a direct
  Midair ancestor too, alongside T2's minJetEnergy and T:V's
  energyMinimum.
- `UpwardJetBonus*` suite (BurnRate/BurnPower/RegenRate/WaitTime) —
  upward thrust has its own burn curve separate from lateral jets,
  same direction-split idea as Legions' up/down/skate drains.
- `JetHitLowEnergySound` / `bWasOnLowEnergy` — a low-energy warning
  state exists.
- Thrust vectoring means **direction corrections drain energy** —
  air control isn't free (dev interview).
- Midair 2 deleted the Energy Pack entirely and baked pack-rate regen
  into baseline — the pack was so dominant it stopped being a choice.
- To get the actual numbers: extract BP_LightCharacter's CDO from
  the game's .pak (FModel/umodel) — Midair CE is free (Steam app
  1231210, UE4.23).

## Design takeaways

1. **Pool sizes cluster at 60–100.** Ours (60) matches T1 and T2
   light exactly — deliberate since our pool also feeds 6 skills +
   3 channels, more sinks than any of the others.
2. **We're nearly a T1 clone numerically.** T1 light: pool 60, regen
   8/s, refill 7.5s, ~3.5s sustained jet. Ours: pool 60, regen 8/s,
   refill 7.5s, ~4s sustained — the only difference is T1 regen keeps
   running during the jet (net 17/s burn) while ours pauses (15/s
   burn). Coincidence or not, we landed on the original's economy.
3. **Regen-anywhere-off-jet is the T:V rule** — and the Midair-era
   consensus that pack-rate regen should be baseline. Good company.
4. **Flat-cost tricks ante most of the tank is proven.** T:A Thrust
   pack: 80/100. Our new 30/60 = half tank — cheaper than the family
   norm; if tricks read spammy, 40–50 is where the family lives.
5. **Channels suppressing regen exists in the family** (Legions
   shield+jets), ours is stricter (full suppression). Defensible.
6. **Energy-as-damage is a family mechanic** (T1 LASER ∝ energy,
   T2 `energyPerDamagePoint`, Legions shield converts damage→energy,
   T:A Phase Rifle). Our shield's 10-dmg-per-energy-point is the same
   lineage.
7. **The Energy Pack pattern repeats**: every game offered regen-for-
   pack-slot, every game it became near-mandatory, Midair 2 finally
   folded it into baseline. If we ever add a regen pack/perk, expect
   it to become the default pick.

## Sources

- T2: `scripts/player.cs` datablocks via modding.tribes2wiki.com
  handbook; Tribes Depot energy pack page (+58.6% boost)
- T1: floodyberry.wordpress.com "Tribes 1 Physics" parts 1–2
  (decompiled constants: MAXENERGY 60, DRAIN 25, CHARGE 8+3,
  regen-every-tick) + official manual + GiantBomb + GameFAQs FAQ
- T:V: source.tribesrevengeance.net UnCodeX decompile
  (`Gameplay.Character` energy=100, energyMinimum=10) + official
  manual (regen rule) + TribesRevengeance newblood guide
- T:A: wiki.theexiled.pwnageservers.com armor pages (pool 100 all,
  regen 13/13/12 L/M/H) + patch v1.1.2860 notes + Thrust/Stealth pack
  pages (80 flat, 5/s) + Steam update 1.2 notes (BXT1 energy regen)
- T3: wiki.theexiled.pwnageservers.com class pages (Sentinel/Raider/
  Juggernaut infoboxes: pool, regen, 40/s jet consumption, 5s
  overburn, 30% air control) + pack/grenade pages
- Legions: shipped TorqueScript datablocks, extracted from a local
  install — `game/server/game/dataBlocks/preload/BasePlayer.cs`,
  `players/{Outrider,Raider,Sentinel}.cs`, `cores/cores.cs`
  (pools 33/40/40, regen 5.6/6.9/7.8 + 12.5 grounded, jetUp 22.5,
  skate 4.7, dodge 30% of pool, OD drain 1000)
- Midair: github MuhanjalaRE/Midair-Community-Edition-SDKs (v1.9.1
  header dump — field names/mechanics, no default values) + IndieDB
  Midair 2 notes (pack removed→baseline) + dev interview (thrust
  vectoring drains corrections)
