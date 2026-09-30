# Terrain generation — seamless heightmaps end-to-end

How the field is authored offline and sampled at runtime, what "seamless"
actually costs, and the modern toolbox ranked by what it buys us.

## The contract

- Terrain is a **square 8-bit heightmap**, R channel 0–255 →
  `h / 255 * TERRAIN_HEIGHT_SCALE` (125m) over `HM_WORLD_SCALE` (1500m).
- Both ends wrap infinitely: shader `uv = fract(worldXZ / hmWorldScale)`,
  CPU sampler does the same modulo (`heightmap.ts`). One tile = one arena;
  the world is the torus.
- **Bit-identical sampling is the hard constraint.** Server sims and client
  prediction replay against the same field — so terrain must be *baked*,
  not procedural at runtime. Generation is offline and free to be heavy.
- GPU reads texel centers, CPU sampler compensates by −0.5. Any generator
  must produce the field both paths see — which the PNG→bin pipeline does
  (`png2bin.js` decodes through the same canvas path as `loadHeightmap`).

A tileable PNG = seamless infinite terrain. Everything below is about
making that tile *good* and the repetition *invisible*.

## Pipeline today

```
terrain_gen/main.py  →  PNG (tileable perlin fbm/ridged)
_tools/mapbake/png2bin.js  →  maps/<name>.bin  (8B header + uint8 grid)
map JSON "terrain" field  →  server parses bin, client loadHeightfieldBin
_tools/mapbake/genfield.js — alternate: direct procedural → bin with
                             authored flats/craters at world coords
```

Authored features (base flats, craters) are layered *on* the noise —
bases need flat ground; raw noise never gives it. Keep this layer.

## Seamlessness — the three families

Seamless means the field is periodic. You can't have one without the
other; the lever is where the period lives and whether it shows.

### 1. Periodic lattice noise (current)

Perlin/simplex with gradient-lattice coordinates taken mod N. C1 seam —
heights AND slopes match, which matters: a height seam is visible, a
slope seam breaks skiing (normal discontinuity = launch/bog at the wrap).

- Constraint: every octave's period must divide the tile →
  `size % (res · lacunarity^(octaves−1)) == 0`. Miss it and detail
  octaves re-introduce the seam at fine scale.
- perlin-numpy `tileable=(True,True)` is this. Cheap, correct, and
  **exactly periodic** — the same basin cluster every 1500m.

### 2. Toroidal 4D embedding (recommended upgrade)

Map tile UV → two circles in 4D, sample 4D noise:

```
nx = cos(2πu)·r   ny = sin(2πu)·r
nz = cos(2πv)·r   nw = sin(2πv)·r
```

`cos(0)=cos(2π)` ⇒ opposite edges are literally the same samples — C∞,
no lattice divisibility rules, works with **any** noise: open-simplex2
(no axis-aligned artifacts classic Perlin carries), Worley, domain-warped
compositions. `r` = torus radius in noise space = cells around the loop;
higher r = more detail per tile but the sample path curves through 4D
which subtly warps feature shape.

Cost: ~2× 2D noise. Irrelevant — this runs offline.

This frees us from perlin-numpy's integer-lattice bookkeeping entirely
and is the standard modern answer (Godot's `Noise4DTexture2D.seamless`,
`tiling-noise`, JTippetts' method).

### 3. Non-periodic tiling — the actual fix for repetition

Periodic methods all repeat; Wang-style tiling is how you stop *seeing* it:

- Generate a small set of **edge-compatible variants** (all tiles share a
  compatible edge profile set — like Wang tiles' colored edges). Hash the
  integer tile index → pick a variant at sample time.
- Result: seamless AND aperiodic. The 3×3 test that currently shows the
  same tri-lobed basin nine times instead shows nine arrangements.
- Runtime cost ≈ zero (one hash + texture select). This is the single
  biggest visual upgrade available — repetition, not noise quality, is
  what makes infinite terrain read as fake.
- Cheaper version: keep ONE heightfield tile but vary **detail** per
  tile — hash-select a detail texture/octave set per tile while the base
  shape stays shared. Breaks the eye without breaking the contract.

## Shaping — where noise becomes terrain

Raw fbm reads as noise, not geology. The layers that sell it:

- **Domain warp** `h(p) = noise(p + k·noise(p))` — bends the lattice so
  ridges curve organically. Highest quality-per-line-of-code upgrade.
  Apply warp inside the periodic domain (warp a tileable field by a
  tileable field and it stays tileable).
- **Ridged transform** `(1−|n|)²` per octave — sharp ridge networks.
  Already in main.py; combine with warp for real mountains.
- **Terraces/plateau quantization** — `plateau` op exists; useful near
  bases, elsewhere reads artificial.
- **Feature masks** — low-frequency control field modulates octave
  amplitude: mountain belts vs plains in ONE tile, instead of uniform
  density everywhere. Uniform noise density is the #1 "this is
  procedural" tell after repetition.
- **Radial falloff** — island/crater shaping, but **breaks tiling**
  (any op that treats the tile as finite does). Terrain_gen marks the
  islands preset NOT tileable for exactly this reason — keep that
  discipline: shaping ops must be periodic or they trade the seam away.

## Erosion — the history layer

The deepest realism lever. Real terrain carries process history; noise
doesn't. Three models, ranked cheap→heavy:

- **Thermal / talus** — move material only where slope exceeds the talus
  angle, deposit downhill. Produces scree + cliff faces. Current
  `apply_erosion` is slope-proportional blur (smooths, doesn't erode) —
  upgrading to talus-threshold is ~20 lines and materially better.
- **Particle (raindrop) hydraulic** — Beyer algorithm: drop ~50–100k
  particles, each flows downhill via the height gradient, erodes
  proportional to speed·water, deposits on slowdown. Produces dendritic
  drainage networks — the strongest "real terrain" signal per dollar.
  Reference impls: erodr, soillib/soilwebgpu (GPU, seconds for 1024²),
  Unity compute ports. Doable in numpy but a compiled/GPU port is ~100×.
- **Shallow water / virtual pipes** — grid fluid sim; rivers, lakes,
  actual water tables. Heaviest; only if we ever want real rivers.
- **Multiscale schedule** — erode coarse → upsample → erode again.
  Cheaper AND more realistic than hammering full res (big valleys carve
  first, detail passes stay local). `soilwebgpu` runs this way.

Erosion runs AFTER noise stacking, BEFORE normalize → PNG. It must use
periodic boundary conditions (np.roll neighborhoods, not np.gradient) or
it cuts new seams — terrain_gen already does this.

## Playability constraints (Tribes-specific)

Terrain is the engine — skiing converts height directly to speed, so the
field's *statistics* are gameplay parameters:

- **Slope distribution** sets the speed economy. Too gentle = no speed;
  too steep/dense = no lanes. Target connected networks of moderate
  downhills (15–35°) feeding flats you jet out of.
- **Ridgelines as ski lanes** — ridged noise gives natural "spines" to
  ski down; basins funnel you back uphill. Mountains preset is the right
  family; tune `res` for feature spacing (res 2 = dense peaks ~750m
  apart; res 4 = 375m).
- **Flight ceiling** — 125m max height; peaks that saturate the range
  for large areas become invisible walls. Normalize to ~80% of range,
  keep headroom.
- **Base flats** are authored (`genfield.js --flats`), not found. If
  generated terrain ships to a real map, the flat/carve pass is
  mandatory — flag stands need known-level ground.
- **Unskiable traps** — verify no bowl deeper than jet energy can escape
  (energy budget vs max local depth). A basin you can't jet out of is a
  kill zone, not terrain.

## Determinism / hygiene

- Seed everything (np.random.seed per octave with `seed + octave·prime`
  is fine); the PNG is the only artifact that must be reproducible.
- Quantization: 8-bit field = 0.49m steps. Bilinear hides it; don't
  generate features finer than ~1 texel (≈1.5m at 1024²) — they alias.
- `verify` edge-diff test is the acceptance gate; run it on every
  generated map. Edge diff should be ≈ interior step distribution.
- Constants are duplicated (CLIENT_HEIGHT_SCALE etc.) — a drift between
  main.py and config.ts silently desyncs scale. Import once or add a
  codegen comment on both sides.

## Recommended stack

1. Toroidal 4D open-simplex2 for base field (drops lattice constraints,
   kills axis artifacts).
2. Periodic domain warp, masked octave modulation (belts/plains variety).
3. Ridged octave blend for ski-spine terrain character.
4. Talus thermal pass + particle hydraulic pass (offline, both periodic).
5. Authored flats/craters layer (bases) — already proven in genfield.js.
6. Wang-variant tiles OR detail-per-tile hashing to break repetition.
7. `verify` + 3×3 render as the acceptance ritual.

## References

- McEwan et al., *Tiling Simplex Noise and Flow Noise* (JCGT 2022) —
  tiling simplex with analytic gradients; the gradient output feeds
  slope-driven erosion/splatting for free.
- ACM PACMCGIT 2018, *Non-periodic Tiling of Procedural Noise* — Wang
  tiles applied directly to noise textures.
- JTippetts' torus method — the 4D embedding formula everyone ships.
- Nicholas McDonald's soillib → `soilwebgpu` — best end-to-end reference
  for particle erosion at usable speed, incl. multiscale scheduling.
- Hans Beyer, *Implementation of a method for hydraulic erosion* — the
  raindrop model spec.
- Repo: `terrain_gen/main.py`, `_tools/mapbake/{genfield,png2bin}.js`,
  `client/src/world/{heightmap,terrainShaders}.ts`,
  `_docs/2026-06-11_TERRAIN.md`.
