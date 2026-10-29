# Explosion VFX Bible

Reference for the blast-presentation stack — the architecture, the per-weapon
variant recipes, the design rules behind them, and the tuning knobs. Companion
to `_docs/2026-06-11_EXPLOSION_VFX_SYSTEM.md` (the original five-layer design);
this doc covers the variant era: per-weapon recipes, the shellburst family, and
the pro-VFX principles the recipes encode.

## 1. Architecture map

```
impact.ts
├─ spawnImpactEffect()      local predicted blasts (also sends the AOE claim)
│   └─ processProjectileExplosion() → blast presenter + damage/claims
├─ spawnVisualOnly()        remote replicas / demos — FX only, no claims
└─ crumbles / burstShards   BallDebris bursts (rock shards), no dome

Explosion (effects/explosion.ts)
└─ ExplosionLayers (effects/explosionLayers.ts) — VariantHost primitives:
   spawnFlash, spawnBurst (quarks batch), blastTinted, allocShock (dome
   pool), spawnGroundRing (TerrainRing), sparks (ExplosionSparks batch)
   └─ BlastVariants (effects/blastVariants.ts) — per-`vfx` recipes.
      Variant returns true → shared powder recipe is SKIPPED entirely
      (variant owns the whole look). Unknown/missing vfx → shared
      spawnBaseLayers powder blast (flash+fireball+debris+embers+smoke).
```

Pool/batch notes: shock domes pool (`SHOCK_POOL_KEEP 16`), spark trails bake
into one shared `LineSegments` (`SPARK_TRAIL 8`), blast particles go through
`blastBurst` quarks batches — every layer is ≤1 draw call.

Key constants:
- `EXPLOSION_VFX_RADIUS = 6` — `mult` passed to recipes = `explosionRadius / 6`
- `AOE_VFX_SCALE = 0.8` — `explosionRadius = aoeRadius × 0.8`, so the true
  damage radius inside a recipe = `mult × 6 / 0.8 = mult × 7.5`

## 2. The `vfx` field (ProjectileConfig / Explosion opt)

| vfx | Weapons | Recipe |
|---|---|---|
| *(none/fallback)* | most | shared powder blast, concussion flag adds weight/dirt |
| `splash` | Sprinkler | whitewater: opaque foam globs, streaked droplets, aerosol |
| `punch` | melee/kinetic pops | dust puff + a few streaks, no flash |
| `energy` | Disc, Plasma, EMP, HealGrenade | white core + tint shell + spike fan + twin shock domes |
| `kinetic` | Railgun, RemoteRailgun | pin flash + speedline fan + dust, no fireball |
| `concussion` | Mortar, Cannon→(now shellburst), RKT, MRV | heavy variant of base: dirtier, smokier, longer |
| `arc` | Lightning, Shocklance | jagged violet spikes + sizzle core, no dome |
| `bolt` | PlasmaGun, MRV, belt nades | energy recipe shrunk to repeater scale |
| `flak` | Flak | spherical ember bloom, thin cordite wisps |
| `shellburst` | **Cannon, Gonne, Basilisk** | black-powder burst — see §4 |

`types.ts`, `explosion.ts`, and `lab/simKit.ts` each declare the vfx union —
new variants must land in all three (plus the dispatch case + recipe method).

## 3. Design rules (researched — sources §6)

### AOE accuracy is a hard rule
Riot's VFX style guide cites a blast that under-shows its damage radius as the
canonical *failure* — the visual must represent the real reach, or players
can't trust it. In this codebase that means: ring/dome/edge elements are
sized from `aoeRadius` (the `mult × 7.5` derivation), never eyeballed. Accents
(chips, sparks, debris) that visibly overshoot the radius *lie* — keep free-
flyers inside the envelope; only the telegraph may touch the edge.

### Timing beats
Per-layer lifetimes are the effect's progression (RoClicks recipe):
- **Flash**: 0.06–0.1s — the violence frame, brightest thing on screen
- **Streaks/shards**: fast (30–100 m/s) but short-lived accents
- **Ring/shock**: grows to edge over 0.2–0.4s — the AOE telegraph
- **Embers**: 0.75–2s — outlive the flash, give the blast mass
- **Smoke**: 1.5s+ — the long residue; smoke must NOT outpace the shockwave
- **Intensity only decreases** — nothing re-brightens mid-effect
- **Mass keeps growing** ~0.25–1.3s after the flash dies — body layers
  (smoke/crescents/puffs) swell while brightness falls

### Motion curves
"Pop then erode" — front-loaded ease-out expansion (`1-(1-t)²` on shock
domes here, shared update). Linear scale-up reads dated. The dome's tail is
clipped before full stop so it hands off to smoke seamlessly.

### Edge telegraph
The `shellburst` AOE spark shell: embers spawned ON the damage sphere
(`aoeR = mult×7.5`), `grav: 0.15` so they hold the edge instead of raining
off, 0.55–0.9s life. Complemented by the dusty `allocShock` dome sweeping to
the same radius. Two reads of the same truth: instant shell + traveling wave.

### Layered cheapness
3–5 cheap layers > 1 rich layer; each layer must have a nameable job — if
removing one loses nothing, cut it. Bloom is reached by stacked additive LDR
layers, not one HDR quad.

### Stagger
`stagger` (emission spread) desynchronizes every layer — synchronized pops
read as single blobs. 0.03–0.15s per layer.

## 3b. Pro techniques, round 2

### Flash covers the swap
The brightest frame is free cover for anything you need to hide: mesh
swap, shard spawn, decal pop. Real footage frame-picking shows the
fireball peaks for 1–2 frames — that's when the ball should become
debris (our `burstShards` spawns on the same tick as the flash for
exactly this reason).

### Point light is half the blast
A bright point light fading over ~0.5s does more for "this exploded"
than another particle layer — it lights terrain, players, and smoke
from inside. Our Explosion already carries a light; keep its falloff
proportional to the dome, not the flash sprite.

### Camera shake — trauma model, distance-scaled
The slowrush/trauma recipe: a `trauma` 0–1 level that decays, camera
offset by `trauma²`, smoothed by noise. Blast shake should scale by
inverse-square proximity AND be distance-delayed so it feels like the
shockwave arriving, not an instant global wobble. (Check `screenShake.ts`
before adding — the repo may already carry the trauma pattern.)

### Shock expansion law: r ∝ t^0.4
Trilithon's pressure-wave devlog measured real blast growth: radius
rises as `t^0.4`, not linearly. Our `1-(1-t)²` ease-out approximates
it; `t^0.4` is the physically-true curve and makes early frames pop
harder — worth trying on `updateShockwaves` if the dome still reads
slow off the mark.

### Blast bending / screen-shell refraction
High-end trick: a transparent shell that screen-space-refracts what
passes behind it, expanding with the wavefront — the "pressure made
visible" read. Trilithon found the shell needs ~3m thickness and ~2×
max stretch to avoid melting thin geometry; a second "ring crossing the
camera" pass sells being inside the wave. We don't do refraction, but
the same read is faked cheaply: the expanding additive dome IS our
bending shell.

### Fire + smoke can be ONE material
DaryllEspanola's stylized recipe: a single particle material holding
both fire (emissive) and smoke (lit) layers, dissolving emissive first
so the fire dies into smoke. We're split-material (glow batch vs smoke
batch) — equivalent result, but the *order* rule stands: emissive
layers must erode before/during smoke, never outlive it.

### Erosion over alpha-fade
The "pop then erode" rule applied to textures: particles should
dissolve via noise erosion (silhouette gets eaten, edges glow as the
burn front) — alpha-fade-last. A blob that fades at constant silhouette
reads as gas. Our smoke puffs are texture-bound already; if they ever
read flat, erosion texture beats opacity curve.

### Quarter-speed self-check
Pro workflow check from the Unity lib: play every effect at ¼ speed —
each beat must be individually visible and no two layers may move in
lockstep. If two layers track together, merge them (one is redundant)
or re-stagger them.

### Flipbooks (aspirational — we don't ship them)
The industry default for "expensive-looking" fire/smoke is a simulated
flipbook: baked sim frames on a billboard, X/Y motion-vector textures
interpolating between frames so a 12-fps bake plays smooth. If the
project ever wants filmic fireball texture, a small flipbook + motion
vectors is the proven route — but it's a texture-pipeline cost we
currently dodge entirely with procedural layers.

### Fillrate, not count
Don't fear particle counts — fillrate (overlapping additive pixels)
is the real budget on low-end GPUs. Fewer BIG overlapping billboards
beat many small ones; giant smoke sprites are the expensive layer, so
keep smoke counts honest rather than shrinking particles.

### One more staging trick
The "delayed ground light": spawn the ground ring/light 3–4 frames
after the flash — light propagation outrunning the flash reads wrong;
a beat of lag makes the wave feel like it travels.

## 3c. The check list (use before shipping a new recipe)

- [ ] Does the visual reach exactly the damage radius? (test vs `?debug` AoE gizmo)
- [ ] Does anything visibly overshoot it that isn't a telegraph?
- [ ] Brightest frame covers the swap/spawn? 
- [ ] Each layer's lifetime different from its neighbors?
- [ ] Intensity strictly decreasing after the flash?
- [ ] Mass still growing at 0.3–1s (smoke/embers outliving the pop)?
- [ ] Smoke slower than the shockwave?
- [ ] Quarter-speed: every beat distinct, no lockstep layers?
- [ ] Readable with bloom off (silhouette + color carry it)?
- [ ] Reads at 60m+ (the ring/edge survives distance LOD)?

## 4. `shellburst` — the black-powder recipe

For the arc family (cannon/gonne/basilisk). Historical basis: black powder
bursts = weak dirty flash + DENSE WHITE smoke (potassium sulfide) + shell
fragments + sparks. Fireworks share the chemistry — "a lot of sparks and
smoke" is period-correct.

Layers, in spawn order:

1. **Dirty flash** — 1 billboard, 5.5×mult, orange-brown, ~0.11s. The oomph.
2. **AOE spark shell** — ~26×mult embers on the true damage sphere, grav
   0.15, drift 5 m/s, life ~0.55–0.9s. The telegraph.
3. **Dusty shock dome** — `allocShock(0xC0A878, 0.32s, aoeR, 0.35)` —
   traveling wavefront to the exact radius, ease-out.
4. **White smoke heart** — 12×mult puffs, spd 1.5–7, life 1.2–2.2s,
   near-buoyant (−2). The sulfide signature and the long tail.
5. **Charcoal core smoke** — 6×mult darker puffs inside the white.
6. **Incandescent chips** — 26×mult glow chips, spd 18–40, life 0.2–0.55s,
   gravity −30. The shell wall coming off hot.
7. **Iron sparks** — ~6×mult free sparks, spd 15–37, life ~0.3–0.5s.
8. **BallDebris** (via `burstShards` in impact.ts) — spherical rock-shard
   burst at `bodyRadius` scale, no directional carry. The ball's mass.
9. **Ground ring** — TerrainRing at 0.7×mult.

SFX (`core/sfx/explosions.ts`): family voices on one `explosion1` base —
Gonne pitched 0.95 (crisper clang), Cannon 0.75, Basilisk 0.6 (deepest
thud). Same voice, three weights — the flavored-reskin contract in audio.

## 5. Tuning knobs (single numbers that change the read)

| Want | Knob |
|---|---|
| Brighter edge | `ringN` count / `spark.o` opacity |
| Ring lasts longer | ring `spark.life` |
| Ring doesn't droop | `spark.grav` (0 = float forever) |
| More violence | flash `sizeMin`/`sizeMax` (5.5×mult), chip `spdMax` |
| More powder feel | smoke count/life (12→18, 1.2s→2s) |
| Dirtier/darker | charcoal r/g/b, smoke r1/r2 toward grey |
| Different dome feel | `allocShock` life + color; ease exponent in `updateShockwaves` |
| Ball mass sells | `burstShards` → BallDebris `BALL_CHUNK_COUNT` (14) |

Per-family scaling is automatic via `mult` — gonne's blast renders ~70%
of cannon's because `aoeRadius` feeds it. Nothing in the recipe is
hard-coded per weapon.

## 6. Sources

- Riot Games, *VFX Styleguide* (League of Legends) — AOE accuracy,
  primary/secondary element hierarchy, readability over density.
  nexus.leagueoflegends.com/wp-content/uploads/2017/10/VFX_Styleguide_final_public_hidpjqwx7lqyx0pjj3ss.pdf
- RoClicks, *Anatomy of an impact* — the per-layer lifetime timeline,
  intensity-decay/mass-growth rules, ember/smoke/ring budgets.
  roclicks.gg/resources/vfx/impact-recipe
- Unity Workflow Library, *VFX workflows* — cheap-layer rule, additive
  stacking to bloom, "explosions pop then erode", hard smoothstep edges.
  unityworkflowlibrary.dev/workflows/vfx/
- Quirk Bit, *Adrift Arena devlog — Creating Stylised Explosions* —
  ease-out expansion clipped before stop → smoke handoff, vertex-noise
  dome erosion, color-temperature gradient.
  quirkbit.itch.io/adrift-arena/devlog/122433
- Pavel Zosim, *Houdini procedural explosion* — phase breakdown
  (impact/detonation/expansion/dissipation), layer independence.
  pavelzosim.com/post/houdini-procedural-explosion-vfx/
- Real Time VFX forums — flash-as-cover for the swap frame, shock must
  outpace smoke, stretched-spark texture trick, fillrate > count limits,
  one-material fire+smoke with emissive-first erosion, shader-faked
  flipbook frames. realtimevfx.com (threads 16021, 1767, 11742, 27577)
- Trilithon Games, *Shockwave you can see* — measured blast growth
  r ∝ t^0.4, refraction-shell thickness/stretch limits, camera-crossing
  ring, distance-delayed audio/shake. trilithon.games/devlog/shockwave-you-can-see/
- Slow Rush Games, *Big Bada Boom* — trauma-model screenshake
  (trauma² displacement, noise smoothing, user-facing strength control).
  slowrush.dev/news/explosions/
- PC Gamer, *How great game explosions are made* — timing-first
  blockout before particles, camera-shake + full-screen effects as part
  of the blast, readability at close AND far ranges.
  pcgamer.com/how-great-game-explosions-are-made/
- Lorenzo HS, *Optimized explosions for UE5* — flipbook anatomy,
  motion-vector interpolation, fillrate tradeoffs.
  loronsodev.github.io/posts/explosion-fx/
- Historical basis: NPS *Artillery Through the Ages*, *Naval Ordnance
  1937* ch. II, Gettysburg-era fireworks accounts — black-powder =
  white sulfide smoke + sparks + weak dirty flash; solid shot ricochet
  ("grazing fire") was the real period cannonball behavior.

## 7. File pointers

| What | Where |
|---|---|
| Variant dispatch + recipes | `client/src/effects/blastVariants.ts` |
| Host primitives (flash/burst/shock/ring) | `client/src/effects/explosionLayers.ts` |
| Spark batch + per-spark `grav` | `client/src/effects/explosionSparks.ts` |
| Dome pool / shock update (ease-out) | `explosionLayers.ts` `allocShock`/`updateShockwaves` |
| Ball shard bursts (`crumbles`, `burstShards`) | `client/src/game/combat/impact.ts` + `effects/debris.ts` |
| Blast SFX voices | `client/src/core/sfx/explosions.ts` |
| `vfx` union type | `projectiles/types.ts`, `explosion.ts`, `lab/simKit.ts` |
| Weapon→vfx bindings | `client/src/projectiles/*Config.ts` |
